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
 * AC-E1/E3 로그 탭 (LLD-p2-server §7). GET /api/logs/matches(모드·시즌 필터 매트릭스 + 유저 관점
 * 오리엔트 홈/어웨이 + 상세 재생 링크 hasHalves), GET /api/logs/trades(페이지네이션 경계).
 *
 * <p>합성 데이터(matches/league_fixtures/match_halves/trade_log 직접 삽입)로 케이스를 통제한다 —
 * 풀 매치 플로우 없이 오리엔트/필터 정합만 검증. 어웨이 유저 리그경기의 실플로우 flip 은 LeagueApiTest.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class LogsApiTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    // ── 필터 매트릭스 (mode/season) ───────────────────────────────────────

    @Test
    void modeAndSeasonFilterMatrix() {
        String token = login("logs_filter");
        String uid = userIdOf("logs_filter");
        String s1 = insertSeason(uid, 1);
        String s2 = insertSeason(uid, 2);
        String fx1 = insertFixture(s1, 3, "USER", "BOT_ATK", true, 2, 0, null);
        String fx2 = insertFixture(s2, 7, "BOT_ATK", "USER", true, 1, 1, null);

        insertMatch(uid, "BOT_BAL", "practice", null, 3, 1, "WIN", "2026-01-01T00:00:01Z");
        insertMatch(uid, "BOT_ATK", "league", fx1, 2, 0, "WIN", "2026-01-01T00:00:02Z");
        insertMatch(uid, "BOT_ATK", "league", fx2, 1, 1, "DRAW", "2026-01-01T00:00:03Z");

        assertThat(matches(token, null, null)).hasSize(3);
        assertThat(matches(token, "practice", null)).hasSize(1);
        assertThat(matches(token, "league", null)).hasSize(2);
        assertThat(matches(token, null, "1")).hasSize(1);
        assertThat(matches(token, null, "2")).hasSize(1);
        assertThat(matches(token, "league", "1")).hasSize(1);
        // practice + season → practice 는 season_no 없음 → 0.
        assertThat(matches(token, "practice", "1")).isEmpty();

        // 잘못된 mode → 400.
        ResponseEntity<Map> bad = authGet("/api/logs/matches?mode=bogus", token, Map.class);
        assertThat(bad.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void matchLogCarriesLeagueMetadataAndReplayLink() {
        String token = login("logs_meta");
        String uid = userIdOf("logs_meta");
        String s1 = insertSeason(uid, 1);
        String fx = insertFixture(s1, 5, "USER", "BOT_ATK", true, 2, 1, null);
        String matchId = insertMatch(uid, "BOT_ATK", "league", fx, 2, 1, "WIN", "2026-01-02T00:00:01Z");
        insertHalf(matchId, 1, 2, 1, "[]");

        Map<String, Object> item = matches(token, "league", null).get(0);
        assertThat(item.get("id")).isEqualTo(matchId); // matchId = 상세 재생 링크
        assertThat(item.get("mode")).isEqualTo("league");
        assertThat(((Number) item.get("seasonNo")).intValue()).isEqualTo(1);
        assertThat(((Number) item.get("round")).intValue()).isEqualTo(5);
        assertThat((Boolean) item.get("hasHalves")).isTrue();
    }

    @Test
    void hasHalvesFalseWhenNoHalfLog() {
        String token = login("logs_nohalf");
        String uid = userIdOf("logs_nohalf");
        insertMatch(uid, "BOT_BAL", "practice", null, 0, 0, "DRAW", "2026-01-03T00:00:01Z");
        Map<String, Object> item = matches(token, null, null).get(0);
        assertThat((Boolean) item.get("hasHalves")).isFalse();
    }

    // ── 유저 관점 오리엔트 (홈/어웨이) ────────────────────────────────────

    @Test
    void userWasHomeOrientForHomeAwayAndPractice() {
        String token = login("logs_orient");
        String uid = userIdOf("logs_orient");
        String s1 = insertSeason(uid, 1);
        // 유저 홈 리그경기(픽스처 home=USER): 엔진 2:1 → 유저 관점 홈, 유저 득점=scoreHome=2.
        String homeFx = insertFixture(s1, 1, "USER", "BOT_ATK", true, 2, 1, null);
        insertMatch(uid, "BOT_ATK", "league", homeFx, 2, 1, "WIN", "2026-01-04T00:00:01Z");
        // 유저 어웨이 리그경기(픽스처 home=BOT): 엔진 3:1 → 유저 관점 어웨이, 유저 득점=scoreAway=1 → LOSS(flip).
        String awayFx = insertFixture(s1, 2, "BOT_ATK", "USER", true, 3, 1, null);
        insertMatch(uid, "BOT_ATK", "league", awayFx, 3, 1, "LOSS", "2026-01-04T00:00:02Z");
        // 연습경기: 항상 userWasHome=true.
        insertMatch(uid, "BOT_BAL", "practice", null, 0, 2, "LOSS", "2026-01-04T00:00:03Z");

        List<Map<String, Object>> all = matches(token, null, null); // 최신순
        Map<String, Object> practice = all.get(0);
        Map<String, Object> away = all.get(1);
        Map<String, Object> home = all.get(2);

        assertThat((Boolean) home.get("userWasHome")).isTrue();
        assertThat(((Number) home.get("scoreHome")).intValue()).isEqualTo(2); // 유저 득점 = scoreHome
        assertThat(home.get("result")).isEqualTo("WIN");

        assertThat((Boolean) away.get("userWasHome")).isFalse();
        assertThat(((Number) away.get("scoreHome")).intValue()).isEqualTo(3); // 픽스처 관점 저장(봇 득점)
        assertThat(((Number) away.get("scoreAway")).intValue()).isEqualTo(1); // 유저 득점 = scoreAway
        assertThat(away.get("result")).isEqualTo("LOSS"); // 유저 관점 flip

        assertThat((Boolean) practice.get("userWasHome")).isTrue();
    }

    // ── 트레이드 이력 + 페이지네이션 경계 ─────────────────────────────────

    @Test
    void tradeLogPaginationBoundaries() {
        String token = login("logs_trade");
        String uid = userIdOf("logs_trade");
        for (int i = 0; i < 5; i++) {
            insertTradeLog(uid, "FA", "SUCCESS", "P0" + (10 + i));
        }
        // 다른 유저 로그는 섞이지 않음.
        String other = login("logs_trade_other");
        insertTradeLog(userIdOf("logs_trade_other"), "TRADE", "FAIL", "P099");

        assertThat(trades(token, null)).hasSize(5);       // 기본(30) → 5
        assertThat(trades(token, "2")).hasSize(2);          // limit=2
        assertThat(trades(token, "200")).hasSize(5);        // >max → clamp 100 → 5
        assertThat(trades(token, "0")).hasSize(5);          // <=0 → 기본 30 → 5
        assertThat(trades(other, null)).hasSize(1);

        // 최신(id DESC)순 + detail 객체 파싱.
        List<Map<String, Object>> log = trades(token, null);
        Map<String, Object> first = log.get(0);
        assertThat(first.get("kind")).isEqualTo("FA");
        assertThat(first.get("result")).isEqualTo("SUCCESS");
        Map<?, ?> detail = (Map<?, ?>) first.get("detail");
        assertThat(detail.get("target")).isEqualTo("P014"); // 마지막(=최신) 삽입
        long id0 = ((Number) log.get(0).get("id")).longValue();
        long id1 = ((Number) log.get(1).get("id")).longValue();
        assertThat(id0).isGreaterThan(id1);
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> matches(String token, String mode, String season) {
        StringBuilder path = new StringBuilder("/api/logs/matches");
        String sep = "?";
        if (mode != null) {
            path.append(sep).append("mode=").append(mode);
            sep = "&";
        }
        if (season != null) {
            path.append(sep).append("season=").append(season);
        }
        ResponseEntity<List> r = authGet(path.toString(), token, List.class);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> trades(String token, String limit) {
        String path = "/api/logs/trades" + (limit == null ? "" : "?limit=" + limit);
        ResponseEntity<List> r = authGet(path, token, List.class);
        assertThat(r.getStatusCode()).isEqualTo(HttpStatus.OK);
        return r.getBody();
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

    private String insertFixture(String seasonId, int round, String home, String away, boolean isUser,
                                 Integer sh, Integer sa, String matchId) {
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO league_fixtures(id, season_id, round, home_team, away_team, is_user, state,
                                                    score_home, score_away, match_id)
                        VALUES (?, ?, ?, ?, ?, ?, 'PLAYED', ?, ?, ?)
                        """)
                .params(id, seasonId, round, home, away, isUser ? 1 : 0, sh, sa, matchId)
                .update();
        return id;
    }

    private String insertMatch(String userId, String botId, String mode, String leagueFixtureId,
                               Integer sh, Integer sa, String result, String createdAt) {
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, user_deck_json,
                                            mode, league_fixture_id, score_home, score_away, result, created_at)
                        VALUES (?, ?, ?, 'FINISHED', 'seed', '0.9.0', '{}', ?, ?, ?, ?, ?, ?)
                        """)
                .params(id, userId, botId, mode, leagueFixtureId, sh, sa, result, createdAt)
                .update();
        return id;
    }

    private void insertHalf(String matchId, int half, int home, int away, String eventsJson) {
        String log = "{\"configVersion\":\"0.9.0\",\"seed\":\"s\",\"tickSnapshots\":[],\"events\":"
                + eventsJson + ",\"finalScore\":{\"home\":" + home + ",\"away\":" + away + "}}";
        jdbcClient.sql("""
                        INSERT INTO match_halves(match_id, half, select_data_json, home_input_json,
                                                 away_input_json, half_seed, match_log_json, last_hash)
                        VALUES (?, ?, '{}', '{}', '{}', 's', ?, 'h')
                        """)
                .params(matchId, half, log)
                .update();
    }

    private void insertTradeLog(String userId, String kind, String result, String target) {
        String detail = "{\"target\":\"" + target + "\",\"offered\":[],\"points\":0}";
        jdbcClient.sql("""
                        INSERT INTO trade_log(user_id, kind, result, detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(userId, kind, result, detail, Instant.now().toString())
                .update();
    }
}
