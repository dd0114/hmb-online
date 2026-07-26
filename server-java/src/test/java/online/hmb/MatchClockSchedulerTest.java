package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.Map;
import java.util.function.BooleanSupplier;
import online.hmb.match.MatchClockService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * "화면을 안 봐도 경기가 진행된다"(P4-D1)를 <b>배경 스케줄러 실동작</b>으로 검증한다 (#170).
 *
 * <p>다른 시계 테스트들은 결정론을 위해 `@Scheduled` 를 끄고 {@code sweep()} 을 직접 호출한다. 그러면
 * <b>스케줄러 배선 자체</b>는 아무도 검증하지 않게 된다 — 실제로 {@code @Scheduled} 애노테이션을 통째로
 * 지워도 전 스위트가 green 이었다(독립검증 major). 게다가 후반 시작은 이제 스위퍼 단독 의존이다
 * (조회 경로는 무거운 전이를 하지 않는다). 그래서 이 클래스만 **짧은 주기로 스위퍼를 실제로 돌리고
 * 기다린다** — 여기서 쓰는 유일한 도구는 "아무 것도 호출하지 않고 시간이 지나면 상태가 변한다"이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchClockSchedulerTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.clock.enabled", () -> "true");
        // 배경 스위퍼를 촘촘히 돌린다 — 이 테스트의 검증 대상이 바로 그 배선이다.
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "200");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Test
    void backgroundSweeperAdvancesTheMatchWithNobodyWatching() {
        String token = setupUserWithDeck("clk_sched");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");

        // 전반 창이 끝났다. 아무도 GET 하지 않고, sweep() 도 부르지 않는다 — 스케줄러만 남는다.
        expireNow(matchId);
        waitFor(() -> "HALFTIME".equals(matchState(matchId)), "전반 종료 → 감독시간(배경 스위퍼)");

        // 감독시간 만료 → 후반 시작. 이건 **무거운 전이**(엔진 RPC)라 조회 경로가 대신해주지 않는다.
        expireNow(matchId);
        waitFor(() -> "SECOND_HALF".equals(matchState(matchId)), "감독시간 만료 → 후반(배경 스위퍼)");

        // 후반 창이 끝나면 정산까지 배경에서 끝난다(보상 지급 = 유저가 창을 닫아도 유실 없음).
        expireNow(matchId);
        waitFor(() -> "FINISHED".equals(matchState(matchId)), "후반 종료 → 정산(배경 스위퍼)");
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'")
                .param(matchId).query(Long.class).single()).isEqualTo(1L);
    }

    /** 현재 단계를 과거로 밀어 만료시킨다(테스트가 시간을 앞당기는 유일한 손잡이). */
    private void expireNow(String matchId) {
        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                .update();
    }

    /** 조건이 참이 될 때까지 기다린다(최대 10초). 실패 메시지에 무엇을 기다렸는지 남긴다. */
    private void waitFor(BooleanSupplier condition, String what) {
        long deadline = System.nanoTime() + java.time.Duration.ofSeconds(10).toNanos();
        while (System.nanoTime() < deadline) {
            if (condition.getAsBoolean()) {
                return;
            }
            try {
                Thread.sleep(50);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        throw new AssertionError("배경 스위퍼가 진행시키지 않았다: " + what);
    }
}
