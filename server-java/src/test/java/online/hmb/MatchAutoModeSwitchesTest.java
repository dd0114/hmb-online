package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 오토 모드 롤백 스위치 (#249) — {@code hmb.match.auto.enabled=false}.
 *
 * <p>롤백 스위치의 조건은 <b>"내리면 조용히 현행 동작"</b>이다(LLD-e2-flow-clock 불변조건 I5):
 * 이미 켜 둔 매치까지 정상 감독시간으로 돌아오고, <b>토글 API 는 계속 200</b> 이라 롤백이 클라
 * 에러로 새지 않는다. 200 을 400/409 로 바꾸면 "서버 내렸더니 유저 화면에 빨간 토스트"가 된다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchAutoModeSwitchesTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.auto.enabled", () -> "false"); // 롤백
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    @Test
    void killSwitchIgnoresTheFlagAndKeepsTheNormalHalftime() {
        String token = setupUserWithDeck("auto_killsw");
        String matchId = createMatch(token, "BOT_BAL");

        // API 는 여전히 200 — 롤백이 클라 에러로 새지 않는다.
        var toggled = authPost("/api/matches/" + matchId + "/auto", token, Map.of("auto", true), Map.class);
        assertThat(toggled.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(toggled.getBody().get("auto")).isEqualTo(true);

        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                .update();
        clockSweeper.sweep();

        // 플래그가 켜져 있어도 경계가 보지 않는다 = 정상 감독시간.
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        assertThat(jdbcClient.sql("SELECT phase_ends_at FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single()).isNotNull();
    }
}
