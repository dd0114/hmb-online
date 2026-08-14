package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import java.time.Duration;
import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import online.hmb.match.MatchClockService;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

/**
 * <b>#512 — 스윕 작업 하나가 안 끝나면 시계가 통째로 선다.</b>
 *
 * <p>{@code advanceAllDue} 는 매치별 작업을 병렬로 던진 뒤 <b>타임아웃 없이</b> {@code f.get()} 으로
 * 전부 기다렸다. 그런데 그 작업 안에는 엔진 RPC 가 있고(재사용 경로에서는 스위퍼 스레드가 직접 탄다),
 * 그 RPC 는 러너가 <b>본문 중간에 멈추면 영원히 안 돌아온다</b>({@code EngineRunnerStallTest}).
 * 스위퍼는 {@code @Scheduled(fixedDelay)} 라 이번 실행이 끝나야 다음이 뜨므로, 한 번 매달리면
 * <b>모든 매치의 자동 진행이 프로세스 재시작 전까지 멈춘다</b>.
 *
 * <p>그래서 여기서 재는 것은 "느린 매치가 있어도 스위퍼 루프는 살아 돌아오는가"다. 근인(위 RPC)을
 * 고쳐도 이 계약은 남긴다 — <b>다음에 어떤 블로킹 호출이 그 사슬에 들어와도 시계는 안 서야 한다</b>.
 *
 * <p>⚠️ 대기 상한을 직접 부르는 이유: 이 성질을 매치 픽스처로 재현하려면 "영원히 안 끝나는 전이"를
 * DB 상태로 만들어야 하는데, 그건 결함을 재현하는 것이 아니라 <b>다른 결함을 새로 만드는 것</b>이다.
 * {@code isDue} 를 순수 함수로 떼어 직접 검정하는 것과 같은 관용구.
 */
class MatchClockSweepBoundTest {

    private final ExecutorService pool = Executors.newFixedThreadPool(2);
    private final CountDownLatch release = new CountDownLatch(1);

    @AfterEach
    void releaseBlockedTasks() {
        release.countDown();
        pool.shutdownNow();
    }

    @Test
    void oneStuckTaskDoesNotBlockTheSweepForever() {
        AtomicBoolean fastRan = new AtomicBoolean(false);
        Future<?> stuck = pool.submit(() -> {
            try {
                release.await(120, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        Future<?> fast = pool.submit(() -> fastRan.set(true));

        assertTimeoutPreemptively(Duration.ofSeconds(20), () -> {
            long t0 = System.nanoTime();
            MatchClockService.awaitAll(List.of(stuck, fast), 1_500L);
            long elapsedMs = (System.nanoTime() - t0) / 1_000_000;

            assertThat(elapsedMs)
                    .as("상한 1.5s 인데 %d ms 매달렸다 — 스위퍼가 안 돌아오면 시계가 선다", elapsedMs)
                    .isLessThan(10_000L);
        });

        // 막힌 작업 하나가 나머지를 취소시키지도 않는다(한 매치의 사고가 다른 매치를 끄지 않는다).
        assertThat(fastRan).isTrue();
    }

    /** CTRL — 정상 작업만 있으면 상한과 무관하게 <b>전부 끝난 뒤</b> 돌아온다(semantics 유지). */
    @Test
    void normalTasksAreStillAwaitedToCompletion() {
        AtomicBoolean done = new AtomicBoolean(false);
        Future<?> slowish = pool.submit(() -> {
            try {
                Thread.sleep(300);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            done.set(true);
        });

        MatchClockService.awaitAll(List.of(slowish), 10_000L);

        assertThat(done)
                .as("상한 전에 끝나는 작업은 기다려야 한다 — 테스트가 sweep() 반환 후 상태를 단정한다")
                .isTrue();
    }
}
