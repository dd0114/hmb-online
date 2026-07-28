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
    private final int halftimeSubsMax;
    private final int promptMaxChars;
    private final SecureRandom secureRandom = new SecureRandom();

    public MatchService(JdbcClient jdbcClient,
                        TxRunner txRunner,
                        DeckService deckService,
                        BotService botService,
                        ConditionService conditionService,
                        ObjectMapper objectMapper,
                        DeckSnapshot deckSnapshot,
                        java.time.Clock clock,
                        MatchClockService clockService,
                        online.hmb.away.AwayViewAccess awayViewAccess,
                        @Value("${hmb.match.halftime-subs-max}") int halftimeSubsMax,
                        @Value("${hmb.deck.player-prompt-max-chars}") int promptMaxChars) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.deckService = deckService;
        this.botService = botService;
        this.conditionService = conditionService;
        this.objectMapper = objectMapper;
        this.deckSnapshot = deckSnapshot;
        this.clock = clock;
        this.clockService = clockService;
        this.awayViewAccess = awayViewAccess;
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
                           Integer scoreH2Home, Integer scoreH2Away) {
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
     * 수비자 권한의 근거인 {@code away_reports} 행은 FINISHED 정산에서만 생기므로, 수비자가 여는
     * 매치는 언제나 이미 끝난 경기다.
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
                               score_h2_home, score_h2_away
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
                        (Integer) rs.getObject("score_h2_home"), (Integer) rs.getObject("score_h2_away")))
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
        // 활성 덱 재검증 (AC-S2 규칙 재사용, LLD §5.1)
        DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));
        online.hmb.meta.TeamTactics.validate(teamTactics); // 있으면 0..1 범위

        BotService.BotRow bot = botId == null ? botService.pickRandom() : botService.get(botId);

        String matchId = Ulid.next();
        String seed = randomSeedHex();
        String snapshot = snapshotDeck(deck, teamTactics);
        Instant createdAt = Instant.now(clock);
        String now = createdAt.toString();
        // 컨디션 날짜는 **매치 생성 시각(KST)** 에 앵커 — 킥오프 재캡처가 자정을 넘겨도 같은 시드(아래 참조).
        String conditionsJson =
                computeConditionsJson(userId, conditionService.dateOf(createdAt), rosterPlayerIdsOf(readJson(snapshot)));

        txRunner.run(() -> jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, conditions_json, mode, created_at)
                        VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'practice', ?)
                        """)
                .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, now)
                .update());
        // engine_version='pending' — 실제 EngineConfig.version은 h1 시뮬 응답의
        // matchLog.configVersion으로 갱신된다(러너가 버전의 SoT).

        return getOwned(userId, matchId);
    }

    /**
     * 리그 매치 생성(AC-F2): mode='league' + league_fixture_id 연결. 상대 봇(botTeamId)은 리그 시즌이
     * bots 테이블에 삽입한 봇팀 로스터/성향. 홈/어웨이는 픽스처가 결정하며 오케스트레이터가 반영한다
     * (매치 스냅샷·컨디션·플로우는 연습 매치와 동일 — 여기선 mode/fixture 만 다르다).
     */
    public MatchRow createLeagueMatch(String userId, String botTeamId, String leagueFixtureId) {
        DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));

        BotService.BotRow bot = botService.get(botTeamId);
        String matchId = Ulid.next();
        String seed = randomSeedHex();
        String snapshot = snapshotDeck(deck, null);
        Instant createdAt = Instant.now(clock);
        String now = createdAt.toString();
        String conditionsJson =
                computeConditionsJson(userId, conditionService.dateOf(createdAt), rosterPlayerIdsOf(readJson(snapshot)));

        txRunner.run(() -> jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, conditions_json, mode, league_fixture_id, created_at)
                        VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'league', ?, ?)
                        """)
                .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, leagueFixtureId, now)
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
        DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));

        BotService.BotRow bot = botService.get(ghostBotId);
        String matchId = Ulid.next();
        String seed = randomSeedHex();
        String snapshot = snapshotDeck(deck, null);
        Instant createdAt = Instant.now(clock);
        String now = createdAt.toString();
        String conditionsJson =
                computeConditionsJson(userId, conditionService.dateOf(createdAt), rosterPlayerIdsOf(readJson(snapshot)));

        txRunner.run(() -> {
            jdbcClient.sql("""
                            INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                                user_deck_json, conditions_json, mode, created_at)
                            VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'away', ?)
                            """)
                    .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, now)
                    .update();
            jdbcClient.sql("""
                            INSERT INTO away_challenges(match_id, defender_id, ghost_bot_id, created_at)
                            VALUES (?, ?, ?, ?)
                            """)
                    .params(matchId, defenderId, bot.id(), now)
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

    public record OpponentPlayer(String name, String position, String grade, boolean hasPrompt) {
    }

    public record Opponent(String name, String analysisText, List<OpponentPlayer> deck) {
    }

    /**
     * ownerName(#245 additive) = 이 매치를 만든 유저(홈)의 닉네임. 기존 소비자는 "홈 = 나"라고
     * 가정해도 됐지만, 원정 수비자가 남의 매치를 <b>관전</b>하면서부터는 그 가정이 깨진다
     * (홈은 공격자다). 클라가 자기 닉네임을 홈에 박으면 관전 화면이 양 팀을 바꿔 부른다.
     */
    public record MatchDetail(String id, String state, String failReason, Opponent opponent,
                               Integer scoreH1Home, Integer scoreH1Away,
                               Integer scoreHome, Integer scoreAway,
                               String result, String createdAt, String finishedAt,
                               Map<String, Double> conditions, String mode, String leagueFixtureId,
                               JsonNode userDeckSnapshot, MatchClockService.MatchClock clock,
                               String ownerName) {
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
        return new MatchDetail(detail.id(), detail.state(), detail.failReason(), detail.opponent(),
                detail.scoreH1Home(), detail.scoreH1Away(), detail.scoreHome(), detail.scoreAway(),
                detail.result(), detail.createdAt(), detail.finishedAt(), detail.conditions(),
                detail.mode(), detail.leagueFixtureId(), null, detail.clock(), detail.ownerName());
    }

    public MatchDetail toDetail(MatchRow row) {
        // Phase2 additive(MatchDetailPhase2Fields): conditions/mode/leagueFixtureId — 시계 UI·리그 뱃지용.
        // + userDeckSnapshot(#98 요구 2): 이 매치에 쓴 덱 스냅샷을 읽어서 노출만(저장 로직 변경 0).
        // + clock(P4-E2 #170): 라이브 단계에서만 채워지는 서버 권위 시계.
        String mode = row.mode() == null ? "practice" : row.mode();
        // 스포일러 금지: 전반이 아직 재생 중이면 전반 스코어를 내려주지 않는다(계약상 scoreH1* 은
        // "감독시간 이후"에 채워지는 필드다). 후반 스코어·결과는 FINISHED 전까지 애초에 null 이다.
        boolean h1Live = S_FIRST_HALF.equals(row.state());
        return new MatchDetail(row.id(), row.state(), row.failReason(), buildOpponent(row),
                h1Live ? null : row.scoreH1Home(), h1Live ? null : row.scoreH1Away(),
                row.scoreHome(), row.scoreAway(),
                row.result(), row.createdAt(), row.finishedAt(),
                conditionsOf(row), mode, row.leagueFixtureId(), userDeckSnapshotOf(row),
                clockService.clockOf(row), ownerNameOf(row));
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
        JsonNode deck = readJson(bot.deckJson());
        List<OpponentPlayer> players = new ArrayList<>();
        for (JsonNode starter : deck.path("starters")) {
            String playerId = starter.path("playerId").asText();
            Map<String, String> p = playerNameGrade(playerId);
            players.add(new OpponentPlayer(p.get("name"), p.get("position"), p.get("grade"),
                    starter.hasNonNull("promptText")));
        }
        return new Opponent(bot.name(), bot.analysisText(), players);
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

    public MatchRow submitHalftime(String userId, String matchId, List<Substitution> substitutions) {
        MatchRow row = getOwned(userId, matchId);
        // 전반 중에도 교체를 미리 짜둘 수 있다(P4-E2 #170) — 반영은 후반 시뮬에서.
        if (!PRE_SECOND_HALF_STATES.contains(row.state())) {
            throw invalidState(row.state(), "halftime");
        }
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

        String subsJson = toJson(subs);
        txRunner.run(() -> jdbcClient.sql("""
                        UPDATE matches SET subs_json = ?
                        WHERE id = ? AND state IN ('FIRST_HALF', 'HALFTIME', 'H1_BREAK')
                        """)
                .params(subsJson, matchId)
                .update());
        return getOwned(userId, matchId);
    }

    private static String swapIn(List<Substitution> subs, String outId) {
        return subs.stream().filter(s -> s.out().equals(outId)).findFirst().map(Substitution::in).orElse(outId);
    }

    private static ApiException subsInvalid(String message, Map<String, Object> detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "SUBSTITUTION_INVALID", message, detail);
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

    public record MatchResult(String matchId, int scoreHome, int scoreAway, String result,
                               long pointsAwarded, Map<String, Object> teamStats,
                               List<Map<String, Object>> playerStats) {
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

        return new MatchResult(matchId, row.scoreHome(), row.scoreAway(), row.result(),
                pointsAwarded, Map.copyOf(teamCounters), List.copyOf(perPlayer.values()));
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
