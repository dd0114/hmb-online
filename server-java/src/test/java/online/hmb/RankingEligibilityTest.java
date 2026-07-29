package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

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
 * #296 AC1·AC2 — 랭킹 노출 자격("게임 한 판 한 유저만").
 *
 * <p>왜 필요한가: 리더보드가 {@code users} 전량을 필터 없이 실어서, 가입만 하고 한 판도 안 한 계정이
 * 순위표를 도배했다(라이브 160계정 중 137이 그랬다 — 운영 조치 #288). 덱 보유는 활동 증거가 못 된다
 * (온보딩이 스타터 덱을 자동 지급한다).
 *
 * <p>⚠️ AC2 가 이 에픽의 진짜 함정이다: 필터만 넣으면 {@code getRankings} 가 me 를 <b>필터된 목록</b>
 * 에서 찾다가 404 를 던지고, web 은 그걸 "랭킹을 불러오지 못했습니다" 에러 토스트로 그린다. 즉 신규
 * 유저가 랭킹 탭을 열면 에러를 본다. 자격이 없어도 <b>200 + 리더보드 + me.eligible=false</b> 여야 한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class RankingEligibilityTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    // ── AC1: 완료 경기 0판 계정은 리더보드에 실리지 않는다 ─────────────────

    @SuppressWarnings("unchecked")
    @Test
    void leaderboardExcludesUsersWithNoFinishedMatch() {
        String playerToken = login("el_player");
        String player = userIdOf("el_player");
        login("el_idle");                       // 가입만 — 경기 0
        String idle = userIdOf("el_idle");
        finishedMatch(player, "WIN");

        List<Map<String, Object>> board = leaderboard(rankings(playerToken));

        assertThat(ids(board)).contains(player);
        assertThat(ids(board)).doesNotContain(idle);
    }

    /**
     * 진행 중(결과 없음) 매치는 자격이 아니다 — "한 판 했다"는 <b>끝까지 간 것</b>이다.
     * 이게 없으면 매치를 열어놓기만 해도 순위표에 들어오는 우회로가 생긴다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void unfinishedMatchDoesNotGrantEligibility() {
        String token = login("el_started");
        String uid = userIdOf("el_started");
        insertMatch(uid, null);                 // result NULL = 진행 중

        assertThat(ids(leaderboard(rankings(token)))).doesNotContain(uid);
    }

    // ── AC2: 미자격 유저도 200 + 리더보드 + me.eligible=false ──────────────

    @SuppressWarnings("unchecked")
    @Test
    void ineligibleUserGetsOkWithLeaderboardAndNotEligibleMe() {
        String seedToken = login("el_seed");
        finishedMatch(userIdOf("el_seed"), "WIN");
        String freshToken = login("el_fresh");  // 방금 가입 — 한 판도 안 함

        ResponseEntity<Map> res = authGet("/api/rankings", freshToken, Map.class);

        // 404 가 아니라 200 — 이게 깨지면 신규 유저 랭킹 탭이 에러 토스트가 된다.
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat((List<Map<String, Object>>) body.get("leaderboard")).isNotEmpty();

        Map<String, Object> me = (Map<String, Object>) body.get("me");
        assertThat(me.get("userId")).isEqualTo(userIdOf("el_fresh"));
        assertThat(me.get("eligible")).isEqualTo(false);
        assertThat(me.get("rank")).isNull();     // 아직 순위가 없다(0위가 아니라 없음)
    }

    @SuppressWarnings("unchecked")
    @Test
    void eligibleUserHasRankAndEligibleTrue() {
        String token = login("el_ranked");
        finishedMatch(userIdOf("el_ranked"), "LOSS");   // 패배도 한 판이다

        Map<String, Object> me = (Map<String, Object>) rankings(token).get("me");

        assertThat(me.get("eligible")).isEqualTo(true);
        assertThat(((Number) me.get("rank")).intValue()).isGreaterThan(0);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private Map<String, Object> rankings(String token) {
        ResponseEntity<Map> res = authGet("/api/rankings?limit=100", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> leaderboard(Map<String, Object> resp) {
        return (List<Map<String, Object>>) resp.get("leaderboard");
    }

    private static List<String> ids(List<Map<String, Object>> board) {
        return board.stream().map(e -> (String) e.get("userId")).toList();
    }

    private void finishedMatch(String userId, String result) {
        insertMatch(userId, result);
    }

    private void insertMatch(String userId, String result) {
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', ?, 'seed', '0.9.0', '{}', 'practice', ?, ?)
                        """)
                .params(Ulid.next(), userId, result == null ? "FIRST_HALF" : "FINISHED", result,
                        "2026-05-01T00:00:00Z")
                .update();
    }
}
