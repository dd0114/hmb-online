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
