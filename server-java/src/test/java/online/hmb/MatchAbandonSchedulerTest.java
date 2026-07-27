package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.Map;
import java.util.function.BooleanSupplier;
import online.hmb.match.MatchAbandonSweeper;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 방치 회수 스위퍼의 <b>배선</b> 검증 (#217 AC3) — {@code MatchClockSchedulerTest} 와 같은 규율.
 *
 * <p>다른 회수 테스트는 결정론을 위해 {@link online.hmb.match.MatchLockService#sweepStale()} 을 직접
 * 부른다. 그러면 {@code @Scheduled} 가 <b>실제로 도는지</b>는 아무도 보지 않는다 — 프로퍼티 이름
 * 한 글자가 틀려도 조용히 안 돌고, 그건 곧 <b>영구 잠금의 마지막 그물이 없는 것</b>이다
 * (독립검증 "테스트가 보증하지 못하는 것" 항목). 그래서 여기서만 주기를 짧게 주고, 아무 것도
 * 호출하지 않은 채 상태가 바뀌기를 기다린다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
// 컨텍스트 캐시에 남으면 200ms 스위퍼가 **스위트 끝까지** 돈다(다른 클래스의 부하·타이밍에 얹힌다).
// 이 클래스가 끝나면 컨텍스트째 내린다 — 컨텍스트 1개 재생성 값으로 남은 스위트를 조용하게 둔다.
@org.springframework.test.annotation.DirtiesContext(
        classMode = org.springframework.test.annotation.DirtiesContext.ClassMode.AFTER_CLASS)
class MatchAbandonSchedulerTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "200"); // 이 배선이 검증 대상이다
        registry.add("hmb.match.abandon.stale-after-min", () -> "1");
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
    }

    @Resource
    private MatchAbandonSweeper sweeper;

    @Test
    void backgroundSweeperReclaimsAStaleMatchWithNobodyCallingIt() {
        String token = setupUserWithDeck("m_abandon_sched");
        String matchId = createMatch(token, null);
        // 방치 나이를 넘긴다(테스트가 시간을 앞당기는 유일한 손잡이).
        jdbcClient.sql("UPDATE matches SET created_at = ? WHERE id = ?")
                .params(Instant.now().minusSeconds(120).toString(), matchId)
                .update();

        assertThat(sweeper).as("스위퍼 빈이 컨텍스트에 있다").isNotNull();
        waitFor(() -> "ABANDONED".equals(matchState(matchId)), "방치 매치 회수(배경 스위퍼)");

        // 회수됐으니 잠금이 풀려 새 경기를 시작할 수 있다 = 이 그물이 실제로 목적을 달성한다.
        assertThat(authPost("/api/matches", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.CREATED);
    }

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
        throw new AssertionError("배경 스위퍼가 회수하지 않았다: " + what);
    }
}
