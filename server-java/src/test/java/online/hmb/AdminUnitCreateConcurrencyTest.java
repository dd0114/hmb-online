package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
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
 * <b>#207 blocker B1</b>: {@code POST /api/admin/units} 의 멱등이 <b>동시 요청</b>에서 붕괴하던 것.
 *
 * <p><b>왜 이 파일이 따로 있나</b>: {@link AdminUnitCatalogTest} 의 멱등 계약 21건은 전부 <b>순차</b>다.
 * 순차만 보면 사전조회(check-then-act)와 진짜 백스톱을 구분할 수 없어, 게이트가 이 결함을 <b>구조적으로</b>
 * 통과시켰다. 독립 검증자가 실서버로 재현한 것:
 *
 * <pre>
 *   같은 Idempotency-Key 로 POST 10발 동시
 *     → HTTP 200, 200, 500 x8 · players 에 유닛 2개 · 감사에 같은 키 2행
 *   그 뒤 **순차** 요청도 영구 500 (IncorrectResultSizeDataAccessException)
 * </pre>
 *
 * <p>여기서 박제하는 계약은 셋이다. ① 동시 N발에도 <b>유닛은 정확히 1개</b> ② 응답은 200 재생/409 뿐,
 * <b>5xx 0건</b> ③ 경합이 끝난 뒤 <b>같은 키가 계속 쓸 수 있어야</b> 한다(영구 500 금지).
 *
 * <p>단정은 상태코드만 보지 않는다 — {@code players} 행 수 · {@code admin_catalog_audit} 행 수를 함께
 * 본다({@link AdminPointsTest} 규약). "200 은 났는데 유닛이 둘"이 이 결함의 실제 모습이었다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUnitCreateConcurrencyTest extends ApiTestBase {

    private static final String ADMIN_NICK = "unit_conc_admin";
    private static final String ADMIN_PW = "unit-conc-admin-pw-1234";

    /** 동시 요청 수. 검증자 재현(10발)과 같은 규모 — 커넥션 풀(5)보다 크게 잡아 경합을 실제로 만든다. */
    private static final int THREADS = 10;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    private final HttpClient client = HttpClient.newHttpClient();

    private record Res(int status, String body) {
    }

    // ───────────────────────── 계약 ─────────────────────────

    /**
     * <b>같은 키로 동시 N발 → 유닛 1개.</b> 그리고 그 키는 경합 후에도 <b>계속 살아 있어야</b> 한다.
     *
     * <p>후속 순차 요청까지 한 메서드에 넣은 이유: 이 둘은 <b>인과</b>다(경합이 DB 를 오염시켜야 영구
     * 500 이 난다). 별 메서드로 쪼개면 JUnit 실행 순서에 의존하게 되고, 오염이 안 일어난 상태에서
     * "500 아님"만 확인하는 공허한 테스트가 된다.
     */
    @Test
    void concurrentCreateWithSameKeyYieldsExactlyOneUnitAndNever5xx() throws Exception {
        String admin = adminToken();
        String idemKey = "K-RACE-same";
        String unitName = "동시생성-단일키";
        Map<String, Object> body = createBody(unitName);

        long unitsBefore = countPlayers();
        List<Res> responses = fireConcurrently(THREADS, i -> post(admin, idemKey, body));

        // ① 5xx 0건 — 검증자 실측은 8건이었다.
        assertThat(statuses(responses)).as("5xx 가 새어 나갔다: %s", responses)
                .noneMatch(c -> c >= 500);
        // ② 응답은 정의된 두 가지뿐(200 재생 / 409 다른내용). 내용이 같으므로 전부 200 이어야 한다.
        assertThat(statuses(responses)).as("정의되지 않은 상태코드: %s", responses)
                .allMatch(c -> c == 200);

        // ③ 적용은 정확히 1건, 나머지는 재생(applied:false).
        List<Map<String, Object>> bodies = responses.stream().map(r -> parse(r.body())).toList();
        assertThat(bodies.stream().filter(b -> Boolean.TRUE.equals(b.get("applied"))).count())
                .as("applied:true 가 1건이 아니다 = 유닛이 여러 개 생겼다: %s", responses)
                .isEqualTo(1L);

        // ④ **DB 실측**이 핵심이다 — 상태코드는 거짓말할 수 있어도 행 수는 못 한다.
        assertThat(countPlayersNamed(unitName)).as("같은 키인데 유닛이 여러 개 생겼다").isEqualTo(1L);
        assertThat(countPlayers()).as("players 총 행 수가 1 초과로 늘었다").isEqualTo(unitsBefore + 1);
        assertThat(countAuditWithKey(idemKey)).as("감사에 같은 키가 여러 행 남았다 = 이후 조회가 터진다")
                .isEqualTo(1L);

        // ⑤ 재생 응답도 승자의 유닛을 그대로 돌려준다(클라가 id 를 잃지 않게 — 순차 계약과 동일).
        List<String> ids = bodies.stream()
                .map(b -> (String) ((Map<?, ?>) b.get("unit")).get("id")).distinct().toList();
        assertThat(ids).as("응답마다 다른 유닛을 가리킨다: %s", responses).hasSize(1);

        // ⑥ 경합 이후에도 그 키는 **영구 500 이 아니다** — 이게 원 결함의 진짜 후유증이었다.
        Res after = post(admin, idemKey, body);
        assertThat(after.status()).as("경합 뒤 순차 요청이 죽었다: %s", after).isEqualTo(200);
        assertThat(parse(after.body()).get("applied")).isEqualTo(false);
        assertThat(((Map<?, ?>) parse(after.body()).get("unit")).get("id")).isEqualTo(ids.get(0));
        assertThat(countPlayersNamed(unitName)).isEqualTo(1L);

        // ⑦ 같은 키 + **다른 내용** 은 경합 이후에도 409(순차 계약 무회귀 — 조용히 삼키지 않는다).
        Res conflict = post(admin, idemKey, createBody("동시생성-다른이름"));
        assertThat(conflict.status()).as("같은 키에 다른 내용인데 삼켰다: %s", conflict).isEqualTo(409);
        assertThat(countPlayersNamed("동시생성-다른이름")).isZero();
    }

    /**
     * <b>서로 다른 키로 동시 N발 → 유닛 N개.</b> 이쪽은 재전송이 아니라 <b>진짜 동시 생성</b>이라
     * 하나도 잃으면 안 된다.
     *
     * <p>여기가 {@code nextPlayerId()} 의 PK 경합 경로다(두 요청이 같은 max 를 읽어 같은 번호를 잡음).
     * 옛 주석은 이걸 "409 로 떨어진다"고 적었지만 운영자가 의도한 건 <b>유닛 2개</b>라 409 는 오답이다 —
     * 재시도로 흡수하고, id 는 <b>전부 달라야</b> 한다(재사용하면 기보유 유저 카드가 뒤바뀐다).
     */
    @Test
    void concurrentCreateWithDistinctKeysCreatesEveryUnitWithUniqueIds() throws Exception {
        String admin = adminToken();
        long unitsBefore = countPlayers();

        List<Res> responses = fireConcurrently(THREADS,
                i -> post(admin, "K-RACE-distinct-" + i, createBody("동시생성-다중키-" + i)));

        assertThat(statuses(responses)).as("5xx 가 새어 나갔다: %s", responses).noneMatch(c -> c >= 500);
        assertThat(statuses(responses)).as("동시 생성이 거절됐다: %s", responses).allMatch(c -> c == 200);

        assertThat(countPlayers()).as("동시 생성 중 일부가 유실됐다").isEqualTo(unitsBefore + THREADS);
        List<String> ids = responses.stream()
                .map(r -> (String) ((Map<?, ?>) parse(r.body()).get("unit")).get("id")).toList();
        assertThat(ids).as("서로 다른 요청이 같은 유닛 id 를 받았다").doesNotHaveDuplicates();
        // id 재사용 금지 = players 의 유일성으로도 확인(응답만 다르고 DB 는 덮였을 수 있다).
        assertThat(jdbcClient.sql("SELECT COUNT(DISTINCT id) FROM players").query(Long.class).single())
                .isEqualTo(countPlayers());
    }

    // ───────────────────────── 헬퍼 ─────────────────────────

    private interface Task {
        Res run(int index) throws Exception;
    }

    /** N개 요청을 래치로 정렬해 <b>실제로 동시에</b> 쏜다(순차 반복이면 이 결함은 재현되지 않는다). */
    private List<Res> fireConcurrently(int threads, Task task) throws Exception {
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Res>> futures = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            final int index = i;
            futures.add(pool.submit(() -> {
                go.await();
                return task.run(index);
            }));
        }
        go.countDown();
        pool.shutdown();
        assertThat(pool.awaitTermination(120, TimeUnit.SECONDS)).as("동시 요청이 끝나지 않았다").isTrue();
        List<Res> out = new ArrayList<>();
        for (Future<Res> f : futures) {
            out.add(f.get());
        }
        return out;
    }

    private static List<Integer> statuses(List<Res> responses) {
        return responses.stream().map(Res::status).toList();
    }

    private Res post(String token, String idemKey, Map<String, Object> body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl("/api/admin/units")))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", idemKey)
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
        return new Res(res.statusCode(), res.body());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parse(String json) {
        try {
            return MAPPER.readValue(json, Map.class);
        } catch (Exception e) {
            throw new IllegalStateException("bad json: " + json, e);
        }
    }

    private static Map<String, Object> createBody(String name) {
        Map<String, Object> attrs = new HashMap<>();
        for (String k : List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning")) {
            attrs.put(k, 80);
        }
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        body.put("position", "FW");
        body.put("grade", "LEGEND");
        body.put("attributes", attrs);
        body.put("personality", "CALM");
        body.put("reason", "동시 생성 계약 검증");
        return body;
    }

    private String adminToken() {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status().value()).as(res.body()).isEqualTo(200);
        return (String) asMap(res).get("token");
    }

    private long countPlayers() {
        return jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single();
    }

    private long countPlayersNamed(String name) {
        return jdbcClient.sql("SELECT COUNT(*) FROM players WHERE name = ?").param(name)
                .query(Long.class).single();
    }

    private long countAuditWithKey(String idemKey) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit WHERE idem_key = ?")
                .param(idemKey).query(Long.class).single();
    }
}
