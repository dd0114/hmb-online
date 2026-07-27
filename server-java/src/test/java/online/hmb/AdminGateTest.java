package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TreeSet;
import online.hmb.admin.AdminInterceptor;
import online.hmb.admin.AdminRouteGuard;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

/**
 * <b>AC-C2</b>(admin API 는 별도 인증 게이트 — 일반 유저 토큰으로 접근 불가) + AC-C1 의 "비admin 403".
 *
 * <p>이 테스트의 핵심은 상태코드가 아니다. W1 R2 에서 배운 대로 <b>부수효과가 실제로 0 인지</b>를
 * 단정한다 — 403 을 받았어도 지갑이 변했으면 그건 통과가 아니다. 그래서 거부 케이스마다
 * 지갑 잔액 · point_ledger 행 수 · admin_audit 행 수 세 값을 before/after 로 비교한다.
 *
 * <p>또 하나: 엔드포인트를 <b>손으로 열거하지 않는다</b>. Spring 의 핸들러 매핑에서 admin 라우트를
 * 실제로 읽어와 전부에 대해 401/403 을 확인하므로, 앞으로 admin 엔드포인트가 추가돼도 이 테스트가
 * 자동으로 커버한다(가드를 빠뜨린 새 엔드포인트는 여기서 바로 드러난다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminGateTest extends ApiTestBase {

    private static final String ADMIN_NICK = "gate_admin";
    private static final String ADMIN_PW = "gate-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private RequestMappingHandlerMapping handlerMapping;

    @Resource
    private AdminRouteGuard routeGuard;

    // ───────────────────────── 구조: 가드 없는 admin 엔드포인트가 불가능함 ─────────────────────────

    /**
     * admin 패키지의 모든 핸들러가 게이트 경로 접두사 안에 있다 = 인터셉터가 <b>전부</b> 덮는다.
     * (그리고 admin 라우트가 실제로 존재함도 확인 — 0개면 이 검사가 공허해진다.)
     */
    @Test
    void everyAdminHandlerIsMappedUnderTheGatedPrefix() {
        assertThat(adminRoutes()).as("admin 라우트가 하나도 없으면 게이트 검사가 공허해진다").isNotEmpty();
        assertThat(routeGuard.findUngatedAdminRoutes()).isEmpty();
    }

    /**
     * 가드의 판정 기준이 <b>패키지가 아니라 의존성</b>임을 단정한다.
     *
     * <p>검증자 뮤턴트 M10 이 정확히 이 지점을 뚫었다 — 다른 패키지({@code online.hmb.meta})에
     * admin 서비스를 쓰는 컨트롤러를 두자 패키지 필터에 걸리지 않아 부팅이 성공했고, 일반 유저
     * 토큰으로 전체 유저 명단이 200 으로 나왔다. 의존성 기준이 죽으면 <b>출하 코드에서는 증상이
     * 보이지 않으므로</b>(admin 컨트롤러는 어차피 패키지 기준으로도 잡힌다) 여기서 직접 못박는다.
     */
    @Test
    void guardClassifiesHandlersByAdminBeanDependencyNotByPackage() {
        var tainted = routeGuard.beansDependingOnAdminServices();

        // admin 전용 서비스 자신과, 그걸 주입받는 컨트롤러가 모두 오염 집합에 있어야 한다.
        assertThat(tainted)
                .as("의존성 추적이 죽었다 — 다른 패키지의 컨트롤러가 admin 서비스를 써도 안 잡힌다")
                .contains("adminUserQueryService", "adminPointsService", "adminController",
                        // #207 — 카탈로그 쓰기 빈과 그 컨트롤러도 같은 판정에 편입돼야 한다.
                        "adminCatalogService", "adminCatalogController");

        // 무관한 컨트롤러는 오염되지 않는다(기준이 '전부 잡기'로 뭉개지지 않았는지 확인).
        // catalogController(/api/players, 일반 유저용 도감)는 admin 빈에 의존하면 안 된다 —
        // 오염되면 게이트 밖 라우트라 부팅이 죽는다. 여기서 먼저 드러나게 못박는다.
        assertThat(tainted).doesNotContain("meController", "catalogController");
    }

    // ───────────────────────── 401: 미인증 ─────────────────────────

    @Test
    void unauthenticatedGetsUnauthorizedOnEveryAdminRoute() {
        for (Route route : adminRoutes()) {
            HttpStatus status = call(route, null);
            assertThat(status).as("미인증 " + route).isEqualTo(HttpStatus.UNAUTHORIZED);
        }
    }

    // ───────────────────────── 403: 인증됐지만 비admin ─────────────────────────

    @Test
    void nonAdminTokenGetsForbiddenOnEveryAdminRoute() {
        String victimToken = login("gate_victim");   // 일반 유저(비admin)
        for (Route route : adminRoutes()) {
            HttpStatus status = call(route, victimToken);
            assertThat(status).as("비admin " + route).isEqualTo(HttpStatus.FORBIDDEN);
        }
    }

    /**
     * <b>부수효과 0 단정</b> — 비admin 이 자기 자신에게 포인트를 지급하려 해도 403 이고,
     * 지갑·원장·감사 어느 것도 움직이지 않는다. (상태코드만 봤다면 W1 R2 같은 버그를 못 잡는다.)
     */
    @Test
    void forbiddenGrantHasNoSideEffectsAtAll() {
        String victimToken = login("gate_selfgrant");
        String victimId = userIdOf("gate_selfgrant");

        long walletBefore = points(victimId);
        long ledgerBefore = ledgerCount(victimId);
        long auditBefore = auditCount();

        Map<String, Object> body = new HashMap<>();
        body.put("delta", 999999);
        body.put("reason", "self grant attempt");
        HttpStatus status = postAdmin("/api/admin/users/" + victimId + "/points", victimToken, body);

        assertThat(status).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(points(victimId)).as("403 인데 지갑이 변했다").isEqualTo(walletBefore);
        assertThat(ledgerCount(victimId)).as("403 인데 원장이 늘었다").isEqualTo(ledgerBefore);
        assertThat(auditCount()).as("403 인데 감사 행이 늘었다").isEqualTo(auditBefore);
    }

    /** 미인증(토큰 없음) 지급 시도도 마찬가지로 부수효과 0. */
    @Test
    void unauthenticatedGrantHasNoSideEffectsAtAll() {
        login("gate_target_anon");
        String targetId = userIdOf("gate_target_anon");

        long walletBefore = points(targetId);
        long ledgerBefore = ledgerCount(targetId);
        long auditBefore = auditCount();

        Map<String, Object> body = new HashMap<>();
        body.put("delta", 5000);
        body.put("reason", "anonymous grant attempt");
        HttpStatus status = postAdmin("/api/admin/users/" + targetId + "/points", null, body);

        assertThat(status).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(points(targetId)).isEqualTo(walletBefore);
        assertThat(ledgerCount(targetId)).isEqualTo(ledgerBefore);
        assertThat(auditCount()).isEqualTo(auditBefore);
    }

    /** 게이트가 admin 을 막지는 않는다(무회귀) — 같은 경로가 admin 토큰으로는 통과한다. */
    @Test
    void adminTokenPassesTheSameGate() {
        String adminToken = localLogin(ADMIN_NICK, ADMIN_PW);
        assertThat(getAdmin("/api/admin/users", adminToken)).isEqualTo(HttpStatus.OK);
    }

    /** 일반 API 는 admin 게이트의 영향을 받지 않는다(무회귀). */
    @Test
    void nonAdminRoutesAreUnaffected() {
        String token = login("gate_regular");
        assertThat(authGet("/api/me", token, String.class).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ───────────────────────── helpers ─────────────────────────

    private record Route(HttpMethod method, String path, String pattern) {
        @Override
        public String toString() {
            return method + " " + pattern;
        }
    }

    /** Spring 핸들러 매핑에서 admin 라우트를 실제로 읽어온다(손 열거 금지 — 새 엔드포인트 자동 커버). */
    private List<Route> adminRoutes() {
        List<Route> routes = new ArrayList<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : handlerMapping.getHandlerMethods().entrySet()) {
            Set<String> patterns = new TreeSet<>();
            if (e.getKey().getPathPatternsCondition() != null) {
                e.getKey().getPathPatternsCondition().getPatterns()
                        .forEach(p -> patterns.add(p.getPatternString()));
            }
            if (e.getKey().getPatternsCondition() != null) {
                patterns.addAll(e.getKey().getPatternsCondition().getPatterns());
            }
            for (String pattern : patterns) {
                if (!pattern.startsWith(AdminInterceptor.ADMIN_PATH_PREFIX)) {
                    continue;
                }
                // {id} 같은 경로 변수는 더미로 치환 — 게이트는 핸들러 실행 전이라 존재 여부와 무관하다.
                String concrete = pattern.replaceAll("\\{[^/}]+}", "GATE_PROBE_ID");
                var methods = e.getKey().getMethodsCondition().getMethods();
                if (methods.isEmpty()) {
                    // 메서드 조건이 없는 매핑(@RequestMapping 만)도 조용히 건너뛰지 않는다 — GET 으로 찔러본다.
                    routes.add(new Route(HttpMethod.GET, concrete, pattern));
                } else {
                    // findFirst 로 하나만 찌르면 다중 메서드 매핑의 나머지가 검사되지 않는다 → 전부 찌른다.
                    methods.forEach(m -> routes.add(new Route(HttpMethod.valueOf(m.name()), concrete, pattern)));
                }
            }
        }
        return routes;
    }

    /**
     * <b>라우트의 실제 HTTP 메서드로 찌른다</b>(#207). 이전 구현은 POST 가 아니면 전부 GET 으로
     * 대체했는데, 그러면 PATCH/DELETE 전용 매핑은 <b>핸들러를 못 찾아 405 로 튕기고</b> 게이트
     * 자체가 실행되지 않는다 — 401/403 단정이 그 라우트를 <b>검사하지 못한 채</b> 실패하거나,
     * 더 나쁘게는 메서드를 바꾸면 조용히 커버가 사라진다. 메서드를 그대로 쓰면 인터셉터가
     * 실제로 그 라우트에서 도는지 확인된다.
     */
    private HttpStatus call(Route route, String token) {
        return send(route.method().name(), route.path(), token,
                Map.of("delta", 1, "reason", "probe"));
    }

    private HttpStatus getAdmin(String path, String token) {
        return send("GET", path, token, null);
    }

    private HttpStatus postAdmin(String path, String token, Map<String, Object> body) {
        return send("POST", path, token, body);
    }

    /** JDK HttpClient 직접 사용 — TestRestTemplate 은 POST 401 에서 예외를 던진다(ApiTestBase 주석). */
    private HttpStatus send(String method, String path, String token, Map<String, Object> body) {
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json");
            if (token != null) {
                builder.header("Authorization", "Bearer " + token);
            }
            if ("GET".equals(method) || "HEAD".equals(method) || "OPTIONS".equals(method)) {
                builder.method(method, java.net.http.HttpRequest.BodyPublishers.noBody());
            } else {
                builder.method(method, java.net.http.HttpRequest.BodyPublishers.ofString(
                        MAPPER.writeValueAsString(body == null ? Map.of() : body)));
            }
            return HttpStatus.valueOf(
                    java.net.http.HttpClient.newHttpClient()
                            .send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString())
                            .statusCode());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String localLogin(String nickname, String password) {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", nickname);
        body.put("password", password);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as("admin 로그인 실패: " + res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT COALESCE(points, 0) FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).optional().orElse(0L);
    }

    private long ledgerCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long auditCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_audit").query(Long.class).single();
    }
}
