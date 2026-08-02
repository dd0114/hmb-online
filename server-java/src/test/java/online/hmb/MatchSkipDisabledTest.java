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
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 스킵 롤백 스위치 — {@code hmb.match.skip.enabled=false} (#421 W1).
 *
 * <p>왜 스위치가 필요한가: 이 에픽은 <b>P4-D1 "전반 재생 중 후반 앞당기기 금지"를 hero 지시로
 * 뒤집는다</b>(근거 계약 = {@code MatchService.resumeCas} 주석 · openapi {@code /resume} 409).
 * 뒤집은 규칙은 되돌릴 수 있어야 한다 — 끄면 <b>재배포 없이</b> 원 규칙(창은 서버가 소유, 유저는
 * 못 당긴다)으로 복귀한다.
 *
 * <p>롤백의 조건은 "409 를 준다"만이 아니다 — <b>창을 한 밀리초도 만지지 않아야</b> 하고, 기존 만료
 * 경로는 그대로 돌아야 한다. 스위치가 반쪽이면 롤백이 새 버그가 된다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchSkipDisabledTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.skip.enabled", () -> "false"); // ← 이 클래스의 주제
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
    void skipIsRefusedAndLeavesTheWindowUntouchedWhenTheSwitchIsOff() {
        String token = setupUserWithDeck("skip_off");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        String windowBefore = clockColumn(matchId, "phase_ends_at");

        ResponseEntity<Map> response = authPost("/api/matches/" + matchId + "/skip", token,
                Map.of("phase", "FIRST_HALF"), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().get("code")).isEqualTo("INVALID_STATE");
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        assertThat(clockColumn(matchId, "phase_ends_at")).isEqualTo(windowBefore);

        // 롤백해도 기존 흐름은 그대로다 — 창이 만료되면 서버가 감독시간을 연다.
        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                .update();
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    private String clockColumn(String matchId, String column) {
        return jdbcClient.sql("SELECT " + column + " FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }
}
