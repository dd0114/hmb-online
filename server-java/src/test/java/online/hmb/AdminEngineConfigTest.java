package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.sun.net.httpserver.HttpServer;
import jakarta.annotation.Resource;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.Map;
import java.util.concurrent.CopyOnWriteArrayList;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #383 W3 — 계수 무배포 운영 admin API (T-J5 멱등 · T-J6 검증 게이트 · T-J7 접근 게이트).
 *
 * <p>가짜 러너는 <b>검증 엔드포인트만</b> 흉내낸다: 경로가 {@code contest.} 로 시작하면 200,
 * 아니면 400 + {@code issues[]}. 실제 판정 규칙(리프 전수 대조·스모크)은 러너 쪽 계약
 * ({@code config-overlay.test.ts}·{@code config-http.test.ts})이 지킨다 — 여기서 다시 흉내내면
 * 진실이 두 곳에 적힌다. 여기서 지키는 것은 <b>"서버가 러너의 판정에 따르는가"</b> 하나다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminEngineConfigTest extends ApiTestBase {

    /** 검증만 흉내내는 최소 러너. 실제 판정 규칙은 러너 쪽 계약이 지킨다. */
    static class FakeConfigRunner {
        final HttpServer server;
        final List<String> validateCalls = new CopyOnWriteArrayList<>();

        FakeConfigRunner() {
            try {
                server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
                server.createContext("/config/validate", exchange -> {
                    String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
                    validateCalls.add(body);
                    boolean ok = !body.contains("\"nope");
                    String response = ok
                            ? "{\"effectiveConfigHash\":\"deadbeefdeadbeef\",\"engineVersion\":\"engine@test\","
                              + "\"changed\":[],\"smoke\":[]}"
                            : "{\"error\":\"invalid configOverrides\",\"issues\":[\"nope.path: "
                              + "EngineConfig 에 없는 경로입니다\"]}";
                    byte[] bytes = response.getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(ok ? 200 : 400, bytes.length);
                    try (OutputStream os = exchange.getResponseBody()) {
                        os.write(bytes);
                    }
                });
                server.createContext("/config/knobs", exchange -> {
                    byte[] bytes = ("{\"engineVersion\":\"engine@test\",\"knobs\":"
                            + "[{\"path\":\"contest.shootRange\",\"type\":\"number\",\"value\":19}]}")
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.getResponseHeaders().set("Content-Type", "application/json");
                    exchange.sendResponseHeaders(200, bytes.length);
                    try (OutputStream os = exchange.getResponseBody()) {
                        os.write(bytes);
                    }
                });
                server.start();
            } catch (Exception e) {
                throw new IllegalStateException("FakeConfigRunner 기동 실패", e);
            }
        }

        String url() {
            return "http://127.0.0.1:" + server.getAddress().getPort();
        }
    }

    static final FakeConfigRunner RUNNER = new FakeConfigRunner();

    private static final String ADMIN_NICK = "cfg_admin";
    private static final String ADMIN_PW = "cfg-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.server.stop(0);
    }

    @Resource
    private JdbcClient jdbcClient;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private ResponseEntity<Map> put(String token, Map<String, Object> body, String idemKey) {
        HttpHeaders headers = bearer(token);
        if (idemKey != null) {
            headers.set("Idempotency-Key", idemKey);
        }
        return rest.exchange(baseUrl("/api/admin/engine-config"), org.springframework.http.HttpMethod.PUT,
                new org.springframework.http.HttpEntity<>(body, headers), Map.class);
    }

    private String adminToken() {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as("admin 로그인 실패: " + res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }

    private int revisionCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM engine_config_revisions").query(Integer.class).single();
    }

    private int auditCount(String action, String result) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit WHERE action = ? AND result = ?")
                .params(action, result).query(Integer.class).single();
    }

    // ── T-J7 : 접근 게이트 ──────────────────────────────────────────────

    @Test
    void nonAdminCannotReadOrWriteEngineConfig() {
        String user = login("cfg_plain_user");
        assertThat(authGet("/api/admin/engine-config", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(put(user, Map.of("overrides", Map.of("contest.shootRange", 20), "reason", "x"), null)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void unauthenticatedIsRejected() {
        assertThat(rest.getForEntity(baseUrl("/api/admin/engine-config"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ── T-J6 : 검증 게이트 — 러너가 막으면 원장이 안 생긴다 ────────────────

    @Test
    void aRejectedOverrideCreatesNoRevisionButLeavesAFailedAuditTrail() {
        String admin = adminToken();
        int before = revisionCount();
        int auditBefore = auditCount("engine_config_set", "failed");

        ResponseEntity<Map> res = put(admin,
                Map.of("overrides", Map.of("nope.path", 1), "reason", "오타 테스트"), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(String.valueOf(res.getBody().get("message"))).contains("nope.path");
        assertThat(revisionCount())
                .as("검증에 걸린 값이 원장에 남으면 다음 매치가 그걸 쓴다")
                .isEqualTo(before);
        assertThat(auditCount("engine_config_set", "failed"))
                .as("거절된 시도도 이력이다 — 없으면 '왜 안 바뀌었나'를 아무도 모른다")
                .isEqualTo(auditBefore + 1);
    }

    @Test
    void reasonIsMandatory() {
        String admin = adminToken();
        int before = revisionCount();
        assertThat(put(admin, Map.of("overrides", Map.of("contest.shootRange", 20)), null).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(revisionCount()).isEqualTo(before);
    }

    @Test
    void nonScalarValuesAreRejectedBeforeTheRunnerIsEvenCalled() {
        String admin = adminToken();
        int callsBefore = RUNNER.validateCalls.size();
        assertThat(put(admin, Map.of("overrides", Map.of("contest.shootRange", "twenty"), "reason", "r"), null)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(RUNNER.validateCalls.size())
                .as("타입이 계약 밖이면 러너를 부르지 않는다(왕복 낭비)")
                .isEqualTo(callsBefore);
    }

    // ── T-J5 : 멱등 ─────────────────────────────────────────────────────

    @Test
    void sameKeySameContentIsAbsorbedAndSameKeyDifferentContentIs409() {
        String admin = adminToken();
        String key = "idem-" + System.nanoTime();
        Map<String, Object> body = Map.of("overrides", Map.of("contest.shootRange", 23), "reason", "멱등 테스트");

        int before = revisionCount();
        assertThat(put(admin, body, key).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(revisionCount()).isEqualTo(before + 1);

        // 같은 의도의 재전송 — 새 행을 만들지 않고 200.
        assertThat(put(admin, body, key).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(revisionCount()).isEqualTo(before + 1);

        // 같은 키 + **다른 내용** = 재전송이 아니라 사고다.
        ResponseEntity<Map> conflict = put(admin,
                Map.of("overrides", Map.of("contest.shootRange", 24), "reason", "멱등 테스트"), key);
        assertThat(conflict.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(revisionCount()).isEqualTo(before + 1);
    }

    @Test
    void sameValuesWithADifferentReasonIsADifferentOperation() {
        String admin = adminToken();
        String key = "idem-reason-" + System.nanoTime();
        Map<String, Object> overrides = Map.of("contest.shootRange", 26);
        assertThat(put(admin, Map.of("overrides", overrides, "reason", "사유 A"), key).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        // 사유가 다르면 다른 운영 행위다 — 같은 키를 재사용하면 409 여야 한다.
        assertThat(put(admin, Map.of("overrides", overrides, "reason", "사유 B"), key).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
    }

    // ── 조회·드라이런 ───────────────────────────────────────────────────

    @Test
    void currentViewSaysWhenTheValueTakesEffect() {
        String admin = adminToken();
        assertThat(put(admin, Map.of("overrides", Map.of("contest.shootRange", 27), "reason", "조회"), null)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> view = authGet("/api/admin/engine-config", admin, Map.class);
        assertThat(view.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(view.getBody()).containsKeys("revisionId", "overrides", "effectiveConfigHash", "appliesTo");
        assertThat(String.valueOf(view.getBody().get("appliesTo")))
                .as("'언제부터 적용되나'가 응답에 없으면 운영자가 '왜 아직 안 바뀌었나'를 묻게 된다")
                .contains("생성되는 매치");
    }

    @Test
    void dryRunValidatesWithoutCreatingARevision() {
        String admin = adminToken();
        int before = revisionCount();
        ResponseEntity<Map> res = authPost("/api/admin/engine-config/validate", admin,
                Map.of("overrides", Map.of("contest.shootRange", 28)), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsKey("effectiveConfigHash");
        assertThat(revisionCount()).as("드라이런은 원장을 만들지 않는다").isEqualTo(before);
    }

    @Test
    void knobsAreServedFromTheRunner() {
        ResponseEntity<Map> res = authGet("/api/admin/engine-config/knobs", adminToken(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsKey("knobs");
    }

    @Test
    void historyIsAppendOnlyAndOrderedNewestFirst() {
        String admin = adminToken();
        put(admin, Map.of("overrides", Map.of("contest.shootRange", 31), "reason", "이력 1"), null);
        put(admin, Map.of("overrides", Map.of("contest.shootRange", 32), "reason", "이력 2"), null);

        ResponseEntity<List> res = authGet("/api/admin/engine-config/history?limit=5", admin, List.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody().size()).isGreaterThanOrEqualTo(2);
        Map<?, ?> newest = (Map<?, ?>) res.getBody().get(0);
        assertThat(String.valueOf(newest.get("reason"))).isEqualTo("이력 2");
    }

    @Test
    void anEmptyOverrideIsAValidRollbackOperation() {
        String admin = adminToken();
        put(admin, Map.of("overrides", Map.of("contest.shootRange", 35), "reason", "설정"), null);
        assertThat(put(admin, Map.of("overrides", Map.of(), "reason", "기본값 복귀"), null).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> view = authGet("/api/admin/engine-config", admin, Map.class);
        assertThat((Map<?, ?>) view.getBody().get("overrides")).isEmpty();
    }
}
