package online.hmb.away;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.Hashes;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.growth.GrowthService;
import online.hmb.match.MatchService;
import online.hmb.match.PromptContextBuilder;
import online.hmb.meta.DeckService;
import online.hmb.meta.DeckSnapshot;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 원정(#245) — <b>실유저 팀을 상대로 하는 비동기 대전</b>과 그 피침공 기록.
 *
 * <p><b>왜 이렇게 붙는가</b>(W1 실사 결론): 이 서버에는 "한 유저의 팀이 남의 상대가 되는" 경로가
 * 애초에 없었다 — {@code matches.bot_id} 는 {@code bots} FK 이고 bots 의 출처는 시드 3종과 리그가
 * 생성한 봇팀뿐이다. 그래서 새 대전 파이프라인을 만드는 대신 <b>리그가 이미 쓰는 패턴</b>을 그대로
 * 쓴다: 리그가 생성 팀을 bots 행으로 구워 물리듯, 원정은 <b>수비자의 덱 스냅샷</b>을 bots 행으로
 * 굽는다. 덕분에 매치 생성·AI 잡·시뮬·정산 파이프라인은 한 줄도 바뀌지 않는다.
 *
 * <p>공짜로 따라오는 것 하나: {@code PromptContextBuilder.buildBotContext} 는 봇 덱 JSON 의
 * {@code promptText} 를 이미 읽는다 → <b>수비자가 써둔 선수별 지시가 그대로 상대의 AI 인풋</b>이
 * 된다. 이 게임의 핵심(선수별 자연어 프롬프트)이 원정에서도 살아 있는 이유다.
 *
 * <p><b>고스트는 덱 해시로 박제한다</b>(bot id = {@code GHOST_<userId>_<deckHash12>}). 덱이 바뀌면
 * 같은 행을 덮는 게 아니라 <b>새 행</b>이 생긴다 — 시뮬은 매 하프 시작 시 봇 덱을 다시 읽으므로,
 * 덮어썼다면 진행 중인 매치의 상대가 전·후반 사이에 바뀌고 재생·재현이 깨진다.
 */
@Service
public class AwayService {

    private static final Logger log = LoggerFactory.getLogger(AwayService.class);

    /** 원정 매치의 상대는 항상 이 접두를 가진 bots 행이다(시드 봇·리그 봇팀과 구분). */
    private static final String GHOST_PREFIX = "GHOST_";

    static final String REASON_ATTACK = "away_attack";
    static final String REASON_DEFENSE = "away_defense";

    private final JdbcClient jdbcClient;
    private final MatchService matchService;
    private final DeckService deckService;
    private final DeckSnapshot deckSnapshot;
    private final RatingService ratingService;
    private final GrowthService growthService;
    private final PromptContextBuilder contextBuilder;
    private final ObjectMapper objectMapper;
    private final TxRunner txRunner;
    private final SecureRandom secureRandom = new SecureRandom();

    private final int ratingWin;
    private final int ratingDraw;
    private final int ratingLoss;
    private final int reportListLimit;
    private final AwaySeasonService seasonService;
    private final online.hmb.meta.WalletService walletService;
    private final online.hmb.catalog.EconomyService economyService;
    private final int candidateCount;
    private final int ratingBand;
    private final int offerTtlSec;
    private final int streakBonusPerWin;
    private final int streakMaxBonus;
    private final String rewardMode;
    private final boolean defenderRewardOnLoss;

    public AwayService(JdbcClient jdbcClient,
                       MatchService matchService,
                       DeckService deckService,
                       DeckSnapshot deckSnapshot,
                       RatingService ratingService,
                       GrowthService growthService,
                       PromptContextBuilder contextBuilder,
                       ObjectMapper objectMapper,
                       TxRunner txRunner,
                       @Value("${hmb.away.rating.win}") int ratingWin,
                       @Value("${hmb.away.rating.draw}") int ratingDraw,
                       @Value("${hmb.away.rating.loss}") int ratingLoss,
                       AwaySeasonService seasonService,
                       online.hmb.meta.WalletService walletService,
                       online.hmb.catalog.EconomyService economyService,
                       @Value("${hmb.away.report-list-limit}") int reportListLimit,
                       @Value("${hmb.away.match.candidate-count}") int candidateCount,
                       @Value("${hmb.away.match.rating-band}") int ratingBand,
                       @Value("${hmb.away.match.offer-ttl-sec}") int offerTtlSec,
                       @Value("${hmb.away.streak.bonus-per-win}") int streakBonusPerWin,
                       @Value("${hmb.away.streak.max-bonus}") int streakMaxBonus,
                       @Value("${hmb.away.reward.mode}") String rewardMode,
                       @Value("${hmb.away.reward.defender-on-loss}") boolean defenderRewardOnLoss) {
        this.jdbcClient = jdbcClient;
        this.matchService = matchService;
        this.deckService = deckService;
        this.deckSnapshot = deckSnapshot;
        this.ratingService = ratingService;
        this.growthService = growthService;
        this.contextBuilder = contextBuilder;
        this.objectMapper = objectMapper;
        this.txRunner = txRunner;
        this.ratingWin = ratingWin;
        this.ratingDraw = ratingDraw;
        this.ratingLoss = ratingLoss;
        this.reportListLimit = reportListLimit;
        this.seasonService = seasonService;
        this.walletService = walletService;
        this.economyService = economyService;
        this.candidateCount = candidateCount;
        this.ratingBand = ratingBand;
        this.offerTtlSec = offerTtlSec;
        this.streakBonusPerWin = streakBonusPerWin;
        this.streakMaxBonus = streakMaxBonus;
        this.rewardMode = rewardMode;
        this.defenderRewardOnLoss = defenderRewardOnLoss;
    }

    // ── 원정 출발 ───────────────────────────────────────────────────────────

    /**
     * 원정 매치 생성. {@code defenderId} 가 null 이면 활성 덱을 가진 다른 유저 중 무작위.
     *
     * <p><b>상대가 없으면 매치를 만들지 않는다</b>(404 NO_OPPONENT). 봇으로 조용히 대체하면
     * "원정 갔는데 사실 봇"이 되고, 피원정이 발생하지 않으니 요구 1·3(리포트·부재중 집계)이
     * 영원히 빈 화면이 된다. 조용한 폴백은 기능을 없애는 것과 같다.
     */
    public MatchService.MatchRow start(String attackerId, String defenderId) {
        // ⚠️ **내 덱을 먼저, 루프 밖에서 검증한다**(독립검증 4R blocker). 이걸 루프 안에 두면
        // 공격자 자기 덱 오류(트레이드로 넘긴 선수가 deck_slots 에 남음·활성 덱 없음)가 후보마다
        // 똑같이 터지고, 루프가 그걸 전부 삼켜 **404 NO_OPPONENT** 으로 뒤집힌다 — 덱이 문제인데
        // "상대가 없다"고 말하는, 유저가 할 수 있는 게 0인 막다른 토스트다(#217 이 금지한 형태).
        // 게다가 그 실패 1회가 **후보 수만큼 고스트 INSERT** 를 남긴다(실측 14행/1회, 회수 경로 없음).
        DeckService.DeckResponse myDeck = deckService.getActiveDeck(attackerId);
        deckService.validate(attackerId, new DeckService.DeckUpdateRequest(myDeck.formation(), myDeck.slots()));

        if (defenderId != null) {
            if (defenderId.equals(attackerId)) {
                throw ApiException.validation("자기 자신에게 원정을 갈 수 없습니다");
            }
            // hero E2: 고르는 건 되지만 **제시된 것 중에서만**. 이 한 줄이 "2택"과 "지목"을 가른다.
            assertOffered(attackerId, defenderId);
            return startAgainst(attackerId, defenderId);
        }
        List<String> pool = new ArrayList<>(candidates(attackerId));
        if (pool.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT", "원정 갈 상대가 아직 없습니다");
        }
        // 결정론 계약 밖(매칭 무작위) — BotService.pickRandom 과 같은 근거로 SecureRandom.
        java.util.Collections.shuffle(pool, secureRandom);

        // ⚠️ 루프가 하는 일은 **상대를 고르는 것뿐**이다. 내 매치 생성은 루프가 끝난 뒤 밖에서 한다 —
        // 안에 두면 덱이 아닌 실패(봇 조회·컨디션 계산·INSERT 경합)까지 catch 에 삼켜져 다시
        // 404 NO_OPPONENT 으로 뒤집히고 후보마다 고스트가 구워진다(4R blocker 의 형태).
        // 이걸 "정리"한다며 루프 안으로 되돌리지 마라 — 구조가 곧 방어다.
        String chosen = null;
        String ghostBotId = null;
        ApiException last = null;
        for (String candidate : pool) {
            try {
                ghostBotId = bakeGhost(candidate, nicknameOf(candidate));
                chosen = candidate;
                break;
            } catch (ApiException e) {
                // 삼키는 것은 **그 후보를 세울 수 없다**는 실패뿐이다.
                log.warn("away opponent candidate {} unusable ({}) — trying next", candidate, e.getMessage());
                last = e;
            }
        }
        if (chosen == null) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT",
                    "원정 갈 상대가 아직 없습니다"
                            + (last == null ? "" : " (마지막 후보 사유: " + last.getMessage() + ")"));
        }
        return matchService.createAwayMatch(attackerId, ghostBotId, chosen);
    }

    private String nicknameOf(String userId) {
        return jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(userId).query(String.class).optional()
                .orElseThrow(() -> ApiException.notFound("상대를 찾을 수 없습니다"));
    }

    private MatchService.MatchRow startAgainst(String attackerId, String defenderId) {
        return matchService.createAwayMatch(attackerId,
                bakeGhost(defenderId, nicknameOf(defenderId)), defenderId);
    }

    public record Candidate(String userId, String nickname, int rating, int power) {
    }

    /**
     * 상대 후보 제시(hero E2/E3) — <b>레이팅이 비슷한 사람 중 무작위 N명</b>을 뽑아 보여주고,
     * 그 목록을 서버가 기억한다.
     *
     * <p>왜 기억하나: 클라가 보낸 id 를 그대로 믿으면 그건 <b>지목 원정</b>이고, 부계정을 반복 지목해
     * 레이팅을 무한 생성하는 경로가 열린다(4R MAJ-4 가 막은 그것). "2명 중 택1"은 제시가 서버 것일 때만
     * 성립한다. 유저당 1행이라 새로 뽑으면 이전 제시는 무효 — 리롤로 후보를 쌓지 못한다.
     *
     * <p>밴드는 <b>단계적으로 넓힌다</b>: 오픈베타처럼 인원이 적을 때 밴드만 고집하면 "상대 없음"이
     * 되는데, 그건 매칭 실패보다 나쁘다.
     */
    public List<Candidate> offerCandidates(String attackerId) {
        int myRating = ratingService.rating(attackerId);
        List<Candidate> pool = List.of();
        for (int widen = 1; widen <= 4 && pool.size() < candidateCount; widen++) {
            pool = candidatesInBand(attackerId, myRating, (long) ratingBand * widen);
        }
        if (pool.isEmpty()) {
            pool = candidatesInBand(attackerId, myRating, Long.MAX_VALUE / 4);   // 마지막엔 전체
        }
        if (pool.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT", "원정 갈 상대가 아직 없습니다");
        }
        List<Candidate> shuffled = new ArrayList<>(pool);
        java.util.Collections.shuffle(shuffled, secureRandom);
        List<Candidate> offered = shuffled.subList(0, Math.min(candidateCount, shuffled.size()));

        List<String> ids = offered.stream().map(Candidate::userId).toList();
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, toJson(ids), Instant.now().toString())
                .update();
        return List.copyOf(offered);
    }

    private List<Candidate> candidatesInBand(String attackerId, int myRating, long band) {
        return jdbcClient.sql("""
                        SELECT u.id AS id, u.nickname AS nickname,
                               COALESCE(r.rating, 0) AS rating
                        FROM users u
                        JOIN decks d ON d.user_id = u.id AND d.is_active = 1
                        LEFT JOIN user_ratings r ON r.user_id = u.id
                        WHERE u.id <> ? AND ABS(COALESCE(r.rating, 0) - ?) <= ?
                        ORDER BY u.id
                        """)
                .params(attackerId, myRating, band)
                .query((rs, n) -> new Candidate(rs.getString("id"), rs.getString("nickname"),
                        rs.getInt("rating"), 0))
                .list();
    }

    private String toJson(List<String> ids) {
        try {
            return objectMapper.writeValueAsString(ids);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 방금 제시한 후보인가 — 아니면 지목이다(거부). TTL 을 넘긴 제시도 무효. */
    private void assertOffered(String attackerId, String defenderId) {
        record Offer(String candidates, String createdAt) {
        }
        Offer offer = jdbcClient.sql("SELECT candidates, created_at FROM away_offers WHERE user_id = ?")
                .param(attackerId)
                .query((rs, n) -> new Offer(rs.getString("candidates"), rs.getString("created_at")))
                .optional()
                .orElseThrow(() -> ApiException.validation("먼저 상대 목록을 받아야 합니다"));
        if (Instant.parse(offer.createdAt()).plusSeconds(offerTtlSec).isBefore(Instant.now())) {
            throw ApiException.validation("상대 목록이 만료됐습니다 — 다시 불러 주세요");
        }
        try {
            JsonNode arr = objectMapper.readTree(offer.candidates());
            for (JsonNode id : arr) {
                if (defenderId.equals(id.asText())) {
                    return;
                }
            }
        } catch (Exception e) {
            throw ApiException.validation("상대 목록을 읽을 수 없습니다 — 다시 불러 주세요");
        }
        // 제시하지 않은 상대다 = 지목 시도.
        throw ApiException.validation("제시된 상대 중에서만 고를 수 있습니다");
    }

    private List<String> candidates(String attackerId) {
        return jdbcClient.sql("""
                        SELECT u.id FROM users u
                        JOIN decks d ON d.user_id = u.id AND d.is_active = 1
                        WHERE u.id <> ?
                        ORDER BY u.id
                        """)
                .param(attackerId)
                .query(String.class)
                .list();
    }

    /**
     * 수비자의 현재 덱을 고스트 bots 행으로 굽는다(이미 있으면 그대로 쓴다 — id 가 덱 해시라
     * 같은 덱이면 같은 행이다).
     *
     * <p>스냅샷 직렬화는 {@link DeckSnapshot} <b>한 곳</b>을 쓴다(#215 계약) — 매치 스냅샷과 같은
     * 바이트여야 A(베이스) 캐시가 맞는다.
     */
    private String bakeGhost(String defenderId, String nickname) {
        DeckService.DeckResponse deck = deckService.getActiveDeck(defenderId);
        // 상대로 세우기 전에 규칙 검증 — 깨진 덱(선발 부족 등)으로 시뮬을 태우면 매치가 GEN 에서 죽는다.
        deckService.validate(defenderId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));
        // 팀 전술은 덱이 아니라 브리핑에서 정해지는 값이라(수비자는 브리핑에 없다) null 이다.
        String json = withFrozenAttributes(defenderId, deckSnapshot.json(deck, null));
        String botId = GHOST_PREFIX + defenderId + "_" + Hashes.sha256Hex(json).substring(0, 12);

        jdbcClient.sql("""
                        INSERT INTO bots(id, name, persona, analysis_text, deck_json)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(id) DO UPDATE SET name = excluded.name
                        """)
                .params(botId, nickname, "",
                        nickname + " 감독의 실제 팀입니다. 선수별 지시가 그대로 적용됩니다.", json)
                .update();
        // ⚠️ 갱신하는 것은 name(닉네임 변경 반영)뿐이다. deck_json 을 덮으면 이 행을 쓰고 있는
        //    진행 중 매치의 상대가 하프 사이에 바뀐다 — id 가 내용 해시인 이유가 이것이다.
        return botId;
    }

    /**
     * 고스트 덱에 <b>수비자의 성장·강화 유효스탯을 박아 넣는다</b>(#245 MAJ-3).
     *
     * <p>왜: 봇 로스터는 {@code players} 카탈로그 원본 능력치로 선다(MatchOrchestrator.teamRoster 의
     * {@code growthUserId=null}). 그대로 두면 "상대는 실유저 팀"이라면서 <b>그 유저가 키운 스탯이 빠진
     * 약화판</b>이 서고, 그 결과로 수비자가 −10 을 먹는다. 레이팅이 경쟁 축인 이상 이건 계산이 틀린 것이다.
     *
     * <p>왜 <b>박아서 얼리나</b>(시뮬 시점에 조회하지 않고): 수비자는 이 매치에 대해 잠기지 않는다
     * (#217 의 growth 잠금은 <b>자기</b> 매치에만 걸린다). 시뮬 때 현재 스탯을 읽으면 수비자가 전·후반
     * 사이에 강화해 후반 스탯만 올릴 수 있고 — #217 이 잠금으로 막는 바로 그 버그다 — 재생·재현도
     * 깨진다. 값이 덱 JSON 에 들어가면 <b>해시가 그 값까지 덮으므로</b> 강화는 "다음 고스트"를 만들 뿐
     * 진행 중인 매치를 건드리지 못한다(공격자 스냅샷과 같은 규율).
     */
    private String withFrozenAttributes(String defenderId, String snapshotJson) {
        try {
            ObjectNode root = (ObjectNode) objectMapper.readTree(snapshotJson);
            for (String group : List.of("starters", "bench")) {
                for (JsonNode slot : root.path(group)) {
                    if (!slot.isObject() || !slot.path("playerId").isTextual()) {
                        continue;
                    }
                    String playerId = slot.path("playerId").asText();
                    Map<String, Object> base = contextBuilder.catalogAttributes(playerId);
                    if (base == null) {
                        continue;   // 카탈로그에 없는 선수 — 시뮬이 어차피 거른다
                    }
                    ((ObjectNode) slot).set("attributes", objectMapper.valueToTree(
                            growthService.effectiveAttributes(defenderId, playerId, base)));
                }
            }
            return root.toString();
        } catch (Exception e) {
            // 유효스탯을 못 실어도 원정 자체를 막지는 않는다(원본 능력치로 선다) — 다만 조용히 넘어가지
            // 않는다. 이 경고가 잦으면 수비자가 계속 약체로 서고 있다는 뜻이다.
            log.warn("ghost effective attributes unavailable for {} — falling back to catalog stats",
                    defenderId, e);
            return snapshotJson;
        }
    }

    /** 이 매치에서 원정을 당한 쪽(있으면). 시뮬이 고스트 로스터를 조립할 때 쓴다. */
    public java.util.Optional<String> defenderOf(String matchId) {
        return findChallenge(matchId).map(Challenge::defenderId);
    }

    // ── 정산 (FINISHED CAS 통과 후 1회) ─────────────────────────────────────

    /**
     * 원정 결과를 수비자 리포트 + 양쪽 레이팅으로 정산한다(hero Q3: 공격자·수비자 <b>둘 다</b> ±10).
     *
     * <p>멱등: 리포트는 {@code away_reports.match_id} UNIQUE, 레이팅은 원장 유니크가 막는다.
     * 호출자({@code MatchOrchestrator.finishMatch})가 이미 FINISHED CAS 를 통과한 경로지만,
     * 정산 재시도·경합에서도 두 번 반영되지 않아야 한다.
     *
     * @param attackerGoals 공격자(=매치 소유자) 득점 · @param defenderGoals 수비자 득점
     */
    public void settle(String matchId, String attackerId, String attackerResult,
                       int attackerGoals, int defenderGoals) {
        Challenge challenge = findChallenge(matchId).orElse(null);
        if (challenge == null) {
            // mode='away' 인데 도전장이 없다 = 데이터 사고. 조용히 넘어가면 수비자는 영영 모른다.
            log.warn("away match {} has no challenge row — report/rating skipped", matchId);
            return;
        }
        String defenderResult = mirror(attackerResult);
        int attackerDelta = deltaFor(attackerResult);
        int defenderDelta = deltaFor(defenderResult);
        String attackerName = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(attackerId).query(String.class).optional().orElse("상대");

        txRunner.run(() -> {
            int inserted = jdbcClient.sql("""
                            INSERT OR IGNORE INTO away_reports(
                                id, match_id, defender_id, attacker_id, attacker_name,
                                goals_for, goals_against, result, rating_delta, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """)
                    .params(Ulid.next(), matchId, challenge.defenderId(), attackerId, attackerName,
                            defenderGoals, attackerGoals, defenderResult, defenderDelta,
                            Instant.now().toString())
                    .update();
            if (inserted == 0) {
                return; // 이미 정산됨
            }
            // 연승 보너스(hero E4) — 이긴 쪽만. 먼저 연승을 갱신하고 그 값으로 보너스를 계산한다.
            int attackerBonus = applyStreak(attackerId, attackerResult);
            int defenderBonus = applyStreak(challenge.defenderId(), defenderResult);
            if (attackerDelta != 0 || attackerBonus != 0) {
                ratingService.apply(attackerId, attackerDelta + attackerBonus, REASON_ATTACK, matchId);
            }
            if (defenderDelta != 0 || defenderBonus != 0) {
                ratingService.apply(challenge.defenderId(), defenderDelta + defenderBonus,
                        REASON_DEFENSE, matchId);
            }
            // 수비자 보상(hero E7) — "덱 세팅 잘해두면 돈이 들어오고, 지면 남 좋은 일만".
            // 공격자 보상은 매치 정산(MatchOrchestrator)이 이미 준다 — 여기서 또 주면 이중 지급이다.
            payDefender(challenge.defenderId(), defenderResult, matchId);
        });
    }

    /**
     * 연승 갱신 + 이번 판 보너스(hero E4). 승리면 +1, 패배면 0 으로 끊고, <b>무승부는 유지</b>한다 —
     * 비긴 걸로 연승이 깨지면 방어 성공이 손해가 된다.
     *
     * @return 이번 판에 얹을 추가 레이팅(2연승부터, 상한 있음). 승리가 아니면 0.
     */
    private int applyStreak(String userId, String result) {
        String now = Instant.now().toString();
        if ("LOSS".equals(result)) {
            jdbcClient.sql("""
                            INSERT INTO away_streaks(user_id, streak, best_streak, updated_at)
                            VALUES (?, 0, 0, ?)
                            ON CONFLICT(user_id) DO UPDATE SET streak = 0, updated_at = excluded.updated_at
                            """)
                    .params(userId, now)
                    .update();
            return 0;
        }
        if (!"WIN".equals(result)) {
            return 0;   // 무승부 — 유지
        }
        jdbcClient.sql("""
                        INSERT INTO away_streaks(user_id, streak, best_streak, updated_at)
                        VALUES (?, 1, 1, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          streak = away_streaks.streak + 1,
                          best_streak = MAX(away_streaks.best_streak, away_streaks.streak + 1),
                          updated_at = excluded.updated_at
                        """)
                .params(userId, now)
                .update();
        int streak = jdbcClient.sql("SELECT streak FROM away_streaks WHERE user_id = ?")
                .param(userId).query(Integer.class).optional().orElse(1);
        return Math.min(Math.max(streak - 1, 0) * streakBonusPerWin, streakMaxBonus);
    }

    /**
     * 수비자 보상(hero E6/E7): 금액 곡선은 <b>리그 한 판과 같게</b>({@code hmb.away.reward.mode}).
     * 패배는 기본 0 — hero 의 "지면 남 좋은 일만 하는 구조" 를 그대로 옮긴 것이다.
     *
     * <p>값 자체는 data 발행물(economy)이 소유한다. economy 에 away 키를 새로 만들지 않는 이유는
     * {@code data/**} 가 이 모듈 소유가 아니고, "리그와 같게"라는 지시는 값 복제가 아니라 <b>참조</b>로
     * 표현하는 게 정확하기 때문이다(값이 바뀌면 같이 따라간다).
     */
    private void payDefender(String defenderId, String defenderResult, String matchId) {
        if ("LOSS".equals(defenderResult) && !defenderRewardOnLoss) {
            return;
        }
        economyService.get().ifPresentOrElse(economy -> {
            int amount = economy.rewards().forMode(rewardMode).by(defenderResult);
            if (amount != 0) {
                walletService.apply(defenderId, amount, "away_defense_reward", matchId);
            }
        }, () -> log.warn("economy unavailable — away defender reward skipped (match={})", matchId));
    }

    private int deltaFor(String result) {
        return switch (result) {
            case "WIN" -> ratingWin;
            case "LOSS" -> ratingLoss;
            default -> ratingDraw;
        };
    }

    private static String mirror(String result) {
        return switch (result) {
            case "WIN" -> "LOSS";
            case "LOSS" -> "WIN";
            default -> "DRAW";
        };
    }

    record Challenge(String matchId, String defenderId, String ghostBotId) {
    }

    private java.util.Optional<Challenge> findChallenge(String matchId) {
        return jdbcClient.sql("SELECT match_id, defender_id, ghost_bot_id FROM away_challenges WHERE match_id = ?")
                .param(matchId)
                .query((rs, n) -> new Challenge(rs.getString("match_id"), rs.getString("defender_id"),
                        rs.getString("ghost_bot_id")))
                .optional();
    }

    // ── 리포트 조회 / 확인 ──────────────────────────────────────────────────

    /** attackerId 는 집계 전용(닉 변경에도 "몇 팀"이 흔들리지 않게) — 화면은 attackerName 을 쓴다. */
    public record Report(String id, String matchId, String attackerId, String attackerName,
                         int goalsFor, int goalsAgainst, String result, int ratingDelta,
                         String createdAt, boolean seen) {
    }

    /**
     * 부재중 요약(요구 3). <b>서버가 계산해서 준다</b> — 클라가 같은 집계를 다시 구현하면 규칙이
     * 바뀔 때 조용히 어긋난다(#217 에서 확인된 원칙).
     *
     * @param opponents 서로 다른 상대 팀 수("몇 팀과 붙었나")
     */
    public record Summary(int matches, int opponents, int wins, int draws, int losses,
                          int goalsFor, int goalsAgainst, int ratingDelta) {
    }

    public record ReportsResponse(List<Report> reports, Summary summary, int rating, int unseen) {
    }

    /**
     * @param status {@code "unseen"}(기본, 팝업 대상) 또는 {@code "all"}(전적 화면).
     *     요약은 <b>목록과 같은 범위</b>로 계산한다 — 화면의 리스트와 헤드라인이 어긋나면 안 된다.
     */
    public ReportsResponse reports(String userId, String status) {
        boolean unseenOnly = !"all".equalsIgnoreCase(status);
        List<Report> rows = jdbcClient.sql("""
                        SELECT id, match_id, attacker_id, attacker_name, goals_for, goals_against,
                               result, rating_delta, created_at, seen_at
                        FROM away_reports
                        WHERE defender_id = ? AND (? = 0 OR seen_at IS NULL)
                        ORDER BY created_at DESC
                        LIMIT ?
                        """)
                .params(userId, unseenOnly ? 1 : 0, reportListLimit)
                .query((rs, n) -> new Report(rs.getString("id"), rs.getString("match_id"),
                        rs.getString("attacker_id"), rs.getString("attacker_name"),
                        rs.getInt("goals_for"), rs.getInt("goals_against"), rs.getString("result"),
                        rs.getInt("rating_delta"), rs.getString("created_at"),
                        rs.getString("seen_at") != null))
                .list();
        return new ReportsResponse(rows, summarize(rows), ratingService.rating(userId),
                (int) unseenCount(userId));
    }

    private Summary summarize(List<Report> rows) {
        Set<String> opponents = new LinkedHashSet<>();
        int wins = 0;
        int draws = 0;
        int losses = 0;
        int goalsFor = 0;
        int goalsAgainst = 0;
        int ratingDelta = 0;
        for (Report r : rows) {
            // ⚠️ 닉네임이 아니라 id 로 센다 — 상대가 닉을 바꾸면 같은 사람이 "2팀"이 된다(5R MIN-7).
            opponents.add(r.attackerId());
            switch (r.result()) {
                case "WIN" -> wins++;
                case "LOSS" -> losses++;
                default -> draws++;
            }
            goalsFor += r.goalsFor();
            goalsAgainst += r.goalsAgainst();
            ratingDelta += r.ratingDelta();
        }
        return new Summary(rows.size(), opponents.size(), wins, draws, losses,
                goalsFor, goalsAgainst, ratingDelta);
    }

    /** 현재 연승(표시용). 행이 없으면 0. */
    public int streakOf(String userId) {
        return jdbcClient.sql("SELECT streak FROM away_streaks WHERE user_id = ?")
                .param(userId).query(Integer.class).optional().orElse(0);
    }

    public long unseenCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND seen_at IS NULL")
                .param(userId)
                .query(Long.class)
                .single();
    }

    /**
     * 확인 처리(팝업 [확인]). {@code ids} 가 비면 미확인 전부.
     *
     * <p>멱등: {@code seen_at IS NULL} 조건이 갱신 대상을 좁히므로 두 탭이 동시에 확인해도 한 번만
     * 처리되고, 두 번째 호출은 <b>실패가 아니라 0건</b>이다(에러로 만들면 화면이 이유 없이 붉어진다).
     */
    public int ack(String userId, List<String> ids) {
        if (ids == null || ids.isEmpty()) {
            return jdbcClient.sql("""
                            UPDATE away_reports SET seen_at = ?
                            WHERE defender_id = ? AND seen_at IS NULL
                            """)
                    .params(Instant.now().toString(), userId)
                    .update();
        }
        if (ids.size() > reportListLimit) {
            // 클라가 보낼 수 있는 목록은 화면에 그린 것뿐이다(= 최대 한 창). 그보다 길면 요청이
            // 잘못된 것이지 수행할 일이 아니다 — 상한이 없으면 길이만큼 UPDATE 가 그대로 실행된다.
            throw ApiException.validation("한 번에 확인할 수 있는 리포트 수를 넘었습니다");
        }
        int acked = 0;
        String now = Instant.now().toString();
        for (String id : new ArrayList<>(ids)) {
            acked += jdbcClient.sql("""
                            UPDATE away_reports SET seen_at = ?
                            WHERE id = ? AND defender_id = ? AND seen_at IS NULL
                            """)
                    .params(now, id, userId)
                    .update();
        }
        return acked;
    }

}
