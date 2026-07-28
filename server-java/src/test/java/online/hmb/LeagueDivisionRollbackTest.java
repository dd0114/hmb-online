package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import online.hmb.league.LeagueService;
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
 * #252 <b>롤백 경로</b> — 발행물을 구 {@code league.v1.json}(디비전 표 없음)으로 되돌린 상태.
 *
 * <p>이 리포의 롤백 계약은 "발행물을 v1 으로 되돌리면 구 동작으로 복귀한다"이다. 그러려면 사다리가
 * <b>통째로 꺼져야</b> 한다 — 승급도 강등도 없어야 한다.
 *
 * <p>⚠️ 실제로 한 번 <b>비대칭</b>이었다: {@code top} 이 {@code from} 으로 폴백돼 승급만 no-op 이 되고
 * <b>강등은 계속 걸렸다</b>. 그 상태로 오래 굴리면 전 유저가 입문 디비전으로 흘러내리고, 롤포워드
 * 했을 때 진행도가 사라진다. 롤백은 "기능이 꺼지는 것"이지 "한쪽만 도는 것"이 아니다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueDivisionRollbackTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.3.json");
        // 롤백 상태 — divisions 블록이 없는 구 발행물.
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @jakarta.annotation.Resource
    private LeagueService leagueService;

    @Test
    void rollbackToV1DisablesBothPromotionAndRelegation() {
        assertDivisionUnchanged("rb-win", true);   // 전승(1위)이어도 승급 없음
        assertDivisionUnchanged("rb-loss", false); // 전패(꼴찌)여도 강등 없음
    }

    private void assertDivisionUnchanged(String nickname, boolean userWinsAll) {
        String token = setupUserWithDeck(nickname);
        String userId = userIdOf(nickname);
        jdbcClient.sql("UPDATE users SET division = 5 WHERE id = ?").param(userId).update();

        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        String seasonId = (String) ((Map<?, ?>) res.getBody().get("season")).get("id");

        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=0, score_away=0 "
                        + "WHERE season_id = ? AND is_user = 0").param(seasonId).update();
        int userGoals = userWinsAll ? 1 : 0;
        int oppGoals = userWinsAll ? 0 : 1;
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=?, score_away=? "
                        + "WHERE season_id = ? AND is_user = 1 AND home_team = ?")
                .params(userGoals, oppGoals, seasonId, LeagueService.USER_TEAM_ID).update();
        jdbcClient.sql("UPDATE league_fixtures SET state='PLAYED', score_home=?, score_away=? "
                        + "WHERE season_id = ? AND is_user = 1 AND away_team = ?")
                .params(oppGoals, userGoals, seasonId, LeagueService.USER_TEAM_ID).update();

        invokeSeasonHook(seasonId);

        int rank = leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser)
                .map(LeagueService.LeagueStanding::rank).findFirst().orElseThrow();
        assertThat(rank).as("순위 셋업").isEqualTo(userWinsAll ? 1 : 10);
        assertThat(jdbcClient.sql("SELECT division FROM users WHERE id=?")
                .param(userId).query(Integer.class).single())
                .as("사다리가 꺼진 상태에서 %d위 — 디비전은 움직이지 않는다", rank)
                .isEqualTo(5);
    }

    private void invokeSeasonHook(String seasonId) {
        try {
            java.lang.reflect.Method m =
                    LeagueService.class.getDeclaredMethod("maybeFinishSeason", String.class);
            m.setAccessible(true);
            m.invoke(leagueService, seasonId);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
