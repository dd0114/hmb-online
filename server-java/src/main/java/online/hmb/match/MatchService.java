package online.hmb.match;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.engine.LiveEngineConfigService;
import online.hmb.league.LeagueService;
import online.hmb.meta.DeckService;
import online.hmb.meta.DeckSnapshot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 매치플로우 상태머신 (LLD §5). 전이는 전부 CAS(`UPDATE ... WHERE state=?`) — 동시 요청 안전.
 * 상태·허용 액션 = §5.1 전이표 그대로: 그 외 조합은 409 INVALID_STATE (AC-M1).
 *
 * 덱 스냅샷(user_deck_json): {formation, starters:[{playerId,slotIndex,promptText?}]×11,
 * bench:[{playerId,slotIndex,promptText?}]} — 매치 시작 후 덱을 바꿔도 진행 중 매치는 불변.
 */
@Service
public class MatchService {

    private static final Logger log = LoggerFactory.getLogger(MatchService.class);

    public static final String S_BRIEFING = "BRIEFING";
    public static final String S_GEN1 = "GEN1";
    /** 전반 라이브 재생 창 (P4-E2 #170). */
    public static final String S_FIRST_HALF = "FIRST_HALF";
    /** 감독시간 — 구 H1_BREAK 의 자리(데드라인 = hmb.match.clock.halftime-ms). */
    public static final String S_HALFTIME = "HALFTIME";
    /** 후반 라이브 재생 창. 이 창이 끝나야 FINISHED·정산이다. */
    public static final String S_SECOND_HALF = "SECOND_HALF";
    public static final String S_GEN2 = "GEN2";
    public static final String S_FINISHED = "FINISHED";
    public static final String S_FAILED = "FAILED";
    /**
     * 회수된 매치(#217, Flyway V19). 유저의 명시적 포기 또는 방치 스윕으로만 들어오는 <b>터미널</b>
     * 상태다 — 잠금(진행 중 매치 1개 제한)을 켠 이상 고아 매치를 끝낼 수단이 없으면 계정이 영구히
     * 잠기기 때문이다(AC3). 전이가 전부 CAS(`WHERE state = ?`)라 이 상태가 되는 순간 kickoff·resume·
     * retry·prompts·halftime 이 <b>자동으로</b> 거부된다(추가 가드 0).
     */
    public static final String S_ABANDONED = "ABANDONED";
    /**
     * 레거시 전용(P4 이전 배포본). V8 마이그레이션이 HALFTIME 으로 옮기지만, 감사·부분롤백 대비로
     * CHECK 에 남겨두고 읽기 경로에서만 HALFTIME 과 동등 취급한다(쓰기 경로 없음).
     */
    public static final String S_H1_BREAK = "H1_BREAK";

    /** 감독시간에 해당하는 상태들(신규 + 레거시). */
    private static final Set<String> HALFTIME_STATES = Set.of(S_HALFTIME, S_H1_BREAK);
    /**
     * 후반 지시·교체를 미리 넣어둘 수 있는 상태 — 전반을 보면서 준비한다(#169 S1 "후반 지시" 패널).
     * h2 선행/재해소 창과 같은 집합이다(#193 W2b-B2, {@code MatchOrchestrator.resolveSecondHalfInputs}).
     */
    public static final Set<String> PRE_SECOND_HALF_STATES = Set.of(S_FIRST_HALF, S_HALFTIME, S_H1_BREAK);

    /**
     * 끝나지 않은 내 매치 = <b>"새 매치를 만들 수 없다"</b>의 정의(#217 AC2). FAILED 를 포함하는 이유:
     * 재시도(`/retry`)로 살아날 수 있는 미완 매치이고, 여기서 안 잠그면 유저가 실패한 매치를 버리고
     * 새로 만들어 고아가 쌓인다. 대신 FAILED 는 포기 가능하다({@link MatchLockService#abandonable}).
     */
    public static final Set<String> ACTIVE_STATES = Set.of(
            S_BRIEFING, S_GEN1, S_FIRST_HALF, S_HALFTIME, S_H1_BREAK, S_GEN2, S_SECOND_HALF, S_FAILED);

    /**
     * <b>이미 킥오프한</b> 매치 = 강제 재입장(AC1) + 메타 쓰기 잠금(AC2)의 정의. ACTIVE − BRIEFING.
     *
     * <p>BRIEFING 을 뺀 것은 타협이 아니라 계약이다 — 브리핑 중 덱/전술 수정은
     * {@link #recaptureSnapshotAtKickoff}(AC-B2)가 <b>명시적으로 지원하는 기존 기능</b>이라,
     * 여기서 덱을 잠그면 기능 회귀다. 브리핑도 ACTIVE 이므로 새 매치는 여전히 못 만든다.
     */
    public static final Set<String> LOCKED_STATES = Set.of(
            S_GEN1, S_FIRST_HALF, S_HALFTIME, S_H1_BREAK, S_GEN2, S_SECOND_HALF, S_FAILED);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final DeckService deckService;
    private final BotService botService;
    private final ConditionService conditionService;
    private final ObjectMapper objectMapper;
    private final DeckSnapshot deckSnapshot;
    private final java.time.Clock clock;
    private final MatchClockService clockService;
    private final online.hmb.away.AwayViewAccess awayViewAccess;
    private final MatchAutoProperties autoProps;
    private final int halftimeSubsMax;
    private final int promptMaxChars;
    private final SecureRandom secureRandom = new SecureRandom();

    private final online.hmb.league.LeagueDailyRewardService dailyRewardService;
    /** #405 W2b — 결과 화면에 additive 로 실리는 보상 봉투(설계 §2.9). */
    private final online.hmb.rewards.RewardBundleService rewardBundleService;
    private final online.hmb.mission.MissionService missionService;
    private final LiveEngineConfigService liveEngineConfig;
    /** #431: 상대 선수의 ★·OVR — 공개 범위 안의 좁은 접근자만 쓴다(성장 상세 맵 아님). */
    private final online.hmb.growth.GrowthService growthService;
    /** #493 W6-v3 — 튜토리얼 고정 매치의 시드·상대봇 출처(구운 자산이 SoT). */
    private final online.hmb.tutorial.TutorialMatchAsset tutorialAsset;
    /** #493 W9 — "이 유저가 튜토리얼을 끝냈나" 질의의 단일 출처(파밍 차단과 완주 보상이 같은 사실을 본다). */
    private final online.hmb.tutorial.TutorialCompletionService tutorialCompletion;

    public MatchService(JdbcClient jdbcClient,
                        TxRunner txRunner,
                        DeckService deckService,
                        BotService botService,
                        ConditionService conditionService,
                        ObjectMapper objectMapper,
                        DeckSnapshot deckSnapshot,
                        java.time.Clock clock,
                        MatchClockService clockService,
                        online.hmb.growth.GrowthService growthService,
                        online.hmb.away.AwayViewAccess awayViewAccess,
                        online.hmb.league.LeagueDailyRewardService dailyRewardService,
                        online.hmb.rewards.RewardBundleService rewardBundleService,
                        online.hmb.mission.MissionService missionService,
                        MatchAutoProperties autoProps,
                        LiveEngineConfigService liveEngineConfig,
                        online.hmb.tutorial.TutorialMatchAsset tutorialAsset,
                        online.hmb.tutorial.TutorialCompletionService tutorialCompletion,
                        @Value("${hmb.match.halftime-subs-max}") int halftimeSubsMax,
                        @Value("${hmb.deck.player-prompt-max-chars}") int promptMaxChars) {
        this.tutorialAsset = tutorialAsset;
        this.tutorialCompletion = tutorialCompletion;
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.deckService = deckService;
        this.botService = botService;
        this.conditionService = conditionService;
        this.objectMapper = objectMapper;
        this.deckSnapshot = deckSnapshot;
        this.clock = clock;
        this.clockService = clockService;
        this.growthService = growthService;
        this.awayViewAccess = awayViewAccess;
        this.dailyRewardService = dailyRewardService;
        this.rewardBundleService = rewardBundleService;
        this.missionService = missionService;
        this.autoProps = autoProps;
        this.liveEngineConfig = liveEngineConfig;
        this.halftimeSubsMax = halftimeSubsMax;
        this.promptMaxChars = promptMaxChars;
    }

    // ── 행 모델 ─────────────────────────────────────────────────────────

    /** kickoffAt/phaseStartAt/phaseEndsAt = P4 시계 컬럼(#170). 시계 미적용 매치는 전부 null. */
    public record MatchRow(String id, String userId, String botId, String state, String failReason,
                           String seed, String engineVersion, String userDeckJson, String subsJson,
                           Integer scoreH1Home, Integer scoreH1Away, Integer scoreHome, Integer scoreAway,
                           String result, String createdAt, String finishedAt,
                           String conditionsJson, String mode, String leagueFixtureId,
                           String kickoffAt, String phaseStartAt, String phaseEndsAt,
                           Integer scoreH2Home, Integer scoreH2Away,
                           String h2TacticsJson, String h2ShapeJson, boolean auto,
                           /**
                            * 이 매치가 **시작할 때** 유효했던 계수 오버레이의 값 복사(#383). null = 없음.
                            * 진행 중에 라이브 값을 다시 조회하지 않는다 — 그게 #241 재발 방지의 전부다.
                            */
                           String configOverridesJson, String configRevisionId,
                           /**
                            * #493 W6-v3 — 이 매치가 <b>튜토리얼 고정 매치</b>인가. true 면 AI 잡·러너를
                            * 타지 않고 미리 구운 로그({@code TutorialMatchAsset})가 적재된다.
                            * {@code mode} 는 그대로 {@code practice} 다(V43 머리말 참조).
                            */
                           boolean tutorial) {
    }

    public MatchRow getOwned(String userId, String matchId) {
        MatchRow row = find(matchId)
                .orElseThrow(() -> ApiException.notFound("매치를 찾을 수 없습니다"));
        if (!row.userId().equals(userId)) {
            throw ApiException.notFound("매치를 찾을 수 없습니다"); // 소유권 비노출
        }
        return row;
    }

    /**
     * <b>읽기 전용</b> 접근 판정(#245 hero Q5) — 소유자거나, 그 매치에서 <b>원정을 당한 수비자</b>면
     * 볼 수 있다. 그 외에는 {@link #getOwned} 와 똑같이 404(소유권 비노출).
     *
     * <p>⚠️ 이 메서드는 <b>GET 경로에만</b> 쓴다. 킥오프·감독시간·포기·프롬프트 같은 쓰기는 계속
     * {@code getOwned} 다 — 관전 권한이 조작 권한으로 새면 남의 경기를 남이 끝낼 수 있다.
     * 수비자 권한의 근거인 {@code away_reports} 행은 <b>터미널 상태</b>에서만 생기므로(FINISHED 정산
     * 또는 D1 몰수의 ABANDONED), 수비자가 여는 매치는 언제나 이미 끝난 경기다. 근거를 "FINISHED"
     * 같은 좁은 사실에 매달지 마라 — 상태가 하나 늘면 조용히 거짓이 된다(독립검증 2R blocker).
     */
    public MatchRow getViewable(String userId, String matchId) {
        MatchRow row = find(matchId)
                .orElseThrow(() -> ApiException.notFound("매치를 찾을 수 없습니다"));
        if (!row.userId().equals(userId) && !awayViewAccess.canWatch(userId, matchId)) {
            throw ApiException.notFound("매치를 찾을 수 없습니다");
        }
        return row;
    }

    public Optional<MatchRow> find(String matchId) {
        return jdbcClient.sql("""
                        SELECT id, user_id, bot_id, state, fail_reason, seed, engine_version,
                               user_deck_json, subs_json, score_h1_home, score_h1_away,
                               score_home, score_away, result, created_at, finished_at,
                               conditions_json, mode, league_fixture_id,
                               kickoff_at, phase_start_at, phase_ends_at,
                               score_h2_home, score_h2_away, h2_tactics_json, h2_shape_json, auto_mode,
                               config_overrides_json, config_revision_id, is_tutorial
                        FROM matches WHERE id = ?
                        """)
                .param(matchId)
                .query((rs, n) -> new MatchRow(
                        rs.getString("id"), rs.getString("user_id"), rs.getString("bot_id"),
                        rs.getString("state"), rs.getString("fail_reason"), rs.getString("seed"),
                        rs.getString("engine_version"), rs.getString("user_deck_json"),
                        rs.getString("subs_json"),
                        (Integer) rs.getObject("score_h1_home"), (Integer) rs.getObject("score_h1_away"),
                        (Integer) rs.getObject("score_home"), (Integer) rs.getObject("score_away"),
                        rs.getString("result"), rs.getString("created_at"), rs.getString("finished_at"),
                        rs.getString("conditions_json"), rs.getString("mode"),
                        rs.getString("league_fixture_id"),
                        rs.getString("kickoff_at"), rs.getString("phase_start_at"),
                        rs.getString("phase_ends_at"),
                        (Integer) rs.getObject("score_h2_home"), (Integer) rs.getObject("score_h2_away"),
                        rs.getString("h2_tactics_json"), rs.getString("h2_shape_json"),
                        rs.getInt("auto_mode") == 1,
                        rs.getString("config_overrides_json"), rs.getString("config_revision_id"),
                        rs.getInt("is_tutorial") == 1))
                .optional();
    }

    /** 상태 전이 CAS. 성공 시 true. */
    public boolean casTransition(String matchId, String fromState, String toState) {
        return jdbcClient.sql("UPDATE matches SET state = ? WHERE id = ? AND state = ?")
                .params(toState, matchId, fromState)
                .update() == 1;
    }

    private static ApiException invalidState(String state, String action) {
        return new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                "현재 상태(" + state + ")에서 허용되지 않는 액션입니다: " + action,
                Map.of("state", state, "action", action));
    }

    // ── 생성 (BRIEFING 진입) ────────────────────────────────────────────

    public MatchRow createMatch(String userId, String botId) {
        return createMatch(userId, botId, null);
    }

    /**
     * teamTactics(P2-D4, 선택): 브리핑 최종 수동 전술 {line,press,tempo,width}(0..1). 있으면 매치
     * 스냅샷(user_deck_json)에 포함돼 AI 컨텍스트로 전달된다(LLD-p2-server §2·§4). 매치 시작 후
     * 덱/전술을 바꿔도 진행 중 매치는 이 스냅샷으로 격리된다.
     */
    public MatchRow createMatch(String userId, String botId, JsonNode teamTactics) {
        return createMatch(userId, botId, teamTactics, false);
    }

    /**
     * #493 W6-v3 — {@code tutorial=true} 면 <b>미리 구운 고정 매치</b>를 만든다.
     *
     * <p>바뀌는 것은 셋뿐이다: ①상대 = 자산이 지정한 시드봇(구운 로그의 away 로스터와 같아야 화면의
     * 상대 이름이 거짓말을 안 한다) ②{@code seed} = 구울 때 쓴 시드(재현 가능성 보존) ③{@code
     * is_tutorial=1}. <b>덱 검증·스냅샷·컨디션·계수 핀은 그대로 지나간다</b> — 튜토리얼도 유저의
     * 덱으로 만든 매치이고(정산·성장이 그 스냅샷을 읽는다), 다른 것은 <b>시뮬 입력</b>뿐이다.
     *
     * <p><b>1회 제한</b>: 이미 FINISHED 인 튜토리얼 매치가 있으면 409. 구운 로그는 언제나 크게 이기므로
     * 반복 생성이 열려 있으면 승리 보상이 무한 발행된다(V43 머리말). ABANDONED·FAILED 는 사고 회수
     * 경로라 재시도를 막지 않는다.
     */
    public MatchRow createMatch(String userId, String botId, JsonNode teamTactics, boolean tutorial) {
        // 활성 덱 재검증 (AC-S2 규칙 재사용, LLD §5.1). 덱 부재는 전용 코드 DECK_REQUIRED(#319) —
        // 매치 생성 3경로가 같은 게이트를 지나야 클라가 문구로 404 를 구분하지 않는다.
        DeckService.DeckResponse deck = deckService.requireActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));
        online.hmb.meta.TeamTactics.validate(teamTactics); // 있으면 0..1 범위

        // 연습 상대는 **시드봇만**(#252). 랜덤 경로는 BotService.pickRandom 이 이미 걸러내지만, botId 를
        // 명시하면 리그 봇팀·원정 고스트를 지목할 수 있어 풀 필터가 우회된다. 리그/원정은 각각
        // createLeagueMatch·createAwayMatch 라 이 가드에 걸리지 않는다.
        if (tutorial) {
            requireTutorialAvailable(userId);
        }
        BotService.BotRow bot = tutorial
                ? botService.getSeed(tutorialAsset.awayBotId())
                : (botId == null ? botService.pickRandom() : botService.getSeed(botId));

        String matchId = Ulid.next();
        // 튜토리얼은 **구울 때 쓴 시드**를 그대로 박는다 — half_seed 파생이 자산과 일치해야
        // "이 로그는 이 시드로 재현된다"가 참이 된다(자산 머리말).
        String seed = tutorial ? tutorialAsset.matchSeed() : randomSeedHex();
        String snapshot = snapshotDeck(deck, teamTactics);
        Instant createdAt = Instant.now(clock);
        String now = createdAt.toString();
        // 컨디션 날짜는 **매치 생성 시각(KST)** 에 앵커 — 킥오프 재캡처가 자정을 넘겨도 같은 시드(아래 참조).
        String conditionsJson =
                computeConditionsJson(userId, conditionService.dateOf(createdAt), rosterPlayerIdsOf(readJson(snapshot)));
        // #383: **지금** 유효한 계수 오버레이를 매치에 값으로 복사한다. 이후 오버레이가 바뀌어도 이
        // 매치는 자기 컬럼만 읽으므로 영향이 없다(user_deck_json 과 같은 관용구 — 진행 중 매치 보호).
        LiveEngineConfigService.Pin configPin = liveEngineConfig.pinForNewMatch();

        txRunner.run(() -> jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, conditions_json, mode, created_at,
                                            config_overrides_json, config_revision_id, is_tutorial)
                        VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'practice', ?, ?, ?, ?)
                        """)
                .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, now,
                        configPin.overridesJson(), configPin.revisionId(), tutorial ? 1 : 0)
                .update());
        // engine_version='pending' — 실제 EngineConfig.version은 h1 시뮬 응답의
        // matchLog.configVersion으로 갱신된다(러너가 버전의 SoT).

        return getOwned(userId, matchId);
    }

    /**
     * 튜토리얼 고정 매치를 만들 수 있는 상태인가 (#493 W6-v3).
     *
     * <p>두 가지를 본다: ①자산이 실려 있나(없으면 이 기능 자체가 없는 배포다 — 400 으로 끊고 화면이
     * 일반 연습으로 폴백하게 한다) ②이미 <b>끝낸</b> 튜토리얼 매치가 있나(파밍 차단, V43 머리말).
     */
    private void requireTutorialAvailable(String userId) {
        if (!tutorialAsset.available()) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "TUTORIAL_UNAVAILABLE",
                    "튜토리얼 경기를 사용할 수 없습니다");
        }
        // #493 W9: 질의를 여기서 다시 쓰지 않는다 — 완주 보상 판정과 **같은 사실**을 봐야 한다.
        // 갈라지면 "409 는 이미 했다는데 보상은 안 나온다"가 되고 그건 복구 경로가 없다.
        int finished = tutorialCompletion.finishedTutorialMatches(userId);
        if (finished > 0) {
            throw new ApiException(HttpStatus.CONFLICT, "TUTORIAL_ALREADY_PLAYED",
                    "튜토리얼 경기는 한 번만 진행할 수 있습니다", Map.of("played", finished));
        }
    }

    /**
     * 리그 매치 생성(AC-F2): mode='league' + league_fixture_id 연결. 상대 봇(botTeamId)은 리그 시즌이
     * bots 테이블에 삽입한 봇팀 로스터/성향. 홈/어웨이는 픽스처가 결정하며 오케스트레이터가 반영한다
     * (매치 스냅샷·컨디션·플로우는 연습 매치와 동일 — 여기선 mode/fixture 만 다르다).
     */
    public MatchRow createLeagueMatch(String userId, String botTeamId, String leagueFixtureId) {
        DeckService.DeckResponse deck = deckService.requireActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));

        BotService.BotRow bot = botService.get(botTeamId);
        String matchId = Ulid.next();
        String seed = randomSeedHex();
        String snapshot = snapshotDeck(deck, null);
        Instant createdAt = Instant.now(clock);
        String now = createdAt.toString();
        String conditionsJson =
                computeConditionsJson(userId, conditionService.dateOf(createdAt), rosterPlayerIdsOf(readJson(snapshot)));
        // #383: **지금** 유효한 계수 오버레이를 매치에 값으로 복사한다. 이후 오버레이가 바뀌어도 이
        // 매치는 자기 컬럼만 읽으므로 영향이 없다(user_deck_json 과 같은 관용구 — 진행 중 매치 보호).
        LiveEngineConfigService.Pin configPin = liveEngineConfig.pinForNewMatch();

        txRunner.run(() -> jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, conditions_json, mode, league_fixture_id, created_at,
                                            config_overrides_json, config_revision_id)
                        VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'league', ?, ?, ?, ?)
                        """)
                .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, leagueFixtureId, now,
                        configPin.overridesJson(), configPin.revisionId())
                .update());

        return getOwned(userId, matchId);
    }

    /**
     * 원정 매치 생성(#245): {@code mode='away'} + 도전장({@code away_challenges}) 기록.
     *
     * <p>상대 봇({@code ghostBotId})은 <b>수비자의 덱 스냅샷을 구운 bots 행</b>이다 — 리그 봇팀과
     * 같은 자리라 매치·AI·시뮬 경로는 연습 매치와 완전히 동일하다(AwayService 참조).
     *
     * <p>⚠️ 매치 INSERT 와 도전장 INSERT 는 <b>한 트랜잭션</b>이다. 갈라두면 도전장만 실패했을 때
     * "원정 매치인데 수비자가 없는" 행이 남고, 정산이 조용히 건너뛰어 <b>피원정 당한 쪽은 영영
     * 모른다</b>(리포트도 레이팅도 없이). 관측되지 않는 사고는 고쳐지지 않는다.
     */
    public MatchRow createAwayMatch(String userId, String ghostBotId, String defenderId) {
        return createAwayMatch(userId, ghostBotId, defenderId, null);
    }

    /**
     * @param revengeReportId 이 매치가 <b>어느 피침공 기록의 복수인가</b>(#319, 일반 원정이면 null).
     *     도전장에 같이 박는 이유는 소모 판정이 <b>정산 시점</b>이기 때문이다(승=완료 / 패=시도+1 /
     *     무=횟수 안 씀 — hero 확정). 매치 INSERT 와 같은 문장에 실어 <b>구조적으로</b> 원자적이게 한다 —
     *     나중에 UPDATE 로 붙이면 그 사이에 프로세스가 죽었을 때 "복수인데 복수가 아닌" 매치가 남고,
     *     유저는 시도만 잃는다.
     */
    public MatchRow createAwayMatch(String userId, String ghostBotId, String defenderId,
                                    String revengeReportId) {
        DeckService.DeckResponse deck = deckService.requireActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));

        BotService.BotRow bot = botService.get(ghostBotId);
        String matchId = Ulid.next();
        String seed = randomSeedHex();
        String snapshot = snapshotDeck(deck, null);
        Instant createdAt = Instant.now(clock);
        String now = createdAt.toString();
        String conditionsJson =
                computeConditionsJson(userId, conditionService.dateOf(createdAt), rosterPlayerIdsOf(readJson(snapshot)));
        // #383: **지금** 유효한 계수 오버레이를 매치에 값으로 복사한다. 이후 오버레이가 바뀌어도 이
        // 매치는 자기 컬럼만 읽으므로 영향이 없다(user_deck_json 과 같은 관용구 — 진행 중 매치 보호).
        LiveEngineConfigService.Pin configPin = liveEngineConfig.pinForNewMatch();

        txRunner.run(() -> {
            jdbcClient.sql("""
                            INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                                user_deck_json, conditions_json, mode, created_at,
                                                config_overrides_json, config_revision_id)
                            VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'away', ?, ?, ?)
                            """)
                    .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, now,
                            configPin.overridesJson(), configPin.revisionId())
                    .update();
            jdbcClient.sql("""
                            INSERT INTO away_challenges(match_id, defender_id, ghost_bot_id,
                                                        created_at, revenge_report_id)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(matchId, defenderId, bot.id(), now, revengeReportId)
                    .update();
        });

        return getOwned(userId, matchId);
    }

    /** 매치 시드 — 감사·halfSeed 파생용 랜덤 hex(SecureRandom). 결정론은 halfSeed 파생부터 시작. */
    private String randomSeedHex() {
        byte[] bytes = new byte[16];
        secureRandom.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    /**
     * 매치 스냅샷 직렬화 — 구현은 {@link online.hmb.meta.DeckSnapshot} 한 곳이 소유한다.
     * 덱 저장 선실행(#215 W2)이 같은 바이트를 만들어야 A 캐시 키가 맞기 때문(그 클래스 주석 참조).
     */
    private String snapshotDeck(DeckService.DeckResponse deck, JsonNode teamTactics) {
        return deckSnapshot.json(deck, teamTactics);
    }

    // ── 컨디션 (AC-C1, LLD §3) ──────────────────────────────────────────

    /** 스냅샷의 선발+벤치 playerId 집합(컨디션 롤 대상 = 후반 교체 투입 포함). */
    private List<String> rosterPlayerIdsOf(JsonNode snapshot) {
        List<String> ids = new ArrayList<>();
        snapshot.path("starters").forEach(s -> ids.add(s.path("playerId").asText()));
        snapshot.path("bench").forEach(s -> ids.add(s.path("playerId").asText()));
        return ids;
    }

    /**
     * 매치의 컨디션 앵커 날짜 — <b>matches.created_at(KST)</b>. 새 컬럼 없이 기존 값으로 파생하므로
     * 마이그레이션이 필요 없고, 이 변경 이전에 만들어진 매치도 자연스럽게 정합된다(created_at 은
     * 매치 수명 동안 불변). 파싱 불가한 이례 값이면 오늘로 폴백(재캡처가 실패하지 않게).
     */
    private String conditionDateOf(MatchRow row) {
        try {
            return conditionService.dateOf(Instant.parse(row.createdAt()));
        } catch (RuntimeException e) {
            // 폴백이 발동하면 컨디션 앵커가 무력화된다(create↔kickoff 재캡처가 다른 날짜 시드를
            // 쓸 수 있음). 현재 created_at 은 항상 Instant.now().toString() 이라 도달 불가하지만,
            // 포맷이 바뀌면 조용히 느슨해지므로 반드시 신호를 남긴다.
            log.warn("condition date anchor fallback: unparsable matches.created_at={} (matchId={}) — "
                    + "falling back to today; create/kickoff conditions may diverge", row.createdAt(), row.id(), e);
            return conditionService.todayDate();
        }
    }

    /**
     * conditions_json = {playerId: 0.0~1.0} 결정론 롤(playerId 정렬 — 재현·안정 직렬화).
     *
     * <p>롤 입력은 매치 시드가 아니라 <b>userId + 날짜(KST)</b> 다(#98 계약 A) — 같은 날은 매치와
     * 무관하게 값이 고정되고(덱/리스트 상시 표시), 매치는 그 값을 <b>그대로 스냅샷</b>한다. 저장
     * 컬럼·소비 경로(SelectData 배율·AI 컨텍스트)는 불변이므로 엔진 재현 계약은 영향받지 않는다.
     *
     * <p><b>날짜 앵커(중요)</b>: 매치 경로의 date 는 '오늘'이 아니라 <b>매치 생성 시각(created_at, KST)</b>
     * 이다. 브리핑 중 자정을 넘겨 킥오프해도 재캡처가 create 시점과 같은 시드를 쓰므로, 유저가 브리핑에서
     * 본 컨디션(= AI 컨텍스트에 들어간 값)과 실제 경기 값이 어긋나지 않는다. 반면 덱 리스트용
     * {@code GET /api/conditions/today} 는 계속 '오늘'이다(앵커는 매치 경로에만 적용).
     */
    private String computeConditionsJson(String userId, String date, List<String> playerIds) {
        ObjectNode node = objectMapper.createObjectNode();
        new java.util.TreeSet<>(playerIds)
                .forEach(pid -> node.put(pid, conditionService.rollDaily(userId, date, pid)));
        return node.toString();
    }

    /**
     * 킥오프 시 스냅샷 재캡처(W0 이월 a, AC-B2): 브리핑 중 덱/전술 수정을 매치 스냅샷에 반영한다.
     * create 시점 캡처는 폴백이고, kickoff 직전의 현재 활성 덱 + 요청 teamTactics(없으면 기존
     * 스냅샷 teamTactics 유지)로 user_deck_json 을 재구성하고 conditions 를 새 로스터로 재롤한다.
     * BRIEFING 상태에서만 수행(그 외엔 no-op — 진행 중 매치 스냅샷 불변 계약 유지).
     */
    public void recaptureSnapshotAtKickoff(String userId, String matchId, JsonNode teamTactics) {
        MatchRow row = getOwned(userId, matchId);
        if (!row.state().equals(S_BRIEFING)) {
            return; // 킥오프 재캡처는 브리핑에서만 — 이미 진행 중이면 create/기존 스냅샷 유지
        }
        DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));

        JsonNode effectiveTactics;
        if (teamTactics != null && !teamTactics.isNull()) {
            online.hmb.meta.TeamTactics.validate(teamTactics); // 있으면 0..1
            effectiveTactics = teamTactics;
        } else {
            // 폴백: 기존 스냅샷(create/직전 브리핑)의 teamTactics 유지
            JsonNode existing = readJson(row.userDeckJson()).get("teamTactics");
            effectiveTactics = (existing != null && existing.isObject()) ? existing : null;
        }

        String snapshot = snapshotDeck(deck, effectiveTactics);
        String conditionsJson = computeConditionsJson(userId, conditionDateOf(row), rosterPlayerIdsOf(readJson(snapshot)));
        txRunner.run(() -> jdbcClient.sql("""
                        UPDATE matches SET user_deck_json = ?, conditions_json = ?
                        WHERE id = ? AND state = 'BRIEFING'
                        """)
                .params(snapshot, conditionsJson, matchId)
                .update());
    }

    /**
     * 그 half 의 AI 컨텍스트가 봐야 할 <b>실효 스냅샷</b>(#254).
     *
     * <p>half 1 = 저장된 매치 스냅샷 그대로. half 2 = 그 위에 감독시간 전술({@code h2_tactics_json})을
     * 얹은 <b>복사본</b>이다 — 원본(전반 기록)은 건드리지 않는다. 로스터·포메이션·프롬프트는 그대로라
     * 이 함수를 거쳐도 프롬프트 델타·로스터 계산은 전부 종전과 같은 값을 본다.
     *
     * <p>감독시간에 전술을 손대지 않았으면 전반 전술이 그대로 실효값이다(기존 동작 불변).
     */
    public JsonNode snapshotForHalf(MatchRow row, int half) {
        return snapshotForHalf(row, half, List.of());
    }

    /**
     * @param subs 후반 교체(#66). 배치 병합이 <b>투입 선수 기준</b>으로 슬롯을 조회하는 데 쓴다 —
     *     {@link PromptContextBuilder#buildRoster} 는 스냅샷 starters 를 돌며 out→in 만 치환하고
     *     slotIndex 는 <b>그 자리 것</b>을 쓰므로, 배치를 실효 선수 기준으로 되써야 "교체로 들어온
     *     선수를 지정한 슬롯에 세운다"가 성립하고 교체와 배치가 서로를 덮지 않는다.
     */
    public JsonNode snapshotForHalf(MatchRow row, int half, List<Substitution> subs) {
        JsonNode snapshot = readJson(row.userDeckJson());
        if (half != 2 || !snapshot.isObject()) {
            return snapshot;
        }
        ObjectNode merged = null;

        // ① 감독시간 전술(#254)
        if (row.h2TacticsJson() != null && !row.h2TacticsJson().isBlank()) {
            JsonNode tactics = readJson(row.h2TacticsJson());
            if (tactics.isObject()) {
                merged = ((ObjectNode) snapshot).deepCopy();
                merged.set("teamTactics", tactics.deepCopy());
            }
        }

        // ② 감독시간 배치(#276) — 같은 복사본에 얹는다(두 병합은 서로 독립).
        if (row.h2ShapeJson() != null && !row.h2ShapeJson().isBlank()) {
            JsonNode shape = readJson(row.h2ShapeJson());
            if (shape.isObject() && shape.path("starters").isArray()) {
                if (merged == null) {
                    merged = ((ObjectNode) snapshot).deepCopy();
                }
                String formation = shape.path("formation").asText("");
                if (!formation.isBlank()) {
                    merged.put("formation", formation);
                }
                Map<String, Integer> slotByPlayer = new LinkedHashMap<>();
                for (JsonNode s : shape.path("starters")) {
                    slotByPlayer.put(s.path("playerId").asText(), s.path("slotIndex").asInt());
                }
                Map<String, String> outToIn = outToIn(subs);
                for (JsonNode s : merged.path("starters")) {
                    if (!(s instanceof ObjectNode starter)) {
                        continue;
                    }
                    String playerId = starter.path("playerId").asText();
                    String effective = outToIn.getOrDefault(playerId, playerId);
                    Integer slot = slotByPlayer.get(effective);
                    if (slot != null) {
                        starter.put("slotIndex", slot);
                    }
                }
            }
        }
        return merged == null ? snapshot : merged;
    }

    private static Map<String, String> outToIn(List<Substitution> subs) {
        Map<String, String> map = new LinkedHashMap<>();
        for (Substitution sub : subs == null ? List.<Substitution>of() : subs) {
            map.put(sub.out(), sub.in());
        }
        return map;
    }

    /**
     * 후반 실효 <b>배치</b>가 전반과 다른가(#276). 다르면 후반 인풋을 <b>풀 생성</b>으로 다시 만들어야
     * 한다 — 배치는 패치로 표현할 수 없기 때문이다(tactical-patch.ts: "formation 은 A 소유라 패치 불가").
     *
     * <p>비교 대상 = 포메이션 문자열 + <b>실효 선수 → slotIndex</b> 매핑. 교체가 있으면 전반 쪽도
     * 교체를 반영한 뒤(out 의 슬롯을 in 이 승계) 비교한다 — 그래야 "교체만 했고 배치는 그대로"가
     * 배치 변경으로 오인돼 콜이 늘지 않는다.
     */
    public boolean secondHalfShapeChanged(MatchRow row, List<Substitution> subs) {
        if (row.h2ShapeJson() == null || row.h2ShapeJson().isBlank()) {
            return false;
        }
        JsonNode shape = readJson(row.h2ShapeJson());
        if (!shape.isObject() || !shape.path("starters").isArray()) {
            return false;
        }
        JsonNode snapshot = readJson(row.userDeckJson());
        if (!snapshot.path("formation").asText("").equals(shape.path("formation").asText(""))) {
            return true;
        }
        Map<String, String> outToIn = outToIn(subs);
        Map<String, Integer> h1 = new LinkedHashMap<>();
        for (JsonNode s : snapshot.path("starters")) {
            String playerId = s.path("playerId").asText();
            h1.put(outToIn.getOrDefault(playerId, playerId), s.path("slotIndex").asInt());
        }
        Map<String, Integer> h2 = new LinkedHashMap<>();
        for (JsonNode s : shape.path("starters")) {
            h2.put(s.path("playerId").asText(), s.path("slotIndex").asInt());
        }
        return !h1.equals(h2);
    }

    /** 후반 실효 전술이 전반과 <b>다른가</b>(#254). 다르면 후반 인풋을 다시 만들어야 한다. */
    public boolean secondHalfTacticsChanged(MatchRow row) {
        if (row.h2TacticsJson() == null || row.h2TacticsJson().isBlank()) {
            return false;
        }
        JsonNode h2 = readJson(row.h2TacticsJson());
        if (!h2.isObject()) {
            return false;
        }
        JsonNode h1 = readJson(row.userDeckJson()).get("teamTactics");
        // 스냅샷에 전술이 없던 매치(= 미지정)와 전 축 중앙(= 슬라이더 안 건드림)은 같은 뜻이다
        // (TeamTactics.isNeutral 주석) — 그 둘 사이의 이동은 "변경"이 아니다.
        boolean h1Unset = h1 == null || !h1.isObject() || online.hmb.meta.TeamTactics.isNeutral(h1);
        boolean h2Unset = online.hmb.meta.TeamTactics.isNeutral(h2);
        if (h1Unset && h2Unset) {
            return false;
        }
        return h1Unset || !h1.equals(h2);
    }

    /** conditions_json → {playerId: condition}. 없으면 빈 맵. */
    public Map<String, Double> conditionsOf(MatchRow row) {
        Map<String, Double> map = new LinkedHashMap<>();
        if (row.conditionsJson() == null || row.conditionsJson().isBlank()) {
            return map;
        }
        JsonNode node = readJson(row.conditionsJson());
        node.properties().forEach(e -> map.put(e.getKey(), e.getValue().asDouble()));
        return map;
    }

    // ── 조회 (MatchDetail / 상대 분석) ──────────────────────────────────

    /**
     * 상대 선수 1인 — <b>hero 결정 ③ 공개 범위</b>(이름·포지션·등급·★·OVR·능력치 + "지시 있음" 여부).
     *
     * <p>{@code playerId}·{@code star}·{@code ovr}·{@code attributes} 는 #431/#403 W3 additive 다:
     * 기존 4필드만 있을 때 화면은 선수와 카드를 <b>이을 수 없어</b>("있는지 없는지조차 우리가 모른다")
     * OVR·★ 자리를 비우고 지시 문구도 낮춰 달았다. 기존 필드는 그대로 두므로 구 클라는 무해하다.
     *
     * <p>⚠️ {@code hasPrompt} 는 <b>여부</b>다. 지시문 원문은 이 경로로 절대 나가지 않는다 — 원정
     * 고스트의 덱은 실유저의 덱(선수별 지시 포함)을 구운 것이라 여기가 실제 누설 경로다.
     * {@code star} 는 카드가 없는 로스터(시드봇·리그봇)에서 <b>0</b> 이다.
     */
    public record OpponentPlayer(String playerId, String name, String position, String grade,
                                 int star, double ovr, Map<String, Object> attributes,
                                 boolean hasPrompt) {
    }

    public record Opponent(String name, String analysisText, List<OpponentPlayer> deck) {
    }

    /**
     * {@code ownerName}(#245 additive) = 이 매치를 만든 유저의 닉네임.
     *
     * <p>⚠️ <b>"(홈)"이라고 적지 마라 — 이 문장이 실제로 버그를 만들었다</b>(#322). 원래 여기엔
     * <i>"매치를 만든 유저(홈)의 닉네임"</i> 이라고 적혀 있었고, web 이 그 말을 계약으로 믿어
     * {@code homeName = ownerName} 을 박았다. 그런데 <b>리그 어웨이 라운드는 소유자가 away 사이드다</b>
     * ({@link MatchOrchestrator#userIsHome} — 픽스처 {@code home_team} 이 계약, 2026-07-19 #94).
     * 그 결과 어웨이 라운드 화면에서 스코어·로그 팀 라벨·좌우가 통째로 뒤집혔다(라이브 리그
     * 20경기 중 7건, 유저 3/3).
     *
     * <p>사이드가 필요하면 {@code homeName}/{@code awayName} 을 써라 — <b>사이드 라벨 그대로</b>다.
     * {@code ownerName} 은 "누구 매치냐"만 말한다(#245 관전 경로가 그걸 쓴다).
     */
    public record MatchDetail(String id, String state, String failReason, Opponent opponent,
                               Integer scoreH1Home, Integer scoreH1Away,
                               Integer scoreHome, Integer scoreAway,
                               String result, String createdAt, String finishedAt,
                               Map<String, Double> conditions, String mode, String leagueFixtureId,
                               JsonNode userDeckSnapshot, MatchClockService.MatchClock clock,
                               String ownerName, String homeName, String awayName, boolean auto,
                               /**
                                * #493 W6-v3 additive — 튜토리얼 고정 매치인가. web 의 온레일 가이드
                                * (탭 투어·스킵 잠금)가 이 값으로 켜진다. 기존 필드 불변.
                                */
                               boolean tutorial) {
    }

    /**
     * 이 매치에서 유저가 홈 사이드인가 (#322).
     *
     * <p>규칙은 {@link MatchOrchestrator#userIsHome} 과 같다 — <b>엔진 home = 픽스처 home_team</b>.
     * 연습·원정은 리그 픽스처가 없어 항상 홈이고, 리그는 픽스처가 정한다. 여기서 LeagueService 를
     * 주입받지 않고 직접 조회하는 이유는 {@code LogsService} 가 같은 판정을 이미 그렇게 하기 때문 —
     * 한 줄짜리 조회에 모듈 의존을 하나 더 만들면 순환이 생긴다.
     */
    private boolean userIsHome(MatchRow row) {
        // ⚠️ 조건을 {@code MatchOrchestrator.userIsHome} 과 **글자 그대로** 맞춘다(독립검증 minor-3).
        //    거기는 mode 도 본다 — 지금은 리그가 아니면 픽스처도 없어서 결과가 같지만, 두 판정이
        //    갈리면 화면과 엔진이 조용히 어긋난다(이 이슈가 정확히 그 형태였다).
        if (!"league".equals(row.mode()) || row.leagueFixtureId() == null) {
            return true;
        }
        // 팀 id 리터럴을 다시 적지 않는다 — SoT 는 LeagueService 의 상수다.
        return jdbcClient.sql("SELECT home_team FROM league_fixtures WHERE id = ?")
                .param(row.leagueFixtureId())
                .query(String.class)
                .optional()
                .map(LeagueService.USER_TEAM_ID::equals)
                // 픽스처가 없으면 홈으로 본다(조회용 응답이 500 이 되는 것보다 낫다). 라이브 실측
                // orphan 0건 — 여기 걸리면 데이터 문제이지 표시 문제가 아니다.
                .orElse(true);
    }

    /**
     * <b>관전자용</b> MatchDetail — 소유자가 아니면 {@code userDeckSnapshot} 을 뗀다(#245 BL-1).
     *
     * <p>왜 필요한가: {@link #getViewable} 이 원정 수비자에게 GET 을 열었는데, 그 스냅샷에는
     * <b>공격자의 선수별 promptText 전량 + teamTactics + teamPrompt</b> 가 들어 있다. 반대 방향은
     * {@link #buildOpponent} 가 {@code hasPrompt} 불리언으로만 주므로, 그대로 두면 <b>수비자만</b>
     * 상대의 전술 비밀을 읽는 일방적 스카우팅이 된다 — 이 게임의 차별점이 선수별 자연어 지시인 이상
     * (루트 CLAUDE.md §1) 레이팅이 걸린 대전에서 이건 정보 유출이다.
     *
     * <p>즉 권한 확대는 <b>"읽기냐 쓰기냐"만이 아니라 "무엇을 읽느냐"</b>도 같이 좁혀야 한다.
     */
    public MatchDetail toDetailFor(String viewerId, MatchRow row) {
        MatchDetail detail = toDetail(row);
        if (row.userId().equals(viewerId)) {
            return detail;
        }
        // ⚠️ **허용할 것을 열거한다**(지울 것을 열거하지 않는다). 초판은 userDeckSnapshot 만 지웠는데
        // conditions 가 그대로 나가 공격자의 **선발 11 + 벤치 2 playerId 전량과 선수별 컨디션**이
        // 넘어갔다(독립검증 3R MAJOR-1). 지우기 목록은 필드가 늘 때마다 조용히 새는 반면, 허용
        // 목록은 새 필드가 **기본으로 막힌다** — 다음 사람이 여기 손대지 않으면 유출이 생기지 않는다.
        //
        // 관전자에게 허용: 식별·진행·결과·상대(=자기 팀)·시계·팀 이름(#322 homeName/awayName 포함 —
        // 두 값 다 ownerName·opponent.name 의 재배치일 뿐이라 새로 새는 정보가 없다).
        // 그 외는 전부 뗀다.
        return new MatchDetail(detail.id(), detail.state(), detail.failReason(), detail.opponent(),
                detail.scoreH1Home(), detail.scoreH1Away(), detail.scoreHome(), detail.scoreAway(),
                detail.result(), detail.createdAt(), detail.finishedAt(),
                null,                    // conditions — 공격자 로스터·컨디션(3R MAJOR-1)
                detail.mode(), detail.leagueFixtureId(),
                null,                    // userDeckSnapshot — 공격자 선수별 지시·팀 전술(1R BL-1)
                detail.clock(), detail.ownerName(), detail.homeName(), detail.awayName(),
                false,                   // auto(#249) — 공격자의 흐름 설정. 허용 목록 규칙대로 새 필드는
                                         // 기본 차단이다: 관전자가 알 이유가 없고, 쓰기는 어차피 소유자만.
                false);                  // tutorial(#493) — 온레일 가이드는 소유자 화면의 것이다.
    }

    public MatchDetail toDetail(MatchRow row) {
        // Phase2 additive(MatchDetailPhase2Fields): conditions/mode/leagueFixtureId — 시계 UI·리그 뱃지용.
        // + userDeckSnapshot(#98 요구 2): 이 매치에 쓴 덱 스냅샷을 읽어서 노출만(저장 로직 변경 0).
        // + clock(P4-E2 #170): 라이브 단계에서만 채워지는 서버 권위 시계.
        String mode = row.mode() == null ? "practice" : row.mode();
        // 스포일러 금지: 전반이 아직 재생 중이면 전반 스코어를 내려주지 않는다(계약상 scoreH1* 은
        // "감독시간 이후"에 채워지는 필드다). 후반 스코어·결과는 FINISHED 전까지 애초에 null 이다.
        boolean h1Live = S_FIRST_HALF.equals(row.state());
        // + homeName/awayName(#322): 사이드 라벨 **그대로**. 클라가 "홈 = 소유자"로 배치하다가
        //   리그 어웨이 라운드 화면이 통째로 뒤집혔다(스코어·로그 라벨·좌우). 불리언 하나만 주면
        //   관전자 경로(#245 — 홈이 공격자다)에서 해석이 또 갈리므로 **이름을 배치해서** 보낸다.
        Opponent opponent = buildOpponent(row);
        String owner = ownerNameOf(row);
        boolean userHome = userIsHome(row);
        return new MatchDetail(row.id(), row.state(), row.failReason(), opponent,
                h1Live ? null : row.scoreH1Home(), h1Live ? null : row.scoreH1Away(),
                row.scoreHome(), row.scoreAway(),
                row.result(), row.createdAt(), row.finishedAt(),
                conditionsOf(row), mode, row.leagueFixtureId(), userDeckSnapshotOf(row),
                clockService.clockOf(row), owner,
                userHome ? owner : opponent.name(),
                userHome ? opponent.name() : owner,
                effectiveAuto(row), row.tutorial());
    }

    /**
     * 응답에 싣는 오토 = <b>실제로 흐름에 적용되는 값</b>(#249, 독립검증 major-2).
     *
     * <p>저장된 플래그(`row.auto()`)를 그대로 내려주면 킬스위치를 내렸을 때 <b>서버와 클라가 서로 다른
     * 흐름을 믿는다</b>: 서버는 `openHalftime` 이 플래그를 무시해 정상 180초 감독시간을 여는데,
     * 클라는 `auto=true` 를 보고 감독 패널을 숨긴다(`suppressHalftimePanel`) → 오토를 켜뒀던 진행 중
     * 매치가 <b>감독 패널도 [후반 시작] 버튼도 없는 3분</b>을 맞는다.
     *
     * <p>킬스위치는 사고 대응 수단인데 그 상태로는 롤백이 증상을 넓힌다. 여기서 한 번 접어 내리면
     * 클라 가드와 서버 동작이 <b>구조적으로 어긋날 수 없다</b>. 저장값 자체는 남는다 — 스위치를 다시
     * 올리면 유저가 켜 뒀던 설정이 그대로 살아난다.
     */
    private boolean effectiveAuto(MatchRow row) {
        return row.auto() && autoProps.isEnabled();
    }

    /** 매치 소유자(홈)의 닉네임 — 관전자가 홈을 자기 이름으로 오인하지 않게(#245). */
    private String ownerNameOf(MatchRow row) {
        return jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(row.userId())
                .query(String.class)
                .optional()
                .orElse(null);
    }

    /**
     * 저장된 {@code matches.user_deck_json} → openapi-v2 {@code TeamSnapshot} 형상(#98 요구 2 계약 B).
     *
     * <p>저장 포맷은 {@link #snapshotDeck}이 쓰는 그대로 두고(엔진/재현 계약 영향 0), 응답 조립 시점에
     * <b>TeamSnapshot 이 정의한 필드만 투영</b>한다: {formation, starters[], bench[], teamTactics?,
     * teamPrompt?}. 미지의 잉여 필드가 생겨도 계약 밖으로 새지 않는다.
     *
     * <p>값이 없거나(구 매치) 파싱 불가/형상 불일치면 <b>null</b>(필드 생략) — 500 금지. 프리셋 저장
     * 플로우는 웹에서 비활성 + 안내로 처리한다.
     */
    JsonNode userDeckSnapshotOf(MatchRow row) {
        String raw = row.userDeckJson();
        if (raw == null || raw.isBlank()) {
            return null;
        }
        JsonNode node;
        try {
            node = objectMapper.readTree(raw);
        } catch (Exception e) {
            log.warn("user_deck_json parse failed (matchId={}) — userDeckSnapshot omitted", row.id(), e);
            return null;
        }
        if (node == null || !node.isObject()
                || !node.path("formation").isTextual()
                || !node.path("starters").isArray()
                || !node.path("bench").isArray()) {
            return null; // TeamSnapshot 필수 필드(formation/starters/bench) 미충족 → 노출 안 함
        }
        ObjectNode out = objectMapper.createObjectNode();
        out.put("formation", node.get("formation").asText());
        out.set("starters", projectSnapshotSlots(node.get("starters")));
        out.set("bench", projectSnapshotSlots(node.get("bench")));
        if (node.path("teamTactics").isObject()) {
            out.set("teamTactics", node.get("teamTactics").deepCopy());
        }
        if (node.path("teamPrompt").isTextual()) {
            out.put("teamPrompt", node.get("teamPrompt").asText());
        }
        return out;
    }

    /** SnapshotSlot {playerId, slotIndex, promptText?} 만 투영. 형상이 깨진 항목은 건너뛴다. */
    private ArrayNode projectSnapshotSlots(JsonNode slots) {
        ArrayNode out = objectMapper.createArrayNode();
        for (JsonNode slot : slots) {
            if (!slot.isObject() || !slot.path("playerId").isTextual() || !slot.path("slotIndex").isInt()) {
                continue;
            }
            ObjectNode entry = objectMapper.createObjectNode();
            entry.put("playerId", slot.get("playerId").asText());
            entry.put("slotIndex", slot.get("slotIndex").asInt());
            if (slot.path("promptText").isTextual()) {
                entry.put("promptText", slot.get("promptText").asText());
            }
            out.add(entry);
        }
        return out;
    }

    private Opponent buildOpponent(MatchRow row) {
        BotService.BotRow bot = botService.get(row.botId());
        // #493 W10 — <b>튜토리얼의 상대 로스터는 구운 자산이 소유한다</b>(봇 덱이 아니다).
        //
        // W10 이 튜토리얼 로스터를 "얼굴 캐릭터가 있는 선수"로 갈면서 away 도 같이 갈렸는데,
        // 시드봇 덱(`data/players/bots.v4.json`)은 전원 등급 공용 아트이고 `data/**` 는 이 모듈의
        // owned-glob 밖이라 여기서 맞출 수 없다. 봇 덱을 계속 읽으면 <b>상대 분석 카드가 경기에
        // 나오지도 않는 선수 11명</b>을 보여준다 — 화면과 실제로 뛴 로스터가 갈리는 형태다.
        // 자산이 시뮬에 쓴 그 배열(`selectData.away.players`)을 그대로 읽어 축을 하나로 둔다.
        // (봇 행은 계속 필요하다 — `matches.bot_id` FK · 상대 <b>이름</b>·분석문의 출처다.)
        // ⚠️ `available()` 을 같이 본다 — 자산이 빠진 배포에서 <b>이미 만들어져 있던</b> 튜토리얼
        // 매치를 열면 자산 로딩이 예외를 던져 조회가 통째로 500 이 된다. 그 경우엔 봇 덱으로
        // 물러선다(로스터가 실제와 다를 뿐, 화면은 성립한다).
        JsonNode starters = row.tutorial() && tutorialAsset.available()
                ? tutorialAsset.selectData().path("away").path("players")
                : readJson(bot.deckJson()).path("starters");
        // 이 상대가 실유저의 고스트면 그 유저가 카드의 주인이다(★ 의 출처). 시드봇·리그봇은 null —
        // 카드가 없으므로 ★ 는 0 이다. LeagueService 를 안 물고 직접 읽는 이유는 userIsHome 과 같다:
        // 한 줄짜리 조회에 모듈 의존(그것도 순환)을 만들지 않는다.
        String ghostOwner = awayDefenderOf(row.id());
        List<OpponentPlayer> players = new ArrayList<>();
        for (JsonNode starter : starters) {
            String playerId = starter.path("playerId").asText();
            Map<String, String> p = playerNameGrade(playerId);
            // 능력치는 **실제로 뛰는 값**이다: 고스트 덱에는 수비자의 유효스탯이 얼려 박혀 있고
            // (AwayService.withFrozenAttributes), 없으면 카탈로그 원본이 선다. 카드에서 지금 다시
            // 계산하면 굽고 난 뒤의 강화가 화면에만 반영돼 표시와 경기가 갈린다.
            Map<String, Object> attributes = opponentAttributes(starter, playerId);
            players.add(new OpponentPlayer(playerId, p.get("name"), p.get("position"), p.get("grade"),
                    growthService.cardStar(ghostOwner, playerId),
                    growthService.ovrOf(p.get("position"), attributes),
                    attributes,
                    starter.hasNonNull("promptText")));
        }
        return new Opponent(bot.name(), bot.analysisText(), players);
    }

    /** 이 매치에서 원정을 당한 쪽(= 고스트 로스터의 주인). 원정이 아니면 null. */
    private String awayDefenderOf(String matchId) {
        return jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                .param(matchId)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    /**
     * 고스트에 얼린 유효스탯 → 없으면 카탈로그 원본. 둘 다 없으면 빈 맵(OVR 은 0 이 된다).
     *
     * <p>⚠️ <b>값의 수 표기가 두 경로에서 다르다</b>(계약 위반은 아니다 — 둘 다 {@code number}):
     * 얼린 스냅샷은 굽는 시점의 JSON 을 그대로 되싣고, 카탈로그는 {@code attributes_json} 의 정수라
     * {@code 40} 으로 나간다. 반면 {@code /api/users/{id}/squad} 는 지금 계산한 유효치라 {@code 40.0}
     * 이다. <b>클라는 수 표기에 기대지 말고 number 로 읽어야 한다</b>.
     */
    private Map<String, Object> opponentAttributes(JsonNode starter, String playerId) {
        Map<String, Object> out = new LinkedHashMap<>();
        JsonNode frozen = starter.path("attributes");
        if (frozen.isObject()) {
            frozen.properties().forEach(e -> out.put(e.getKey(), e.getValue().numberValue()));
            return out;
        }
        String json = jdbcClient.sql("SELECT attributes_json FROM players WHERE id = ?")
                .param(playerId).query(String.class).optional().orElse(null);
        if (json == null || json.isBlank()) {
            return out;
        }
        readJson(json).properties().forEach(e -> out.put(e.getKey(), e.getValue().numberValue()));
        return out;
    }

    private Map<String, String> playerNameGrade(String playerId) {
        return jdbcClient.sql("SELECT name, position, grade FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> Map.of("name", rs.getString("name"),
                        "position", rs.getString("position"), "grade", rs.getString("grade")))
                .optional()
                .orElse(Map.of("name", playerId, "position", "?", "grade", "?"));
    }

    // ── 프롬프트 (BRIEFING: pre / H1_BREAK: halftime) ───────────────────

    public record PromptRequest(String phase, String scope, String playerId, String text) {
    }

    public MatchRow submitPrompt(String userId, String matchId, PromptRequest request) {
        MatchRow row = getOwned(userId, matchId);

        String phase = request == null ? null : request.phase();
        String scope = request == null ? null : request.scope();
        if (!"pre".equals(phase) && !"halftime".equals(phase)) {
            throw ApiException.validation("phase는 pre|halftime만 허용됩니다");
        }
        if (!"team".equals(scope) && !"player".equals(scope)) {
            throw ApiException.validation("scope는 team|player만 허용됩니다");
        }

        // 전이표: pre↔BRIEFING / halftime↔FIRST_HALF·HALFTIME(P4-E2 #170 — 전반을 보면서 후반 지시를
        // 미리 써두고 감독시간에 마저 고친다). 그 외 409 (AC-M1)
        boolean allowed = "pre".equals(phase)
                ? row.state().equals(S_BRIEFING)
                : PRE_SECOND_HALF_STATES.contains(row.state());
        if (!allowed) {
            throw invalidState(row.state(), "prompts(" + phase + ")");
        }

        if (request.text() == null || request.text().isBlank()) {
            throw ApiException.validation("text가 비어 있습니다");
        }
        if (request.text().length() > promptMaxChars) {
            throw ApiException.validation("프롬프트가 최대 길이(" + promptMaxChars + "자)를 초과했습니다");
        }

        String playerId = null;
        if ("player".equals(scope)) {
            playerId = request.playerId();
            if (playerId == null || playerId.isBlank()) {
                throw ApiException.validation("scope=player는 playerId가 필요합니다");
            }
            // 로스터(선발+벤치 — 후반 투입 가능 인원 포함) 소속 검증
            Set<String> roster = snapshotPlayerIds(row);
            if (!roster.contains(playerId)) {
                throw ApiException.validation("매치 로스터에 없는 선수입니다: " + playerId);
            }
        }

        upsertPrompt(matchId, phase, scope, playerId, request.text());
        return row;
    }

    /**
     * UPSERT — ERD UNIQUE(match_id, phase, scope, player_id)는 player_id NULL(team 행)을
     * 중복 허용하므로(SQLite NULL 규칙) 코드 레벨 UPDATE→INSERT로 두 scope 모두 처리.
     */
    private void upsertPrompt(String matchId, String phase, String scope, String playerId, String text) {
        txRunner.run(() -> {
            int updated = playerId == null
                    ? jdbcClient.sql("""
                                    UPDATE match_prompts SET text = ? WHERE match_id = ? AND phase = ?
                                    AND scope = ? AND player_id IS NULL
                                    """)
                            .params(text, matchId, phase, scope).update()
                    : jdbcClient.sql("""
                                    UPDATE match_prompts SET text = ? WHERE match_id = ? AND phase = ?
                                    AND scope = ? AND player_id = ?
                                    """)
                            .params(text, matchId, phase, scope, playerId).update();
            if (updated == 0) {
                jdbcClient.sql("""
                                INSERT INTO match_prompts(match_id, phase, scope, player_id, text, created_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                """)
                        .params(matchId, phase, scope, playerId, text, Instant.now().toString())
                        .update();
            }
        });
    }

    // ── 킥오프 / 재개 / 재시도 (CAS만 — 잡 enqueue는 Orchestrator) ───────

    public MatchRow kickoffCas(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        if (!casTransition(matchId, S_BRIEFING, S_GEN1)) {
            throw invalidState(currentState(matchId), "kickoff");
        }
        return getOwned(userId, matchId);
    }

    /**
     * 감독시간 → 후반 시뮬(유저 제출). <b>HALFTIME 에서만</b> 허용한다 — 전반 재생 중에 눌러
     * 후반을 앞당기는 건 금지다(P4-D1). 만료 시엔 서버(MatchClockService)가 같은 전이를 수행한다.
     */
    public MatchRow resumeCas(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        boolean moved = jdbcClient.sql("""
                        UPDATE matches SET state = ?, phase_start_at = NULL, phase_ends_at = NULL
                        WHERE id = ? AND state IN ('HALFTIME', 'H1_BREAK')
                        """)
                .params(S_GEN2, matchId)
                .update() == 1;
        if (!moved) {
            throw invalidState(currentState(matchId), "resume");
        }
        return getOwned(userId, matchId);
    }

    /**
     * 오토 모드 토글 허용 state (#249). 후반이 열리기 전(=전반 종료 경계를 아직 안 지난) 구간뿐이다.
     *
     * <p>{@code HALFTIME} 이 들어 있는 건 <b>경합 창</b> 때문이다: 유저가 전반 막바지에 켰는데 그 사이
     * 스위퍼가 경계를 넘어가면(≤1s) 요청이 HALFTIME 에 떨어진다. 여기서 409 를 내면 "제때 눌렀는데
     * 실패"가 되므로 받아주고, {@link #setAutoCas} 가 그 자리에서 후반을 연다(hero 컨펌 Q3).
     *
     * <p>⚠️ 이 상수는 <b>주석이 아니라 실제 SQL 을 만든다</b>({@link #AUTO_TOGGLE_IN_CLAUSE}). 처음엔
     * 리터럴 IN 목록 옆에 놓고 "테스트가 읽는 SoT"라고 적어 뒀는데 참조가 0이라 <b>아무 값으로 바꿔도
     * 아무것도 안 깨졌다</b>(독립검증 minor-1). 주석이 코드보다 오래 살면 다음 사람이 속는다 —
     * 이 에픽의 blocker 가 정확히 그 실패였다(가드가 주석만 남고 코드가 빠졌다).
     */
    static final Set<String> AUTO_TOGGLE_STATES =
            Set.of(S_BRIEFING, S_GEN1, S_FIRST_HALF, S_HALFTIME, S_H1_BREAK);

    /** 위 집합에서 만든 IN 절 — 값이 전부 코드 상수라 인젝션 표면이 없다. */
    private static final String AUTO_TOGGLE_IN_CLAUSE = AUTO_TOGGLE_STATES.stream()
            .sorted()
            .map(state -> "'" + state + "'")
            .collect(java.util.stream.Collectors.joining(","));

    /** 오토 토글 결과. {@code resumedNow} = 이 호출이 감독시간을 끝내고 후반을 열었다(경합 창). */
    public record AutoToggleResult(MatchRow row, boolean resumedNow) {
    }

    /**
     * 오토 모드 on/off (#249). 플래그는 <b>전반 종료 경계에서만</b> 읽힌다
     * ({@link MatchClockService} 의 CAS WHERE 절) — 여기서는 저장만 한다.
     *
     * <p>예외가 하나 있다: <b>감독시간이 이미 열린 뒤 ON</b>. 경계는 지나갔으므로 플래그를 저장해봐야
     * 이 매치에서는 영원히 읽히지 않는다 = 죽은 버튼이다. 그래서 {@link #resumeCas} 와 <b>같은 전이</b>를
     * 그 자리에서 밟는다(신규 경로 0). 덕분에 토글이 경계 직전에 떨어지든 직후에 떨어지든 결과가
     * 같아진다 — 경합이 무해해진다(hero 컨펌 Q3).
     *
     * <p>후반이 이미 시작된 뒤(GEN2~)는 409 다. 감독시간은 지나갔고 되돌릴 수 없으므로 "OFF 했는데
     * 아무 일도 없음"보다 거부가 정직하다.
     */
    public AutoToggleResult setAutoCas(String userId, String matchId, boolean auto) {
        getOwned(userId, matchId);
        boolean moved = txRunner.run(() -> jdbcClient.sql(
                        "UPDATE matches SET auto_mode = ? WHERE id = ? AND state IN ("
                                + AUTO_TOGGLE_IN_CLAUSE + ")")
                .params(auto ? 1 : 0, matchId)
                .update() == 1);
        if (!moved) {
            throw invalidState(currentState(matchId), "auto");
        }
        // 감독시간에서 ON = 즉시 후반. resumeCas 와 같은 CAS 라 스위퍼·유저 [후반 시작]과 동시에
        // 들어와도 정확히 한 번만 성공한다(false 면 남이 이미 열었다는 뜻 — 그대로 성공 응답).
        //
        // ⚠️ `auto &&` 를 지우지 마라(독립검증 major-1 — 이 한 토큰을 지워도 게이트가 전부 통과했다).
        // 감독시간에 도착하는 요청은 ON 만이 아니다: 유저가 전반 막바지에 오토를 **끄는데** 그 사이
        // 경계가 넘어가면 OFF 가 여기 떨어진다(서버가 HALFTIME 을 받아주는 이유가 그 경합 창이다).
        // 가드가 없으면 **끄려던 조작이 후반을 즉시 열어** 유저가 원했던 감독시간 3분을 통째로 잃는다.
        // 계약 = MatchAutoModeTest.turningAutoOffDuringTheHalftimeKeepsTheHalftime.
        boolean resumedNow = false;
        if (auto && HALFTIME_STATES.contains(currentState(matchId))) {
            resumedNow = jdbcClient.sql("""
                            UPDATE matches SET state = ?, phase_start_at = NULL, phase_ends_at = NULL
                            WHERE id = ? AND state IN ('HALFTIME', 'H1_BREAK')
                            """)
                    .params(S_GEN2, matchId)
                    .update() == 1;
        }
        return new AutoToggleResult(getOwned(userId, matchId), resumedNow);
    }

    /** FAILED → 실패 지점 재큐잉 (AC-M7). 반환 = 다시 돌릴 half. */
    public int retryCas(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        int half = jdbcClient.sql("SELECT COUNT(*) FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(Long.class).single() > 0 ? 2 : 1;
        String target = half == 1 ? S_GEN1 : S_GEN2;
        boolean ok = jdbcClient.sql(
                        "UPDATE matches SET state = ?, fail_reason = NULL WHERE id = ? AND state = 'FAILED'")
                .params(target, matchId)
                .update() == 1;
        if (!ok) {
            throw invalidState(currentState(matchId), "retry");
        }
        // 실패한/미완 잡 재큐잉: done이 아닌 해당 half 잡을 queued로 리셋(수동 재시도 = attempts 초기화).
        // F1(W3 검증 발견 레이스): created_at도 now로 리셋한다. timedOutGenMatches는 GEN 타임아웃을
        // created_at 기준(=현재 pending 사이클 시작 시각)으로 판정하는데, 리셋하지 않으면 timeout으로
        // FAILED됐던 매치를 유저가 retry한 순간 잡의 created_at이 여전히 과거라 즉시 재-타임아웃 자격을
        // 얻어 다음 sweep(≤10s)이 실 서번트(초~분 지연)가 완료하기도 전에 다시 FAILED시킨다.
        // updated_at 기준으로 바꾸지 않는 이유: updated_at은 lease/재큐잉마다 갱신되므로 죽은 워커의
        // lease 만료→재배포가 반복되면 타임아웃 데드라인이 무한정 밀려 타임아웃 자체가 무력화된다.
        // created_at = "현재 pending 사이클 시작"으로 두고 retry에서만 리셋하는 게 lease churn에 면역이다.
        jdbcClient.sql("""
                        UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL,
                               lease_until = NULL, worker_id = NULL,
                               created_at = ?, updated_at = ?
                        WHERE match_id = ? AND half = ? AND status != 'done'
                        """)
                .params(Instant.now().toString(), Instant.now().toString(), matchId, half)
                .update();
        return half;
    }

    private String currentState(String matchId) {
        return jdbcClient.sql("SELECT state FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    // ── 하프타임 교체 (AC-M4, LLD §5.4 — 저장만, 전이 없음) ─────────────

    public record Substitution(String out, String in) {
    }

    /** 감독시간 배치 슬롯(#276) — 덱의 {@code SnapshotSlot} 과 같은 형상(playerId + slotIndex). */
    public record ShapeSlot(String playerId, Integer slotIndex) {
    }

    public MatchRow submitHalftime(String userId, String matchId, List<Substitution> substitutions) {
        return submitHalftime(userId, matchId, substitutions, null);
    }

    public MatchRow submitHalftime(String userId, String matchId, List<Substitution> substitutions,
                                    JsonNode teamTactics) {
        return submitHalftime(userId, matchId, substitutions, teamTactics, null, null);
    }

    /**
     * @param teamTactics 감독시간 팀 전술(#254, 선택). hero 결정 = <b>허용</b> — 후반에 라인·압박·템포·
     *     폭을 바꿀 수 있다. {@code null}(미첨부)이면 손대지 않은 것이므로 전반 전술을 그대로 이어간다.
     *     저장 위치는 {@code matches.h2_tactics_json} 이고 <b>매치 스냅샷은 건드리지 않는다</b> —
     *     스냅샷의 teamTactics 는 이미 끝난 전반의 기록이라 덮으면 소급 변조가 된다(V24 주석).
     * @param formation 감독시간 포메이션(#276, 선택). {@code starters} 와 <b>둘 다 있거나 둘 다 없어야</b>
     *     한다 — 배치는 한 덩어리라 반쪽은 뜻이 없다(한쪽만 오면 400 SHAPE_INVALID rule=SHAPE_PARTIAL).
     * @param starters 감독시간 선발 배치(#276, 선택) — <b>교체 반영 후의 실효 선발</b> 11명.
     *     {@code null}(미첨부)이면 손대지 않은 것이므로 전반 배치를 그대로 이어간다. 저장 위치는
     *     {@code matches.h2_shape_json}, <b>매치 스냅샷은 불변</b>(V29 주석).
     */
    public MatchRow submitHalftime(String userId, String matchId, List<Substitution> substitutions,
                                    JsonNode teamTactics, String formation, List<ShapeSlot> starters) {
        MatchRow row = getOwned(userId, matchId);
        // 전반 중에도 교체를 미리 짜둘 수 있다(P4-E2 #170) — 반영은 후반 시뮬에서.
        if (!PRE_SECOND_HALF_STATES.contains(row.state())) {
            throw invalidState(row.state(), "halftime");
        }
        online.hmb.meta.TeamTactics.validate(teamTactics); // 있으면 4축 0..1
        List<Substitution> subs = substitutions == null ? List.of() : substitutions;

        if (subs.size() > halftimeSubsMax) {
            throw subsInvalid("교체는 최대 " + halftimeSubsMax + "명입니다",
                    Map.of("rule", "SUBS_MAX", "count", subs.size(), "max", halftimeSubsMax));
        }

        JsonNode snapshot = readJson(row.userDeckJson());
        Map<String, Integer> starterSlots = new LinkedHashMap<>();
        for (JsonNode s : snapshot.path("starters")) {
            starterSlots.put(s.path("playerId").asText(), s.path("slotIndex").asInt());
        }
        Set<String> bench = new HashSet<>();
        for (JsonNode b : snapshot.path("bench")) {
            bench.add(b.path("playerId").asText());
        }

        Set<String> outs = new HashSet<>();
        Set<String> ins = new HashSet<>();
        for (Substitution sub : subs) {
            if (sub.out() == null || sub.in() == null) {
                throw subsInvalid("out/in이 비어 있습니다", Map.of("rule", "SUB_FIELDS_REQUIRED"));
            }
            if (!starterSlots.containsKey(sub.out())) {
                throw subsInvalid("out은 전반 선발이어야 합니다: " + sub.out(),
                        Map.of("rule", "OUT_NOT_STARTER", "playerId", sub.out()));
            }
            if (!bench.contains(sub.in())) {
                throw subsInvalid("in은 벤치 선수여야 합니다: " + sub.in(),
                        Map.of("rule", "IN_NOT_BENCH", "playerId", sub.in()));
            }
            if (!outs.add(sub.out())) {
                throw subsInvalid("같은 선수를 두 번 뺄 수 없습니다: " + sub.out(),
                        Map.of("rule", "DUPLICATE_OUT", "playerId", sub.out()));
            }
            if (!ins.add(sub.in())) {
                throw subsInvalid("같은 선수를 두 번 넣을 수 없습니다: " + sub.in(),
                        Map.of("rule", "DUPLICATE_IN", "playerId", sub.in()));
            }
        }

        // 교체 후 GK ≥ 1 (AC-M4)
        Map<String, String> positions = positionsOf(unionOf(starterSlots.keySet(), ins));
        long gkAfter = starterSlots.keySet().stream()
                .map(pid -> outs.contains(pid) ? swapIn(subs, pid) : pid)
                .filter(pid -> "GK".equals(positions.get(pid)))
                .count();
        if (gkAfter < 1) {
            throw subsInvalid("교체 후에도 GK가 최소 1명 필요합니다", Map.of("rule", "GK_REQUIRED"));
        }

        // 감독시간 배치(#276) — 형상 검증 + 교체와의 정합. GK≥1 은 위 교체 검사가 이미 한다(중복 금지).
        String h2Shape = shapeJsonFor(row, formation, starters,
                substitutions == null ? parseSubs(row.subsJson()) : subs,
                starterSlots.keySet());

        // 세 필드 모두 **미첨부 = 손대지 않음**(COALESCE), 명시적 값 = 그 값이 이긴다. 이 엔드포인트는
        // 감독시간에 여러 번 불릴 수 있으므로(전술만 고치는 재제출 · 교체만 고치는 재제출 · 배치만
        // 고치는 재제출) 한쪽만 보낸 호출이 다른 쪽을 조용히 지우면 안 된다 — #253 과 같은 종류의 유실.
        // ⚠️ 빈 배열 `[]` 은 미첨부가 아니다: "교체를 전부 취소한다"는 명시적 의사라 그대로 저장된다.
        String subsJson = substitutions == null ? null : toJson(subs);
        String h2Tactics = teamTactics == null || teamTactics.isNull() ? null : teamTactics.toString();
        txRunner.run(() -> jdbcClient.sql("""
                        UPDATE matches SET subs_json = COALESCE(?, subs_json),
                                           h2_tactics_json = COALESCE(?, h2_tactics_json),
                                           h2_shape_json = COALESCE(?, h2_shape_json)
                        WHERE id = ? AND state IN ('FIRST_HALF', 'HALFTIME', 'H1_BREAK')
                        """)
                .params(subsJson, h2Tactics, h2Shape, matchId)
                .update());
        return getOwned(userId, matchId);
    }

    private static String swapIn(List<Substitution> subs, String outId) {
        return subs.stream().filter(s -> s.out().equals(outId)).findFirst().map(Substitution::in).orElse(outId);
    }

    private static ApiException subsInvalid(String message, Map<String, Object> detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "SUBSTITUTION_INVALID", message, detail);
    }

    private static ApiException shapeInvalid(String message, Map<String, Object> detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "SHAPE_INVALID", message, detail);
    }

    /** subs_json → 교체 목록. 없으면 빈 리스트. */
    private List<Substitution> parseSubs(String subsJson) {
        List<Substitution> list = new ArrayList<>();
        if (subsJson == null || subsJson.isBlank()) {
            return list;
        }
        for (JsonNode node : readJson(subsJson)) {
            list.add(new Substitution(node.path("out").asText(null), node.path("in").asText(null)));
        }
        return list;
    }

    /**
     * 감독시간 배치(#276) 검증 → 저장할 JSON(미첨부면 null = COALESCE 로 손대지 않음).
     *
     * <p>검증 규칙은 덱({@link DeckService#validate})과 <b>같은 뜻·같은 rule 키</b>다 — 같은 조작이
     * 두 화면에서 다른 규칙으로 걸리면 통일성이 아니다. 다만 code 는 {@code SHAPE_INVALID} 로 분리해
     * 웹이 "덱이 잘못됐다"와 "감독시간 배치가 잘못됐다"를 구분해 안내할 수 있게 한다.
     *
     * <p><b>교체와의 정합</b>: 실효 배치의 선발 집합 == (전반 선발 − out + in). 기준이 되는 교체는
     * 이번 요청의 것(미첨부면 DB 에 저장된 subs_json)이다. 이 검사는 <b>이번에 제출한 배치</b>뿐
     * 아니라 <b>이미 저장된 배치</b>에도 건다 — 배치를 낸 뒤 교체만 고쳐 재제출하면 그 배치가 새
     * 교체와 어긋난 채 남아 조용히 무시되기 때문이다(투입 선수를 배치에서 못 찾아 슬롯 승계로
     * 떨어진다). 400 은 시끄럽지만 조용한 무시보다 낫다 — web 은 보드에서 둘을 함께 낸다.
     *
     * @param effectiveSubs 이번 제출 후 <b>유효해질</b> 교체
     * @param h1Starters 전반 선발 playerId
     */
    private String shapeJsonFor(MatchRow row, String formation, List<ShapeSlot> starters,
                                List<Substitution> effectiveSubs, Set<String> h1Starters) {
        boolean formationGiven = formation != null;
        boolean startersGiven = starters != null;
        if (formationGiven != startersGiven) {
            // 배치는 한 덩어리다 — 포메이션만 바꾸고 슬롯을 안 주면 어느 자리에 누가 서는지가 없다.
            throw shapeInvalid("formation 과 starters 는 함께 보내야 합니다",
                    Map.of("rule", "SHAPE_PARTIAL",
                            "formation", formationGiven, "starters", startersGiven));
        }

        String shapeJson = row.h2ShapeJson(); // 미첨부면 이미 저장된 배치가 실효값이다
        if (formationGiven) {
            shapeJson = validateAndSerializeShape(formation, starters);
        }
        if (shapeJson == null || shapeJson.isBlank()) {
            return formationGiven ? shapeJson : null;
        }

        // 실효 배치 ↔ 실효 교체 정합
        Set<String> expected = new HashSet<>(h1Starters);
        for (Substitution sub : effectiveSubs) {
            expected.remove(sub.out());
            expected.add(sub.in());
        }
        Set<String> actual = new HashSet<>();
        for (JsonNode slot : readJson(shapeJson).path("starters")) {
            actual.add(slot.path("playerId").asText());
        }
        if (!expected.equals(actual)) {
            Set<String> missing = new HashSet<>(expected);
            missing.removeAll(actual);
            Set<String> unexpected = new HashSet<>(actual);
            unexpected.removeAll(expected);
            throw shapeInvalid("배치의 선발이 교체 결과와 다릅니다",
                    Map.of("rule", "ROSTER_MISMATCH",
                            "missing", List.copyOf(missing), "unexpected", List.copyOf(unexpected)));
        }
        return formationGiven ? shapeJson : null; // 미첨부는 재검증만 하고 쓰지 않는다
    }

    /** 형상 검증(11명·slotIndex 0..10 유일·playerId 유일·formation 비어있지 않음) → 정규화 JSON. */
    private String validateAndSerializeShape(String formation, List<ShapeSlot> starters) {
        if (formation.isBlank()) {
            throw shapeInvalid("formation이 비어 있습니다", Map.of("rule", "FORMATION_REQUIRED"));
        }
        if (starters.size() != DeckService.STARTER_COUNT) {
            throw shapeInvalid("선발이 " + DeckService.STARTER_COUNT + "명이 아닙니다",
                    Map.of("rule", "STARTER_COUNT", "starterCount", starters.size(),
                            "required", DeckService.STARTER_COUNT));
        }
        Set<String> seenPlayers = new HashSet<>();
        Set<Integer> seenSlots = new HashSet<>();
        ArrayNode array = objectMapper.createArrayNode();
        for (ShapeSlot slot : starters) {
            if (slot.playerId() == null || slot.playerId().isBlank()) {
                throw shapeInvalid("playerId가 비어 있는 슬롯이 있습니다",
                        Map.of("rule", "PLAYER_ID_REQUIRED"));
            }
            if (slot.slotIndex() == null) {
                throw shapeInvalid("slotIndex가 없습니다",
                        Map.of("rule", "SLOT_INDEX_REQUIRED", "playerId", slot.playerId()));
            }
            if (slot.slotIndex() < 0 || slot.slotIndex() >= DeckService.STARTER_COUNT) {
                throw shapeInvalid("slotIndex는 0..10이어야 합니다",
                        Map.of("rule", "SLOT_INDEX_RANGE", "playerId", slot.playerId(),
                                "slotIndex", slot.slotIndex()));
            }
            if (!seenPlayers.add(slot.playerId())) {
                throw shapeInvalid("같은 선수를 두 번 세울 수 없습니다",
                        Map.of("rule", "DUPLICATE_PLAYER", "playerId", slot.playerId()));
            }
            if (!seenSlots.add(slot.slotIndex())) {
                throw shapeInvalid("slotIndex가 중복됩니다",
                        Map.of("rule", "SLOT_INDEX_DUPLICATE", "playerId", slot.playerId(),
                                "slotIndex", slot.slotIndex()));
            }
            ObjectNode entry = objectMapper.createObjectNode();
            entry.put("playerId", slot.playerId());
            entry.put("slotIndex", slot.slotIndex());
            array.add(entry);
        }
        ObjectNode shape = objectMapper.createObjectNode();
        shape.put("formation", formation);
        shape.set("starters", array);
        return shape.toString();
    }

    private Map<String, String> positionsOf(Set<String> playerIds) {
        Map<String, String> positions = new HashMap<>();
        if (playerIds.isEmpty()) {
            return positions;
        }
        String in = String.join(",", playerIds.stream().map(p -> "?").toList());
        jdbcClient.sql("SELECT id, position FROM players WHERE id IN (" + in + ")")
                .params(List.copyOf(playerIds))
                .query((rs, n) -> Map.entry(rs.getString("id"), rs.getString("position")))
                .list()
                .forEach(e -> positions.put(e.getKey(), e.getValue()));
        return positions;
    }

    private static Set<String> unionOf(Set<String> a, Set<String> b) {
        Set<String> union = new HashSet<>(a);
        union.addAll(b);
        return union;
    }

    // ── half 로그 / 결과 ────────────────────────────────────────────────

    /**
     * GET halves/{n}/log — half1 은 전반이 열린 뒤(FIRST_HALF)부터, half2 는 후반이 열린 뒤
     * (SECOND_HALF)부터. 그 외 409, 데이터 없으면 404.
     *
     * <p>로그는 하프 <b>전체</b>를 준다. 라이브 중 "앞서가기 금지"는 clock 기반 클라 강제다
     * (서버 절단은 PvP 백로그 — LLD §11 R3).
     */
    public String halfLogJson(String userId, String matchId, int half) {
        MatchRow row = getViewable(userId, matchId);   // #245: 원정 수비자도 자기 팀 경기를 본다(읽기 전용)
        boolean h1Available = half == 1 && (row.state().equals(S_FIRST_HALF)
                || HALFTIME_STATES.contains(row.state())
                || row.state().equals(S_GEN2)
                || row.state().equals(S_SECOND_HALF));
        boolean h2Available = half == 2 && row.state().equals(S_SECOND_HALF);
        boolean allowed = h1Available || h2Available || row.state().equals(S_FINISHED);
        if (!allowed) {
            throw invalidState(row.state(), "halves/" + half + "/log");
        }
        return jdbcClient.sql("SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half)
                .query(String.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("해당 half 로그가 없습니다"));
    }

    /**
     * 매치 결과.
     *
     * <p>{@code dailyReward}(#368)는 그 판이 소비한 <b>오늘의 보상 칸</b>이다(리그 매치만, 아니면 null).
     * ⚠️ {@code pointsAwarded} 로 대신할 수 없다 — 그건 {@code reason LIKE 'reward_%'} 합계라
     * ① 다이아 칸에서는 항상 0이고 ② <b>어느 재화인지 말하지 못한다</b>(#232: 금액과 재화는 같이 온다).
     * 소멸한 칸도 {@code awarded=false} 로 실어 보낸다 — 화면이 "얼마를 날렸는지" 말해야 유저가
     * 칸이 소비됐다는 걸 안다.
     */
    /**
     * @param rewardBundle #405 W2b §2.9 <b>additive</b> — 재화/성장을 한 장으로 묶은 보상 봉투.
     *     W2b 이전에 끝난 매치는 {@code null} 이다(봉투가 없다). 구 클라는 이 필드를 무시하면
     *     그만이라 배포 순서 결합이 없다(#368 선례).
     * @param missions #408 additive — <b>이 경기가 원정 데일리 미션을 얼마나 밀었나</b>. 구 클라는
     *                 필드를 무시하면 그만이라 배포 순서 결합이 없다(#368 {@code dailyReward} 와 같은 규율).
     *                 원정이 아닌 경기·미션이 없는 유저는 빈 배열이다.
     */
    public record MatchResult(String matchId, int scoreHome, int scoreAway, String result,
                               long pointsAwarded, Map<String, Object> teamStats,
                               List<Map<String, Object>> playerStats,
                               online.hmb.league.LeagueDailyRewardService.SlotRow dailyReward,
                               online.hmb.rewards.RewardBundleService.Bundle rewardBundle,
                               List<online.hmb.mission.MissionService.MatchMissionView> missions) {
    }

    public MatchResult result(String userId, String matchId) {
        MatchRow row = getViewable(userId, matchId);   // #245: 수비자 관전(읽기 전용)
        if (!row.state().equals(S_FINISHED)) {
            throw invalidState(row.state(), "result");
        }

        long pointsAwarded = jdbcClient.sql("""
                        SELECT COALESCE(SUM(delta), 0) FROM point_ledger
                        WHERE user_id = ? AND ref_id = ? AND reason LIKE 'reward_%'
                        """)
                .params(userId, matchId)
                .query(Long.class)
                .single();

        // 팀/선수 스탯 — 저장된 h1+h2 MatchLog events에서 파생 (최소 스펙, 상세는 뷰어/웹 몫)
        Map<String, Long> teamCounters = new LinkedHashMap<>();
        Map<String, Map<String, Object>> perPlayer = new LinkedHashMap<>();
        for (int half = 1; half <= 2; half++) {
            String logJson = jdbcClient.sql(
                            "SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                    .params(matchId, half)
                    .query(String.class)
                    .optional()
                    .orElse(null);
            if (logJson == null) {
                continue;
            }
            for (JsonNode event : readJson(logJson).path("events")) {
                String type = event.path("type").asText();
                String team = event.path("team").asText("");
                if (List.of("shot", "goal", "pass", "save", "foul").contains(type) && !team.isEmpty()) {
                    teamCounters.merge(team + "_" + type + "s", 1L, Long::sum);
                }
                String playerId = event.path("playerId").asText("");
                if (!playerId.isEmpty() && List.of("shot", "goal", "pass", "save").contains(type)) {
                    Map<String, Object> stats = perPlayer.computeIfAbsent(playerId, id -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("playerId", id);
                        return m;
                    });
                    stats.merge(type + "s", 1L, (a, b) -> ((Number) a).longValue() + 1);
                }
            }
        }

        // ⚠️ 미션은 **보는 사람 기준**으로 좁힌다(#408). 이 GET 은 원정 수비자에게도 열려 있어서
        // (getViewable, #245) 좁히지 않으면 공격자의 미션 진행도가 상대에게 그대로 나간다 —
        // "권한 확대는 읽기냐 쓰기냐만이 아니라 무엇을 읽느냐도 좁혀야 한다"(#245 BL-1).
        return new MatchResult(matchId, row.scoreHome(), row.scoreAway(), row.result(),
                pointsAwarded, Map.copyOf(teamCounters), List.copyOf(perPlayer.values()),
                dailyRewardService.slotOfMatch(matchId).orElse(null),
                // ⚠️ 봉투는 **매치 소유자**의 것이다 — 관전(수비자)에는 남의 보상이 보이면 안 된다.
                rewardBundleService.ofMatch(row.userId(), matchId).orElse(null),
                missionService.progressOf(matchId, userId));
    }

    // ── 스냅샷/JSON 헬퍼 ────────────────────────────────────────────────

    public Set<String> snapshotPlayerIds(MatchRow row) {
        JsonNode snapshot = readJson(row.userDeckJson());
        Set<String> ids = new HashSet<>();
        snapshot.path("starters").forEach(s -> ids.add(s.path("playerId").asText()));
        snapshot.path("bench").forEach(s -> ids.add(s.path("playerId").asText()));
        return ids;
    }

    public JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 파싱 실패: " + e.getMessage(), e);
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
