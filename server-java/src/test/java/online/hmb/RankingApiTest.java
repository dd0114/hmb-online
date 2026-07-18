package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import online.hmb.common.Ulid;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-E2 랭킹 (LLD-p2-server §7). 리더보드(승수/승률·전 유저), 내 순위, 개인 기록(최다 득점 선수=goal
 * 이벤트 파생·최고 연승·총 경기수). 합성 matches/match_halves 로 통제.
 *
 * <p>클래스 단위 DB 공유(테스트 메서드 간 유저 누적)라, 리더보드 절대 순위 대신 자기 생성 유저의 상대
 * 순위·전역 정렬 불변식을 검증한다. 개인 기록은 특정 userId 스코프라 오염 없음.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class RankingApiTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    // ── 리더보드: 승수 desc → 승률 desc → 내 순위 ─────────────────────────

    @Test
    void leaderboardRanksByWinsThenWinRateAndReturnsMe() {
        String alice = login("rk_alice");
        String bob = login("rk_bob");
        String carol = login("rk_carol");
        String aliceId = userIdOf("rk_alice");
        String bobId = userIdOf("rk_bob");
        String carolId = userIdOf("rk_carol");

        // alice: 3승(승률 1.0). carol: 1승(승률 1.0). bob: 1승 1패(승률 0.5).
        // 정렬: 승수 desc → alice(3) 먼저, bob·carol 동률(1) → 승률 desc → carol(1.0) > bob(0.5).
        wins(aliceId, 3);
        wins(carolId, 1);
        results(bobId, "WIN", "LOSS");

        Map<String, Object> resp = rankings(alice, 100);
        List<Map<String, Object>> board = leaderboard(resp);

        // 전역 정렬 불변식: 승수 비증가.
        for (int i = 1; i < board.size(); i++) {
            assertThat(((Number) board.get(i - 1).get("wins")).intValue())
                    .isGreaterThanOrEqualTo(((Number) board.get(i).get("wins")).intValue());
        }

        Map<String, Object> ea = entry(board, aliceId);
        Map<String, Object> eb = entry(board, bobId);
        Map<String, Object> ec = entry(board, carolId);
        // 상대 순위: alice < carol < bob.
        assertThat(rank(ea)).isLessThan(rank(ec));
        assertThat(rank(ec)).isLessThan(rank(eb));
        // 값 검증.
        assertThat(((Number) ea.get("wins")).intValue()).isEqualTo(3);
        assertThat(((Number) ea.get("winRate")).doubleValue()).isEqualTo(1.0);
        assertThat(((Number) eb.get("wins")).intValue()).isEqualTo(1);
        assertThat(((Number) eb.get("winRate")).doubleValue()).isEqualTo(0.5);
        assertThat(((Number) ec.get("winRate")).doubleValue()).isEqualTo(1.0);

        // me = 요청자(alice).
        Map<String, Object> me = (Map<String, Object>) resp.get("me");
        assertThat(me.get("userId")).isEqualTo(aliceId);
        assertThat(((Number) me.get("wins")).intValue()).isEqualTo(3);
        assertThat(rank(me)).isEqualTo(rank(ea));
    }

    @Test
    void meReturnedEvenWhenBeyondLeaderboardLimit() {
        String top = login("rk_top");
        String tail = login("rk_tail");
        wins(userIdOf("rk_top"), 5);
        results(userIdOf("rk_tail"), "LOSS"); // 0승 → 리더보드 하위

        Map<String, Object> resp = rankings(tail, 1); // limit=1 → 리더보드 1명
        assertThat(leaderboard(resp)).hasSize(1);
        Map<String, Object> me = (Map<String, Object>) resp.get("me");
        assertThat(me.get("userId")).isEqualTo(userIdOf("rk_tail"));
        assertThat(rank(me)).isGreaterThan(1); // 리더보드 밖이어도 내 전역 순위 반환
    }

    // ── 개인 기록: 최다 득점 선수(goal 이벤트 파생) + 최고 연승 + 총 경기 ──

    @Test
    void personalRecordsTopScorerStreakAndTotal() {
        String token = login("rk_dave");
        String uid = userIdOf("rk_dave");

        // t1 WIN(home): P012 x3.  t2 WIN(home): P012 x1, P014 x1.  t3 LOSS(home): 상대 득점만.
        // t4 WIN(home): P014 x1.  → 연대순 WIN,WIN,LOSS,WIN → 최고 연승 2, 총 4경기.
        String m1 = insertMatch(uid, "BOT_BAL", "practice", null, "WIN", "2026-02-01T00:00:01Z");
        insertHalf(m1, 1, goals("home", "P012", "P012", "P012"));
        String m2 = insertMatch(uid, "BOT_BAL", "practice", null, "WIN", "2026-02-01T00:00:02Z");
        insertHalf(m2, 1, "[" + goalTail("home", "P012") + "," + goalTail("home", "P014") + "]");
        String m3 = insertMatch(uid, "BOT_BAL", "practice", null, "LOSS", "2026-02-01T00:00:03Z");
        insertHalf(m3, 1, goals("away", "P099")); // 상대(away) 득점 — 유저(home) 집계 제외
        String m4 = insertMatch(uid, "BOT_BAL", "practice", null, "WIN", "2026-02-01T00:00:04Z");
        insertHalf(m4, 1, goals("home", "P014"));

        Map<String, Object> pr = personalRecords(rankings(token, 100));
        Map<?, ?> topScorer = (Map<?, ?>) pr.get("topScorer");
        assertThat(topScorer.get("playerId")).isEqualTo("P012"); // 4골 최다
        assertThat(topScorer.get("name")).isEqualTo("Test Forward 1"); // PlayerRef 카탈로그 조인
        assertThat(topScorer.get("position")).isEqualTo("FW");
        assertThat(topScorer.get("grade")).isEqualTo("BRONZE");
        assertThat(((Number) pr.get("topScorerGoals")).intValue()).isEqualTo(4);
        assertThat(((Number) pr.get("longestWinStreak")).intValue()).isEqualTo(2);
        assertThat(((Number) pr.get("totalMatches")).intValue()).isEqualTo(4);
    }

    @Test
    void awayLeagueGoalsCountedForUserSideNotOpponent() {
        String token = login("rk_away");
        String uid = userIdOf("rk_away");
        String s1 = insertSeason(uid, 1);
        // 유저 어웨이(픽스처 home=BOT). 유저(away) P014 x2 득점, 상대(home) P012 x3 득점.
        String fx = insertFixture(s1, 1, "BOT_ATK", "USER", 1, 2);
        String m = insertLeagueMatch(uid, "BOT_ATK", fx, "LOSS", "2026-03-01T00:00:01Z");
        insertHalf(m, 1, "[" + goalTail("away", "P014", "P014") + "," + goalTail("home", "P012", "P012", "P012") + "]");

        Map<String, Object> pr = personalRecords(rankings(token, 100));
        Map<?, ?> topScorer = (Map<?, ?>) pr.get("topScorer");
        // 유저 사이드(away)의 P014 만 집계 — 상대(home) P012 는 제외.
        assertThat(topScorer.get("playerId")).isEqualTo("P014");
        assertThat(((Number) pr.get("topScorerGoals")).intValue()).isEqualTo(2);
    }

    @Test
    void personalRecordsEmptyForNewUser() {
        String token = login("rk_new");
        Map<String, Object> pr = personalRecords(rankings(token, 100));
        assertThat(pr.get("topScorer")).isNull();
        assertThat(pr.get("topScorerGoals")).isNull();
        assertThat(((Number) pr.get("longestWinStreak")).intValue()).isEqualTo(0);
        assertThat(((Number) pr.get("totalMatches")).intValue()).isEqualTo(0);
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private Map<String, Object> rankings(String token, int limit) {
        ResponseEntity<Map> r = authGet("/api/rankings?limit=" + limit, token, Map.class);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> leaderboard(Map<String, Object> resp) {
        return (List<Map<String, Object>>) resp.get("leaderboard");
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> personalRecords(Map<String, Object> resp) {
        return (Map<String, Object>) resp.get("personalRecords");
    }

    private static Map<String, Object> entry(List<Map<String, Object>> board, String userId) {
        return board.stream().filter(e -> userId.equals(e.get("userId"))).findFirst().orElseThrow();
    }

    private static int rank(Map<String, Object> entry) {
        return ((Number) entry.get("rank")).intValue();
    }

    private void wins(String userId, int count) {
        for (int i = 0; i < count; i++) {
            insertMatch(userId, "BOT_BAL", "practice", null, "WIN",
                    "2026-01-01T00:00:0" + (i + 1) + "Z");
        }
    }

    private void results(String userId, String... results) {
        for (int i = 0; i < results.length; i++) {
            insertMatch(userId, "BOT_BAL", "practice", null, results[i],
                    "2026-01-01T00:00:1" + i + "Z");
        }
    }

    /** goal 이벤트 배열 문자열(대괄호 포함). */
    private static String goals(String team, String... playerIds) {
        return "[" + goalTail(team, playerIds) + "]";
    }

    /** goal 이벤트들(대괄호 없음) — 다른 조각과 이어붙일 때. */
    private static String goalTail(String team, String... playerIds) {
        StringBuilder sb = new StringBuilder();
        for (int i = 0; i < playerIds.length; i++) {
            if (i > 0) {
                sb.append(",");
            }
            sb.append("{\"tick\":").append(i)
                    .append(",\"minute\":0,\"type\":\"goal\",\"team\":\"").append(team)
                    .append("\",\"playerId\":\"").append(playerIds[i]).append("\"}");
        }
        return sb.toString();
    }

    private String insertMatch(String userId, String botId, String mode, String leagueFixtureId,
                               String result, String createdAt) {
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, user_deck_json,
                                            mode, league_fixture_id, result, created_at)
                        VALUES (?, ?, ?, 'FINISHED', 'seed', '0.9.0', '{}', ?, ?, ?, ?)
                        """)
                .params(id, userId, botId, mode, leagueFixtureId, result, createdAt)
                .update();
        return id;
    }

    private String insertLeagueMatch(String userId, String botId, String fixtureId, String result,
                                     String createdAt) {
        return insertMatch(userId, botId, "league", fixtureId, result, createdAt);
    }

    private String insertSeason(String userId, int seasonNo) {
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO league_seasons(id, user_id, season_no, state, seed, teams_json, created_at)
                        VALUES (?, ?, ?, 'ACTIVE', 'seed', '[]', ?)
                        """)
                .params(id, userId, seasonNo, Instant.now().toString())
                .update();
        return id;
    }

    private String insertFixture(String seasonId, int round, String home, String away, int sh, int sa) {
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO league_fixtures(id, season_id, round, home_team, away_team, is_user, state,
                                                    score_home, score_away)
                        VALUES (?, ?, ?, ?, ?, 1, 'PLAYED', ?, ?)
                        """)
                .params(id, seasonId, round, home, away, sh, sa)
                .update();
        return id;
    }

    private void insertHalf(String matchId, int half, String eventsJson) {
        String log = "{\"configVersion\":\"0.9.0\",\"seed\":\"s\",\"tickSnapshots\":[],\"events\":"
                + eventsJson + ",\"finalScore\":{\"home\":0,\"away\":0}}";
        jdbcClient.sql("""
                        INSERT INTO match_halves(match_id, half, select_data_json, home_input_json,
                                                 away_input_json, half_seed, match_log_json, last_hash)
                        VALUES (?, ?, '{}', '{}', '{}', 's', ?, 'h')
                        """)
                .params(matchId, half, log)
                .update();
    }
}
