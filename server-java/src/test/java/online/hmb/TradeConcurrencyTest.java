package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #152: 같은 슬롯에 쓰기 요청이 동시에 몰려도 <b>5xx 가 유저에게 나가면 안 된다</b>.
 *
 * <p>배경: SQLite WAL 에서 "읽기로 시작한 트랜잭션이 나중에 쓰기로 승격"할 때 그 사이 다른 커넥션이
 * 커밋했으면 SQLITE_BUSY(스냅샷 무효)가 <b>busy_timeout 을 기다리지 않고 즉시</b> 반환된다 —
 * 기다려도 해결되지 않는 상황이라 busy handler 가 호출되지 않기 때문. 트레이드 서비스 진입점은
 * 전부 SELECT(ensureSlots/requireSlot) → UPDATE(openIfDue 등) 순서라 이 패턴에 정확히 해당한다.
 *
 * <p>정합성은 원래도 지켜졌다(오퍼 1개). 이 테스트가 박제하는 것은 <b>에러 표면</b>이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class TradeConcurrencyTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    private final HttpClient client = HttpClient.newHttpClient();

    /** 상태코드 + 본문(진단용 — 실패 메시지에 그대로 실어 원인을 눈으로 본다). */
    private record Res(int status, String body) {
    }

    private Res postStart(String token, int slotNo) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl("/api/trade/" + slotNo + "/start")))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.noBody())
                .build();
        HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
        return new Res(res.statusCode(), res.body());
    }

    @Test
    void concurrentStartNeverReturns5xxAndCreatesExactlyOneOffer() throws Exception {
        String token = login("trade_conc");
        String uid = jdbcClient.sql("SELECT id FROM users WHERE nickname=?")
                .param("trade_conc").query(String.class).single();
        authGet("/api/trade", token, Map.class); // IDLE 슬롯 3개 생성

        int threads = 8;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Res>> futures = new java.util.ArrayList<>();
        for (int i = 0; i < threads; i++) {
            Callable<Res> task = () -> {
                go.await();
                return postStart(token, 1);
            };
            futures.add(pool.submit(task));
        }
        go.countDown();
        pool.shutdown();
        assertThat(pool.awaitTermination(60, TimeUnit.SECONDS)).isTrue();

        List<Res> responses = new java.util.ArrayList<>();
        for (Future<Res> f : futures) {
            responses.add(f.get());
        }
        List<Integer> codes = responses.stream().map(Res::status).toList();
        // 핵심 계약: 5xx 0건
        assertThat(codes).as("응답 %s", responses).noneMatch(c -> c >= 500);
        // 정확히 1개만 장을 연다(나머지는 카운트다운 중 → 400)
        assertThat(codes.stream().filter(c -> c == 200).count()).isEqualTo(1L);
        assertThat(codes.stream().filter(c -> c == 400).count()).isEqualTo(threads - 1L);

        // 오퍼는 1개만 생성되고 슬롯 행도 1개(정합성 무회귀)
        Map<String, Object> row = jdbcClient.sql("""
                        SELECT COUNT(*) AS n, MIN(state) AS state FROM trade_slots
                        WHERE user_id=? AND slot_no=1
                        """)
                .param(uid).query((rs, n) -> Map.<String, Object>of(
                        "n", rs.getInt("n"), "state", rs.getString("state")))
                .single();
        assertThat(row.get("n")).isEqualTo(1);
        assertThat(row.get("state")).isEqualTo("WAITING");
        // 장을 연 건 1회뿐이므로 trade_log(거래 안함) 도 남지 않는다
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM trade_log WHERE user_id=?")
                .param(uid).query(Long.class).single()).isEqualTo(0L);
    }
}
