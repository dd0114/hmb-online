package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #245 원정(피침공) 리포트·레이팅 — 계약.
 *
 * <p>hero 확정(2026-07-28): 별도 '원정' 모드 · 신규 rating 축 초기 0(하한 없음) ·
 * 공격자/수비자 <b>둘 다 ±10</b> · 수비자도 경기 관전.
 *
 * <p>이 클래스가 지키는 핵심 불변:
 * <ol>
 *   <li><b>상대는 진짜 실유저 팀이다</b> — 봇으로 조용히 대체하지 않는다. 대상이 없으면 매치를
 *       만들지 않는다(NO_OPPONENT). 여기서 봇 폴백을 허용하면 "원정 갔는데 사실 봇"이 되고
 *       요구 1·3(피원정 리포트)이 영영 발생하지 않는다.</li>
 *   <li><b>정산은 멱등</b> — 리포트는 매치당 1행, 레이팅은 매치당 1회. 원장 유니크가 최종 방어선.</li>
 *   <li><b>수비자에게 열리는 것은 읽기뿐</b> — 관전은 되고 쓰기는 404. 권한의 근거는 리포트 행이며
 *       리포트는 FINISHED 에서만 생기므로 <b>진행 중 매치는 애초에 볼 수 없다</b>.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class AwayRaidTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    // ── AC1: 원정 상대 = 실유저 덱 고스트 ────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void awayMatchOpponentIsAnotherUsersDeck() {
        setupUserWithDeck("aw_def1");
        String defenderId = userIdOf("aw_def1");
        String attacker = setupUserWithDeck("aw_atk1");

        // ⚠️ 상대를 **지목**한다. 이 클래스는 DB 를 공유하므로 무작위 선택은 다른 테스트 메서드가
        // 만든 유저도 고른다 — 무작위성 자체는 randomOpponentIsSomeOtherRealUser 가 따로 검증한다.
        ResponseEntity<Map> res = authPost("/api/away/matches", attacker,
                Map.of("defenderId", defenderId), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) res.getBody().get("id");

        assertThat(res.getBody().get("mode")).isEqualTo("away");
        // 상대 이름 = 수비자 닉네임(봇 이름이 아니다) — 공격자 화면이 "누구를 치러 가는지" 말해야 한다.
        assertThat(((Map<String, Object>) res.getBody().get("opponent")).get("name")).isEqualTo("aw_def1");

        // 도전장이 수비자 귀속을 소유한다(matches.user_id 는 공격자다).
        String recorded = jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                .param(matchId).query(String.class).single();
        assertThat(recorded).isEqualTo(defenderId);

        // 고스트 봇의 덱 = 수비자의 실제 덱. 선수별 지시(promptText)까지 그대로 넘어가야
        // 상대 AI 인풋이 "수비자가 써둔 지시"로 만들어진다(buildBotContext 가 그걸 읽는다).
        String ghostDeck = jdbcClient.sql("SELECT b.deck_json FROM bots b "
                        + "JOIN matches m ON m.bot_id = b.id WHERE m.id = ?")
                .param(matchId).query(String.class).single();
        assertThat(ghostDeck).contains("P001").contains("\"formation\":\"4-4-2\"");
    }

    /** 고스트 봇 행은 덱 해시로 박제된다 — 수비자가 덱을 바꿔도 진행 중인 매치의 상대가 변하지 않는다. */
    @SuppressWarnings("unchecked")
    @Test
    void ghostIsFrozenPerDeckSoInFlightMatchKeepsItsOpponent() {
        setupUserWithDeck("aw_def_frozen");
        String attacker = setupUserWithDeck("aw_atk_frozen");

        ResponseEntity<Map> res = authPost("/api/away/matches", attacker,
                Map.of("defenderId", userIdOf("aw_def_frozen")), Map.class);
        String matchId = (String) res.getBody().get("id");
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        String deckBefore = jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();

        // 수비자가 덱을 바꾼다(벤치 프롬프트 변경).
        String defenderToken = login("aw_def_frozen");
        java.util.List<Map<String, Object>> slots = new java.util.ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "완전히 다른 지시"));
        authPut("/api/deck", defenderToken, deckBody("4-4-2", slots), Map.class);

        String deckAfter = jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();
        assertThat(deckAfter).isEqualTo(deckBefore);
    }

    /** 지목하지 않으면 상대는 **다른 실유저** 중에서 골라진다(봇도, 자기 자신도 아니다). */
    @SuppressWarnings("unchecked")
    @Test
    void randomOpponentIsSomeOtherRealUser() {
        setupUserWithDeck("aw_pool1");
        setupUserWithDeck("aw_pool2");
        String attacker = setupUserWithDeck("aw_atk_rand");
        String attackerId = userIdOf("aw_atk_rand");

        ResponseEntity<Map> res = authPost("/api/away/matches", attacker, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) res.getBody().get("id");

        String defenderId = jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                .param(matchId).query(String.class).single();
        assertThat(defenderId).isNotEqualTo(attackerId);
        // 실유저다 — 고스트 봇은 그 유저의 덱에서 구워진 행이어야 한다.
        long isRealUser = jdbcClient.sql("SELECT COUNT(*) FROM users WHERE id = ?")
                .param(defenderId).query(Long.class).single();
        assertThat(isRealUser).isEqualTo(1);
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(botId).startsWith("GHOST_" + defenderId);
    }

    // ── AC2: 대상이 없으면 봇으로 대체하지 않는다 ─────────────────────────────

    @Test
    void noOpponentWhenNobodyElseHasADeck() {
        // 이 유저 말고는 활성 덱을 가진 상대가 없도록 다른 덱을 잠시 비활성화한다.
        String lonely = setupUserWithDeck("aw_lonely");
        String lonelyId = userIdOf("aw_lonely");
        jdbcClient.sql("UPDATE decks SET is_active = 0 WHERE user_id <> ?").param(lonelyId).update();
        try {
            ResponseEntity<String> res = authPost("/api/away/matches", lonely, Map.of(), String.class);
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
            assertThat(res.getBody()).contains("NO_OPPONENT");
        } finally {
            jdbcClient.sql("UPDATE decks SET is_active = 1 WHERE user_id <> ?").param(lonelyId).update();
        }
    }

    // ── AC3/AC4: 정산 — 리포트 + 양쪽 레이팅 ±10, 멱등 ────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void finishedAwayMatchWritesReportAndRatesBothSidesOnce() {
        setupUserWithDeck("aw_def2");
        String defenderId = userIdOf("aw_def2");
        String attacker = setupUserWithDeck("aw_atk2");
        String attackerId = userIdOf("aw_atk2");

        String matchId = driveAwayToFinishedAgainst(attacker, defenderId);

        // 매치 관점(공격자) 결과.
        String attackerResult = jdbcClient.sql("SELECT result FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        int scoreHome = jdbcClient.sql("SELECT score_home FROM matches WHERE id = ?")
                .param(matchId).query(Integer.class).single();
        int scoreAway = jdbcClient.sql("SELECT score_away FROM matches WHERE id = ?")
                .param(matchId).query(Integer.class).single();

        // 리포트 = 수비자 관점(스코어 반전).
        Map<String, Object> report = jdbcClient.sql("""
                        SELECT defender_id, attacker_id, attacker_name, goals_for, goals_against,
                               result, rating_delta, seen_at
                        FROM away_reports WHERE match_id = ?
                        """)
                .param(matchId)
                .query((rs, n) -> {
                    Map<String, Object> m = new java.util.LinkedHashMap<>();
                    m.put("defenderId", rs.getString("defender_id"));
                    m.put("attackerId", rs.getString("attacker_id"));
                    m.put("attackerName", rs.getString("attacker_name"));
                    m.put("goalsFor", rs.getInt("goals_for"));
                    m.put("goalsAgainst", rs.getInt("goals_against"));
                    m.put("result", rs.getString("result"));
                    m.put("ratingDelta", rs.getInt("rating_delta"));
                    m.put("seenAt", rs.getString("seen_at"));
                    return m;
                })
                .single();

        assertThat(report.get("defenderId")).isEqualTo(defenderId);
        assertThat(report.get("attackerId")).isEqualTo(attackerId);
        assertThat(report.get("attackerName")).isEqualTo("aw_atk2");
        assertThat(report.get("goalsFor")).isEqualTo(scoreAway);      // 수비자 = away 사이드
        assertThat(report.get("goalsAgainst")).isEqualTo(scoreHome);
        assertThat(report.get("seenAt")).isNull();                     // 아직 미확인 = 팝업 대상
        assertThat(report.get("result")).isEqualTo(mirror(attackerResult));

        // 레이팅: 승 +10 / 패 −10 / 무 0 — 양쪽 대칭.
        int expectedAttacker = expectedDelta(attackerResult);
        assertThat(rating(attackerId)).isEqualTo(expectedAttacker);
        assertThat(rating(defenderId)).isEqualTo(-expectedAttacker);
        assertThat(report.get("ratingDelta")).isEqualTo(-expectedAttacker);

        // 멱등: 정산 경로를 다시 밟아도(스위퍼 재실행) 리포트도 원장도 늘지 않는다.
        clockSweeper.sweep();
        assertThat(countReports(matchId)).isEqualTo(1);
        assertThat(countLedger(matchId)).isEqualTo(attackerResult.equals("DRAW") ? 0 : 2);
        assertThat(rating(attackerId)).isEqualTo(expectedAttacker);
        assertThat(rating(defenderId)).isEqualTo(-expectedAttacker);
    }

    // ── AC5: 로비 팝업 조회 + ack 멱등 ────────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void unseenReportsExposeSummaryAndAckIsIdempotent() {
        String defenderToken = setupUserWithDeck("aw_def3");
        String defenderId = userIdOf("aw_def3");
        String attacker = setupUserWithDeck("aw_atk3");

        driveAwayToFinishedAgainst(attacker, defenderId);
        releaseActiveMatches();
        driveAwayToFinishedAgainst(attacker, defenderId);

        ResponseEntity<Map> res = authGet("/api/me/away-reports", defenderToken, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> reports = (List<Map<String, Object>>) res.getBody().get("reports");
        // 이 수비자에게 온 리포트만(다른 유저 것이 섞이지 않는다).
        assertThat(reports).isNotEmpty();

        Map<String, Object> summary = (Map<String, Object>) res.getBody().get("summary");
        int matches = (Integer) summary.get("matches");
        assertThat(matches).isEqualTo(reports.size());
        // 요구 3: "몇 팀과 · 몇 승 몇 패 · 득실" — 서버가 계산해서 준다(클라 복제 금지).
        assertThat((Integer) summary.get("wins") + (Integer) summary.get("draws")
                + (Integer) summary.get("losses")).isEqualTo(matches);
        assertThat(summary.get("opponents")).isNotNull();
        assertThat(summary.get("goalsFor")).isNotNull();
        assertThat(summary.get("goalsAgainst")).isNotNull();
        assertThat(res.getBody().get("rating")).isEqualTo(rating(defenderId));

        // ack → 미확인 0.
        ResponseEntity<Map> ack = authPost("/api/me/away-reports/ack", defenderToken, Map.of(), Map.class);
        assertThat(ack.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ack.getBody().get("acked")).isEqualTo(matches);
        assertThat(unseenCount(defenderId)).isZero();

        // 재확인(두 번째 탭)은 실패가 아니라 0건 처리다.
        ResponseEntity<Map> again = authPost("/api/me/away-reports/ack", defenderToken, Map.of(), Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(again.getBody().get("acked")).isEqualTo(0);

        // 확인 뒤에는 팝업 대상이 아니지만 기록은 남는다(status=all).
        ResponseEntity<Map> all = authGet("/api/me/away-reports?status=all", defenderToken, Map.class);
        assertThat((List<?>) all.getBody().get("reports")).hasSize(matches);
        ResponseEntity<Map> unseen = authGet("/api/me/away-reports", defenderToken, Map.class);
        assertThat((List<?>) unseen.getBody().get("reports")).isEmpty();
    }

    // ── AC6/AC7: 수비자는 관전 가능, 쓰기는 불가. 제3자는 아무것도 못 본다 ──────

    @SuppressWarnings("unchecked")
    @Test
    void defenderCanWatchButNeverWriteAndStrangersSeeNothing() {
        String defenderToken = setupUserWithDeck("aw_def4");
        String attacker = setupUserWithDeck("aw_atk4");
        String stranger = setupUserWithDeck("aw_stranger");

        String matchId = driveAwayToFinishedAgainst(attacker, userIdOf("aw_def4"));

        // 읽기 — 허용(요구: 요약도 보고 경기도 본다).
        ResponseEntity<Map> detail = authGet("/api/matches/" + matchId, defenderToken, Map.class);
        assertThat(detail.getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<String> log = authGet("/api/matches/" + matchId + "/halves/1/log",
                defenderToken, String.class);
        assertThat(log.getStatusCode()).isEqualTo(HttpStatus.OK);
        ResponseEntity<Map> result = authGet("/api/matches/" + matchId + "/result",
                defenderToken, Map.class);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.OK);

        // 쓰기 — 전부 차단. 관전 권한이 조작 권한으로 새면 안 된다.
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", defenderToken, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authPost("/api/matches/" + matchId + "/abandon", defenderToken, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authPost("/api/matches/" + matchId + "/retry", defenderToken, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);

        // 무관한 유저 — 읽기조차 404(소유권 비노출).
        assertThat(authGet("/api/matches/" + matchId, stranger, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authGet("/api/matches/" + matchId + "/halves/1/log", stranger, String.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── AC8: 레이팅은 GET /api/me 로 노출되고 하한이 없다 ──────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void ratingIsExposedOnMeAndHasNoFloor() {
        String token = setupUserWithDeck("aw_rating");
        String userId = userIdOf("aw_rating");

        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(me.getBody().get("rating")).isEqualTo(0);   // 초기 0 (hero Q2)

        // 방어에 계속 실패하면 0 아래로 내려간다 — wallets.points 와 달리 CHECK(>=0) 이 없다.
        // 행은 첫 정산 때 생긴다(RatingService.apply 가 upsert) — 프로덕션과 같은 문장으로 심는다.
        jdbcClient.sql("""
                        INSERT INTO user_ratings(user_id, rating, updated_at) VALUES (?, -30, ?)
                        ON CONFLICT(user_id) DO UPDATE SET rating = -30
                        """)
                .params(userId, java.time.Instant.now().toString()).update();
        ResponseEntity<Map> after = authGet("/api/me", token, Map.class);
        assertThat(after.getBody().get("rating")).isEqualTo(-30);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────────

    /**
     * 원정 매치를 FINISHED 까지 민다(GrowthSettlementFlowTest.driveToFinished 와 같은 패턴 —
     * 킥오프 → 가짜 서번트 → 시계 강제만료 → 스위퍼).
     */
    @SuppressWarnings("unchecked")
    private String driveAwayToFinishedAgainst(String attackerToken, String defenderId) {
        Map<String, Object> body = defenderId == null ? Map.of() : Map.of("defenderId", defenderId);
        ResponseEntity<Map> created = authPost("/api/away/matches", attackerToken, body, Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) created.getBody().get("id");

        authPost("/api/matches/" + matchId + "/kickoff", attackerToken, Map.of(), Map.class);
        fakeServants.drain();
        for (int i = 0; i < 6 && !"FINISHED".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
            fakeServants.drain();
        }
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        return matchId;
    }

    private static String mirror(String result) {
        return switch (result) {
            case "WIN" -> "LOSS";
            case "LOSS" -> "WIN";
            default -> "DRAW";
        };
    }

    private static int expectedDelta(String result) {
        return switch (result) {
            case "WIN" -> 10;
            case "LOSS" -> -10;
            default -> 0;
        };
    }

    private int rating(String userId) {
        return jdbcClient.sql("SELECT rating FROM user_ratings WHERE user_id = ?")
                .param(userId).query(Integer.class).single();
    }

    private long countReports(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE match_id = ?")
                .param(matchId).query(Long.class).single();
    }

    private long countLedger(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM rating_ledger WHERE ref_id = ?")
                .param(matchId).query(Long.class).single();
    }

    private long unseenCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM away_reports WHERE defender_id = ? AND seen_at IS NULL")
                .param(userId).query(Long.class).single();
    }
}
