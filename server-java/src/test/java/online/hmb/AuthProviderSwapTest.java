package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.when;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.Map;
import online.hmb.auth.AuthProvider;
import online.hmb.auth.AuthResult;
import online.hmb.auth.LoginRequest;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.mock.mockito.MockBean;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-A2: AuthController/SessionService 는 {@link AuthProvider} 인터페이스에만 의존한다 — 실 OAuth
 * 구현체로 교체해도 컨트롤러/세션 로직은 불변임을 증명한다. 임의의 AuthProvider 목을 주입해도
 * 로그인 응답(token 발급·user·isNew)이 동일하게 동작함을 검증한다.
 *
 * <p>P3 §A 이후 컨텍스트에는 AuthProvider 빈이 셋(DelegatingAuthProvider·MockOAuthProvider·
 * LocalAuthProvider) 있고, 아래 {@code @MockBean} 은 그중 <b>{@code @Primary} 인
 * DelegatingAuthProvider</b>(= 컨트롤러가 실제로 주입받는 빈)를 대체한다. 즉 이 테스트는 여전히
 * "컨트롤러가 보는 AuthProvider 를 통째로 갈아끼워도 동작 불변"을 증명한다 —
 * 앞으로 AuthProvider 구현체를 추가할 때 이 @Primary 규약을 깨면 안 된다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AuthProviderSwapTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    /** 실 OAuth 구현체를 흉내낸 임의 AuthProvider — 컨트롤러는 이 스왑을 눈치채지 못한다. */
    @MockBean
    private AuthProvider authProvider;

    @Resource
    private JdbcClient jdbcClient;

    @LocalServerPort
    private int port;

    private final TestRestTemplate rest = new TestRestTemplate();

    @Test
    void controllerIssuesSessionRegardlessOfProviderImpl() {
        // sessions.user_id 는 users FK — 실 유저 1명을 직접 삽입(로그인 경로는 목이라 유저를 만들지 않음).
        String userId = "01SWAPUSERID0000000000000A";
        jdbcClient.sql("INSERT INTO users(id, nickname, auth_provider, created_at) VALUES (?, ?, ?, ?)")
                .params(userId, "swapped", "oauth:real", Instant.now().toString())
                .update();

        // 임의(실 OAuth 흉내) AuthProvider 구현체가 반환하는 결과 — 컨트롤러는 provider 값을 해석하지 않는다.
        when(authProvider.authenticate(any(LoginRequest.class)))
                .thenReturn(new AuthResult(userId, "swapped", false));

        ResponseEntity<Map> res = rest.postForEntity(
                baseUrl("/api/auth/login"),
                Map.of("nickname", "swapped", "provider", "oauth:real"),
                Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((String) res.getBody().get("token")).isNotBlank();
        Map<?, ?> user = (Map<?, ?>) res.getBody().get("user");
        assertThat(user.get("id")).isEqualTo(userId);
        assertThat(user.get("nickname")).isEqualTo("swapped");
        assertThat((Boolean) res.getBody().get("isNew")).isFalse();

        // 세션이 실제로 발급됨(컨트롤러/SessionService 불변 동작)
        String token = (String) res.getBody().get("token");
        Long sessions = jdbcClient.sql("SELECT COUNT(*) FROM sessions WHERE token = ? AND user_id = ?")
                .params(token, userId).query(Long.class).single();
        assertThat(sessions).isEqualTo(1L);
    }

    private String baseUrl(String path) {
        return "http://localhost:" + port + path;
    }
}
