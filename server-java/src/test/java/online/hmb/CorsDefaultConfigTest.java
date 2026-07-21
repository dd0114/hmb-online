package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * CORS(이슈 #128, 오픈 blocker B1) — env 미설정(기본값 http://localhost:5173) 상태의 계약.
 *
 * <p>상태코드만 보지 않고 <b>어느 헤더가 무슨 값으로 붙었는지/안 붙었는지</b>까지 단정한다.
 * "미허용 오리진인데 Access-Control-Allow-Origin 이 안 붙는다"가 핵심 방어선이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class CorsDefaultConfigTest {

    private static final String ALLOWED = "http://localhost:5173";
    private static final String DISALLOWED = "https://evil.example.com";
    private static final String ACAO = "Access-Control-Allow-Origin";
    private static final String ACAM = "Access-Control-Allow-Methods";
    private static final String ACAH = "Access-Control-Allow-Headers";
    private static final String ACAC = "Access-Control-Allow-Credentials";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @LocalServerPort
    private int port;

    private final HttpClient http = HttpClient.newHttpClient();
    private final TestRestTemplate rest = new TestRestTemplate();

    private String url(String path) {
        return "http://localhost:" + port + path;
    }

    /** preflight OPTIONS 발사 — Origin + Access-Control-Request-Method(+ optional headers). */
    private HttpResponse<String> preflight(String path, String origin, String requestMethod, String requestHeaders) {
        try {
            HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(url(path)))
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .header("Origin", origin)
                    .header("Access-Control-Request-Method", requestMethod);
            if (requestHeaders != null) {
                b.header("Access-Control-Request-Headers", requestHeaders);
            }
            return http.send(b.build(), HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Optional<String> header(HttpResponse<String> res, String name) {
        return res.headers().firstValue(name);
    }

    // ── 요구 3 + 함정: 허용 오리진 preflight 가 인증경로여도 401 이 아니고 CORS 헤더가 붙는다 ──

    @Test
    void allowedOriginPreflightOnLoginReturnsCorsHeaders() {
        HttpResponse<String> res = preflight("/api/auth/login", ALLOWED, "POST", "authorization,content-type");

        assertThat(res.statusCode()).isBetween(200, 204);            // preflight 성공
        assertThat(header(res, ACAO)).contains(ALLOWED);             // 정확히 그 오리진
        assertThat(header(res, ACAM)).get().asString().contains("POST");
        // 허용 헤더에 Authorization, Content-Type (요구 3)
        assertThat(header(res, ACAH)).get().asString()
                .containsIgnoringCase("Authorization")
                .containsIgnoringCase("Content-Type");
    }

    @Test
    void allowedOriginPreflightOnAuthedPathIsNotBlockedBy401() {
        // 함정: /api/me 는 AuthInterceptor 가 401 로 막는 경로. preflight 엔 Authorization 이 없다.
        // CorsFilter 가 DispatcherServlet 앞에서 preflight 를 short-circuit → 인터셉터 미도달 → 401 아님.
        HttpResponse<String> res = preflight("/api/me", ALLOWED, "GET", null);

        assertThat(res.statusCode()).isNotEqualTo(401);
        assertThat(res.statusCode()).isBetween(200, 204);
        assertThat(header(res, ACAO)).contains(ALLOWED);
    }

    // ── 핵심 방어선: 미허용 오리진엔 ACAO 가 안 붙는다(브라우저가 차단하게) ──

    @Test
    void disallowedOriginPreflightHasNoAllowOriginHeader() {
        HttpResponse<String> res = preflight("/api/auth/login", DISALLOWED, "POST", "authorization");

        assertThat(header(res, ACAO)).isEmpty();      // ACAO 부재 = 핵심 방어선
        assertThat(res.statusCode()).isNotEqualTo(500); // 서버가 터지지 않는다(403 은 허용)
    }

    // ── 요구 5: /internal/** 엔 CORS 를 열지 않는다 ──

    @Test
    void internalPathHasNoCorsHeadersEvenForAllowedOrigin() {
        HttpResponse<String> res = preflight("/internal/health", ALLOWED, "GET", null);

        assertThat(header(res, ACAO)).isEmpty();       // 서번트 경로는 브라우저에 열리지 않는다
        assertThat(header(res, ACAM)).isEmpty();
    }

    // ── 요구 4: allowCredentials 꺼짐 ──

    @Test
    void allowCredentialsIsOff() {
        HttpResponse<String> res = preflight("/api/auth/login", ALLOWED, "POST", null);

        // Access-Control-Allow-Credentials 헤더 부재(또는 false) — 켜지 않았다.
        Optional<String> acac = header(res, ACAC);
        assertThat(acac.isEmpty() || acac.get().equalsIgnoreCase("false")).isTrue();
    }

    // ── 무회귀: 실제 요청(Origin 있음)은 정상 처리 + ACAO 부착, Origin 없으면 그대로 동작 ──

    @Test
    void actualRequestWithAllowedOriginGetsAcaoAndStillWorks() {
        // 로그인은 Origin 없이도 되던 기존 동작(무회귀). Origin 을 붙여 실제 GET 이 CORS 로 열리는지도 본다.
        String token = login("corsuser");
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create(url("/api/modes")))
                    .header("Origin", ALLOWED)
                    .header("Authorization", "Bearer " + token)
                    .GET().build();
            HttpResponse<String> res = http.send(req, HttpResponse.BodyHandlers.ofString());
            assertThat(res.statusCode()).isEqualTo(200);          // 실제 요청 정상
            assertThat(header(res, ACAO)).contains(ALLOWED);       // 실제 응답에도 ACAO
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void actualRequestWithoutOriginIsUntouched() {
        // 동일 오리진/서버-투-서버(Origin 헤더 없음) 는 CORS 처리를 타지 않고 현행 그대로.
        String token = login("noorigin");
        ResponseEntity<String> res = rest.exchange(
                url("/api/modes"), org.springframework.http.HttpMethod.GET,
                new org.springframework.http.HttpEntity<>(bearerHeaders(token)), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ── helpers ──

    @SuppressWarnings("unchecked")
    private String login(String nickname) {
        ResponseEntity<Map> res = rest.postForEntity(url("/api/auth/login"), Map.of("nickname", nickname), Map.class);
        return (String) res.getBody().get("token");
    }

    private org.springframework.http.HttpHeaders bearerHeaders(String token) {
        org.springframework.http.HttpHeaders h = new org.springframework.http.HttpHeaders();
        h.set("Authorization", "Bearer " + token);
        return h;
    }
}
