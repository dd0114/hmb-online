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
 * 두 운영 스위치의 <b>교차</b> (#249): {@code hmb.match.clock.auto-resume-on-expiry=false}
 * (감독시간이 만료돼도 유저 제출만이 후반을 연다) + 오토 모드.
 *
 * <p>이 조합이 위험한 이유: 오토는 감독시간을 <b>0초</b>로 열고 같은 체인에서 GEN2 로 잇는다. 그런데
 * 그 두 번째 전이를 이 스위치가 막으면 매치가 <b>만료된 0초 감독시간에 영구히 갇힌다</b> — 스위퍼
 * 후보 쿼리도 HALFTIME 을 빼므로 되살릴 경로가 없다(공을 차는 코드에 도달할 수 없다). 그래서 오토는
 * 이 스위치의 예외다: 스위치의 의도는 "유저에게 지시할 시간을 강제로 준다"인데, 오토는 유저가 그
 * 시간을 <b>명시적으로 포기</b>한 상태다.
 *
 * <p>동시에 <b>스위치가 오토 아닌 매치에는 그대로 적용된다</b>는 것도 같이 본다 — 예외가 스위치를
 * 통째로 무력화하면 그건 버그다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchAutoManualResumeSwitchTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.clock.auto-resume-on-expiry", () -> "false");
        registry.add("hmb.match.auto.enabled", () -> "true");
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
    void autoMatchesAreNotStrandedWhenManualResumeIsEnforced() {
        String token = setupUserWithDeck("auto_manual");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/auto", token, Map.of("auto", true), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        kickoff(token, matchId);

        expireNow(matchId);
        clockSweeper.sweep();

        // 갇히지 않았다 — 오토는 이 스위치의 예외다.
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }

    @Test
    void nonAutoMatchesStillWaitForTheUserAsTheSwitchDemands() {
        String token = setupUserWithDeck("manual_only");
        String matchId = createMatch(token, "BOT_BAL");
        kickoff(token, matchId);

        expireNow(matchId);
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 감독시간이 만료돼도 서버가 열어주지 않는다(스위치의 본래 의도).
        expireNow(matchId);
        clockSweeper.sweep();
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 유저 제출만이 후반을 연다.
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }

    private void kickoff(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
    }

    private void expireNow(String matchId) {
        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                .update();
    }
}
