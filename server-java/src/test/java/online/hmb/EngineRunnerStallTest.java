package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.junit.jupiter.api.Assertions.assertTimeoutPreemptively;

import com.sun.net.httpserver.HttpServer;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.time.Duration;
import java.util.Map;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import online.hmb.engine.EngineRunnerClient;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

/**
 * <b>#512 — 러너가 응답 <u>본문 중간</u>에 멈추면 호출이 영원히 안 돌아온다.</b>
 *
 * <p>{@code EngineRunnerClient} 는 `connectTimeout(5s)` + 요청 `.timeout(simulate-timeout-sec)` 을 걸고
 * 있어서 "타임아웃이 있으니 유한하다"로 읽힌다. <b>아니다</b> — {@code HttpRequest.timeout} 은
 * <b>응답 헤더가 도착할 때까지</b>만 센다. 헤더가 온 뒤 본문이 멈추면 {@code HttpClient.send} 는
 * 그 자리에 매달린다(JDK 21 실측: 요청 타임아웃 3s 에 120s 넘게 반환 없음).
 *
 * <p>왜 이게 시계 문제인가: 이 호출은 <b>스위퍼 스레드가 직접</b> 탈 수 있다(양쪽 AI 인풋이 재사용으로
 * 해소되는 경로 = {@code insertMaterialized} → {@code maybeSimulate}. 오토 매치는 감독시간이 0초라
 * 사실상 항상 그 경로다). 그리고 스위퍼는 {@code @Scheduled(fixedDelay)} 라 <b>이번 실행이 끝나야
 * 다음이 뜬다</b> — 즉 여기서 매달리면 <b>모든 매치의 자동 진행이 영구히 멈춘다</b>.
 *
 * <p>⚠️ 이 테스트가 없으면 그 결함은 <b>어떤 게이트에도 안 걸린다</b>: 정상 러너와 죽은 러너는
 * 둘 다 유한하게 끝나므로, 기존 테스트 전부가 green 인 채로 이 사각이 남는다.
 *
 * <p>⚠️ {@code assertTimeoutPreemptively} 를 쓰는 이유 = 실패가 <b>hang 이 아니라 red</b> 여야 하기
 * 때문이다. 수정 전에는 이 테스트가 걸려서 죽고, 수정 후에는 예외로 끝난다.
 */
class EngineRunnerStallTest {

    private HttpServer server;
    /** 서버 핸들러가 영원히 잠들어 있는 것을 테스트 종료 때 깨운다(스레드 누수 방지). */
    private final CountDownLatch release = new CountDownLatch(1);

    @BeforeEach
    void startStallingRunner() throws Exception {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/simulate", ex -> {
            // 200 + Content-Length 를 보내고 본문 일부만 흘린 뒤 **더 보내지 않는다**(연결은 살아 있다).
            ex.sendResponseHeaders(200, 1_000_000);
            OutputStream os = ex.getResponseBody();
            os.write("{\"matchLog\":".getBytes());
            os.flush();
            try {
                release.await(120, TimeUnit.SECONDS);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
        });
        server.setExecutor(Executors.newFixedThreadPool(2));
        server.start();
    }

    @AfterEach
    void stopRunner() {
        release.countDown();
        server.stop(0);
    }

    private EngineRunnerClient clientFor(int port, long timeoutSec) {
        return new EngineRunnerClient(new online.hmb.common.Json().objectMapper(),
                "http://127.0.0.1:" + port, timeoutSec, 0);
    }

    @Test
    void aStalledResponseBodyEndsInAnExceptionNotAHang() {
        // 요청 타임아웃 2s · 재시도 0 — 마감이 교환 전체에 걸린다면 몇 초 안에 끝나야 한다.
        EngineRunnerClient client = clientFor(server.getAddress().getPort(), 2);

        assertTimeoutPreemptively(Duration.ofSeconds(40), () -> {
            long t0 = System.nanoTime();
            assertThatThrownBy(() -> client.simulate("seed", Map.of(), Map.of(), Map.of(), 1, null, null))
                    .as("본문이 멈춘 러너는 **예외로** 끝나야 한다 — 매달리면 시계가 통째로 선다")
                    .isInstanceOf(RuntimeException.class);
            long elapsedMs = (System.nanoTime() - t0) / 1_000_000;
            // 헤더는 즉시 왔다 — 구 동작에서는 이 값이 무한대다(그때는 위 preemptive 가 죽인다).
            assertThat(elapsedMs)
                    .as("요청 타임아웃 2s 인데 %d ms 걸렸다 — 본문 정지가 마감 밖이다", elapsedMs)
                    .isLessThan(30_000L);
        });
    }

    /**
     * <b>인터럽트는 재시도하지 않는다</b> (#512 R1, 독립 검증 m4/m9).
     *
     * <p>인터럽트가 오는 자리는 {@code sweepPool.shutdownNow()}(= 종료 중)다. 그런데
     * {@code callOnce} 가 검사예외를 {@code IllegalStateException} 으로 감싸므로, 아무 조치가 없으면
     * 재시도 루프가 <b>인터럽트 플래그가 지워진 채 한 번 더</b> 러너를 부른다 — 종료가 마감 하나만큼
     * 더 늦어진다. 종류로는 못 가르므로 <b>플래그로</b> 가른다.
     *
     * <p>⚠️ 재시도를 1 로 켜 두는 것이 이 계약의 핵심이다 — 0 이면 루프가 한 번뿐이라 고치기 전에도
     * 통과한다(= 공허).
     *
     * <p>⚠️ <b>이 계약이 무는 변이는 하나다</b>(실측): {@code sendBounded} 의 {@code InterruptedException}
     * 처리(취소 + 플래그 복원)를 지우면 <b>죽는다</b>. 반면 재시도 루프의 플래그 검사를 지우는 변이는
     * <b>산다</b> — 플래그가 서 있으면 다음 시도의 {@code get()} 이 즉시 던져 결과가 같기 때문이다.
     * 그 줄은 백스톱이지 이 계약의 판별축이 아니다(그렇게 적어 두지 않으면 다음 사람이 "계약이
     * 지켜 준다"고 믿고 지운다).
     */
    @Test
    void anInterruptStopsTheRetryLoopInsteadOfSpendingAnotherDeadline() throws Exception {
        // ⚠️ 인자 `3` 은 **요청 타임아웃**이고 교환 마감은 그 두 배(6s)다. 고치기 전에는 2회차가
        // 그 **마감 1회분(6s)** 을 통째로 태운다(실측 6.5s). 인터럽트는 첫 왕복 도중에 넣는다.
        EngineRunnerClient client = new EngineRunnerClient(new online.hmb.common.Json().objectMapper(),
                "http://127.0.0.1:" + server.getAddress().getPort(), 3, 1);

        AtomicBoolean flagAfter = new AtomicBoolean(false);
        AtomicLong elapsedMs = new AtomicLong(-1);
        Thread caller = new Thread(() -> {
            long t0 = System.nanoTime();
            try {
                client.simulate("seed", Map.of(), Map.of(), Map.of(), 1, null, null);
            } catch (RuntimeException expected) {
                // 종류가 아니라 **시간과 플래그**가 이 계약의 관측 대상이다.
            }
            elapsedMs.set((System.nanoTime() - t0) / 1_000_000);
            flagAfter.set(Thread.currentThread().isInterrupted());
        });
        caller.start();
        Thread.sleep(500);
        caller.interrupt();
        caller.join(20_000);

        assertThat(elapsedMs.get())
                .as("인터럽트 뒤 %d ms 를 더 썼다 — 재시도를 한 번 더 태우면 교환 마감(6s)이 통째로 붙는다",
                        elapsedMs.get())
                .isBetween(0L, 2_500L);
        assertThat(flagAfter)
                .as("인터럽트 플래그를 삼키면 상위(스윕 풀 종료)가 중단 신호를 잃는다")
                .isTrue();
    }

    /**
     * CTRL — 마감을 걸어도 **정상 응답은 그대로 통과한다**. 이게 없으면 "전부 던지게" 만든 변경도
     * 위 계약을 통과한다(= 고친 것이 아니라 부순 것).
     */
    @Test
    void aHealthyRunnerStillReturnsItsResult() throws Exception {
        HttpServer healthy = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        healthy.createContext("/simulate", ex -> {
            byte[] out = ("{\"matchLog\":{\"finalScore\":{\"home\":1,\"away\":0}},"
                    + "\"lastHash\":\"h\",\"playbackMs\":1234}").getBytes();
            ex.sendResponseHeaders(200, out.length);
            try (OutputStream os = ex.getResponseBody()) {
                os.write(out);
            }
        });
        healthy.setExecutor(Executors.newFixedThreadPool(2));
        healthy.start();
        try {
            EngineRunnerClient client = clientFor(healthy.getAddress().getPort(), 5);
            EngineRunnerClient.SimulateResult result =
                    client.simulate("seed", Map.of(), Map.of(), Map.of(), 1, null, null);
            assertThat(result.lastHash()).isEqualTo("h");
            assertThat(result.playbackMs()).isEqualTo(1234L);
        } finally {
            healthy.stop(0);
        }
    }
}
