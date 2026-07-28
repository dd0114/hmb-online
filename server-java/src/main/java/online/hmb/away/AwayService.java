package online.hmb.away;

import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.Hashes;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.match.MatchService;
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
    private final TxRunner txRunner;
    private final SecureRandom secureRandom = new SecureRandom();

    private final int ratingWin;
    private final int ratingDraw;
    private final int ratingLoss;
    private final int reportListLimit;

    public AwayService(JdbcClient jdbcClient,
                       MatchService matchService,
                       DeckService deckService,
                       DeckSnapshot deckSnapshot,
                       RatingService ratingService,
                       TxRunner txRunner,
                       @Value("${hmb.away.rating.win}") int ratingWin,
                       @Value("${hmb.away.rating.draw}") int ratingDraw,
                       @Value("${hmb.away.rating.loss}") int ratingLoss,
                       @Value("${hmb.away.report-list-limit}") int reportListLimit) {
        this.jdbcClient = jdbcClient;
        this.matchService = matchService;
        this.deckService = deckService;
        this.deckSnapshot = deckSnapshot;
        this.ratingService = ratingService;
        this.txRunner = txRunner;
        this.ratingWin = ratingWin;
        this.ratingDraw = ratingDraw;
        this.ratingLoss = ratingLoss;
        this.reportListLimit = reportListLimit;
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
        String target = defenderId == null ? pickDefender(attackerId) : defenderId;
        if (target.equals(attackerId)) {
            throw ApiException.validation("자기 자신에게 원정을 갈 수 없습니다");
        }
        String nickname = jdbcClient.sql("SELECT nickname FROM users WHERE id = ?")
                .param(target).query(String.class).optional()
                .orElseThrow(() -> ApiException.notFound("상대를 찾을 수 없습니다"));

        String ghostBotId = bakeGhost(target, nickname);
        return matchService.createAwayMatch(attackerId, ghostBotId, target);
    }

    /**
     * 상대 후보 = <b>활성 덱을 가진 다른 유저</b>. 무작위 선택은 게임 결정론 계약 밖이라
     * SecureRandom 을 쓴다(BotService.pickRandom 과 같은 근거).
     *
     * <p>덱이 유효하지 않은 후보는 굽는 단계에서 걸러지므로 여기서는 후보를 <b>여러 개</b> 뽑아
     * 순서대로 시도한다 — 한 명 뽑아 실패하면 "상대 없음"으로 오인된다.
     */
    private String pickDefender(String attackerId) {
        List<String> candidates = jdbcClient.sql("""
                        SELECT u.id FROM users u
                        JOIN decks d ON d.user_id = u.id AND d.is_active = 1
                        WHERE u.id <> ?
                        ORDER BY u.id
                        """)
                .param(attackerId)
                .query(String.class)
                .list();
        if (candidates.isEmpty()) {
            throw new ApiException(HttpStatus.NOT_FOUND, "NO_OPPONENT",
                    "원정 갈 상대가 아직 없습니다");
        }
        return candidates.get(secureRandom.nextInt(candidates.size()));
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
        String json = deckSnapshot.json(deck, null);
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
        //    진행 중 매치의 상대가 하프 사이에 바뀐다 — id 가 덱 해시인 이유가 이것이다.
        return botId;
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
            if (attackerDelta != 0) {
                ratingService.apply(attackerId, attackerDelta, REASON_ATTACK, matchId);
            }
            if (defenderDelta != 0) {
                ratingService.apply(challenge.defenderId(), defenderDelta, REASON_DEFENSE, matchId);
            }
        });
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

    public record Report(String id, String matchId, String attackerName, int goalsFor, int goalsAgainst,
                         String result, int ratingDelta, String createdAt, boolean seen) {
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
                        SELECT id, match_id, attacker_name, goals_for, goals_against, result,
                               rating_delta, created_at, seen_at
                        FROM away_reports
                        WHERE defender_id = ? AND (? = 0 OR seen_at IS NULL)
                        ORDER BY created_at DESC
                        LIMIT ?
                        """)
                .params(userId, unseenOnly ? 1 : 0, reportListLimit)
                .query((rs, n) -> new Report(rs.getString("id"), rs.getString("match_id"),
                        rs.getString("attacker_name"), rs.getInt("goals_for"),
                        rs.getInt("goals_against"), rs.getString("result"),
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
            opponents.add(r.attackerName());
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
