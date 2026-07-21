package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * CORS(이슈 #128) — env/설정 주입이 실제로 동작하는지 + 여러 오리진 콤마 구분.
 * {@code hmb.cors.allowed-origins} 를 두 오리진으로 주입(→ HMB_CORS_ALLOWEDORIGINS 배선과 동일 경로)하고
 * 각각 허용, 제3의 오리진은 미허용됨을 헤더 값으로 단정한다.
 */
@SpringBootTest(
        webEnvironment = WebEnvironment.RANDOM_PORT,
        properties = "hmb.cors.allowed-origins=https://alpha.pages.dev, https://beta.example.test")
class CorsEnvConfigTest {

    private static final String ORIGIN_A = "https://alpha.pages.dev";
    private static final String ORIGIN_B = "https://beta.example.test";
    private static final String ORIGIN_C = "https://gamma.not-allowed.dev";
    private static final String ACAO = "Access-Control-Allow-Origin";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @LocalServerPort
    private int port;

    private final HttpClient http = HttpClient.newHttpClient();

    private HttpResponse<String> preflight(String origin) {
        try {
            HttpRequest req = HttpRequest.newBuilder(URI.create("http://localhost:" + port + "/api/auth/login"))
                    .method("OPTIONS", HttpRequest.BodyPublishers.noBody())
                    .header("Origin", origin)
                    .header("Access-Control-Request-Method", "POST")
                    .build();
            return http.send(req, HttpResponse.BodyHandlers.ofString());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Optional<String> acao(HttpResponse<String> res) {
        return res.headers().firstValue(ACAO);
    }

    @Test
    void firstConfiguredOriginIsAllowed() {
        assertThat(acao(preflight(ORIGIN_A))).contains(ORIGIN_A);
    }

    @Test
    void secondConfiguredOriginIsAllowed() {
        // 콤마 뒤 공백이 있어도 trim 되어 매칭돼야 한다.
        assertThat(acao(preflight(ORIGIN_B))).contains(ORIGIN_B);
    }

    @Test
    void unconfiguredOriginIsRejected() {
        HttpResponse<String> res = preflight(ORIGIN_C);
        assertThat(acao(res)).isEmpty();
        assertThat(res.statusCode()).isNotEqualTo(500);
    }
}
