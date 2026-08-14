package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import jakarta.annotation.Resource;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import online.hmb.match.MatchClockService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#512 — 스윕 <u>호출부</u>가 상한을 실제로 쓰는가.</b>
 *
 * <p>{@code MatchClockSweepBoundTest} 는 {@link MatchClockService#awaitAll} 의 <b>의미론</b>만 본다.
 * 그것만으로는 <b>호출부가 그 상한을 넘기는지</b>가 검정되지 않는다 — 독립 검증이 실증했다:
 * {@code advanceAllDue} 안의 인자를 사실상 무한대로 바꿔(구 동작 복원) 풀스위트를 돌려도 <b>1264개가
 * 전부 green</b> 이었다. 즉 이 이슈가 지목한 바로 그 줄에 계약이 없었다.
 *
 * <p>그래서 여기서는 <b>실제 만료 전이</b>를 태운다. 감독시간 만료 → 후반 시작은 전반 인풋을 재사용
 * (materialized)해 <b>스위퍼 스레드가 그 자리에서 엔진 RPC 를 부르는</b> 경로다. 그 러너가 응답
 * <b>본문 중간에</b> 멈추면(= 실서버 사고 모양) 구 동작에서는 {@code advanceAllDue} 가 그 호출이
 * 끝날 때까지 돌아오지 않았다.
 *
 * <p>⚠️ 두 시간 예산을 <b>일부러 크게 벌려</b> 놨다: 스윕 상한 {@code 800ms} ≪ 러너 마감
 * {@code 4s × 2 = 8s}. 그래야 "스윕이 자기 상한에 돌아왔다"와 "RPC 마감 덕에 어차피 돌아왔다"가
 * 구별된다 — 붙여 두면 근인 수정만으로도 통과해 방어층이 다시 무계약이 된다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchClockSweepDeadlineTest extends MatchTestBase {

    private static final long SWEEP_TIMEOUT_MS = 800;

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        // 배경 스케줄러는 사실상 끈다 — 전이 시점을 이 테스트가 직접 통제한다.
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.clock.half-real-ms", () -> "240000");
        registry.add("hmb.match.clock.halftime-ms", () -> "60000");
        registry.add("hmb.match.clock.sweep-task-timeout-ms", () -> String.valueOf(SWEEP_TIMEOUT_MS));
        // 러너 마감은 스윕 상한보다 **한참 크게** — 위 javadoc 의 이유.
        registry.add("hmb.servant.simulate-timeout-sec", () -> "4");
        registry.add("hmb.servant.simulate-retries", () -> "0");
    }

    @AfterEach
    void releaseStalledResponse() {
        RUNNER.releaseStall();
        RUNNER.stallHalf = 0;
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockService clockService;

    @Test
    void aStalledRunnerDoesNotHoldTheSweepPastItsBudget() {
        String token = setupUserWithDeck("clk_stall");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        // 전반 만료 → HALFTIME. (여기까지 러너는 정상이어야 한다 — 멈추는 것은 후반뿐.)
        expireNow(matchId);
        clockService.advanceAllDue();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 이제 후반 시뮬이 **본문 중간에 멈춘다**. 유저는 아무것도 제출하지 않았으므로 전반 인풋
        // 재사용 경로이고, 그래서 이 RPC 는 **스위퍼 스레드가 직접** 부른다.
        RUNNER.stallHalf = 2;
        expireNow(matchId);

        long elapsedMs = assertTimeoutPreemptively(Duration.ofSeconds(30), () -> {
            long t0 = System.nanoTime();
            clockService.advanceAllDue();
            return (System.nanoTime() - t0) / 1_000_000L;
        });

        assertThat(elapsedMs)
                .as("스윕 상한 %d ms 인데 %d ms 매달렸다 — 스위퍼가 안 돌아오면 @Scheduled(fixedDelay) 라"
                        + " 다음 스윕이 영영 안 뜨고 모든 매치의 시계가 선다", SWEEP_TIMEOUT_MS, elapsedMs)
                .isLessThan(4_000L);
    }

    /**
     * CTRL — 러너가 정상이면 스윕은 <b>전이를 끝까지 마치고</b> 돌아온다. 이게 없으면 "상한에 걸려
     * 아무 일도 안 하고 돌아오는" 구현도 위 계약을 통과한다(= 시계를 고친 게 아니라 꺼 버린 것).
     */
    @Test
    void aHealthyRunnerStillCompletesTheTransitionWithinTheSweep() {
        String token = setupUserWithDeck("clk_ok");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        expireNow(matchId);
        clockService.advanceAllDue();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        expireNow(matchId);
        clockService.advanceAllDue();

        assertThat(matchState(matchId))
                .as("정상 러너에서는 감독시간 만료가 후반까지 밀고 가야 한다")
                .isEqualTo("SECOND_HALF");
    }

    private void expireNow(String matchId) {
        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                .update();
    }
}
