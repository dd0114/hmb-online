package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 롤백 스위치 검증 (LLD-e2-flow-clock §7.7, T-W3-5): {@code hmb.match.clock.enabled=false} 면
 * 시계 이전 동작 그대로다 — 전반 시뮬 직후 감독시간 대기(무기한), 후반 시뮬 직후 즉시 종료·정산.
 * 상태 이름만 HALFTIME(구 H1_BREAK)이고 {@code clock} 은 null 이라 웹은 카운트다운/상한 없이 돈다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchClockDisabledTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.clock.enabled", () -> "false");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Test
    void disabledClockKeepsTheLegacyImmediateFlow() {
        String token = setupUserWithDeck("clk_off");
        String matchId = createMatch(token, "BOT_BAL");

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();

        // 전반 시뮬 = 곧바로 감독시간(대기). 시계가 없으니 만료도, 자동 후반도 없다.
        Map<?, ?> afterH1 = authGet("/api/matches/" + matchId, token, Map.class).getBody();
        assertThat(afterH1.get("state")).isEqualTo("HALFTIME");
        assertThat(afterH1.get("clock")).isNull();
        assertThat(afterH1.get("scoreH1Home")).isEqualTo(1); // 전반이 끝난 상태라 스코어 공개

        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        // 후반 시뮬 = 곧바로 종료·정산(구 동작).
        Map<?, ?> finished = authGet("/api/matches/" + matchId, token, Map.class).getBody();
        assertThat(finished.get("state")).isEqualTo("FINISHED");
        assertThat(finished.get("clock")).isNull();
        assertThat(finished.get("result")).isEqualTo("WIN");
        assertThat(authGet("/api/matches/" + matchId + "/result", token, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }
}
