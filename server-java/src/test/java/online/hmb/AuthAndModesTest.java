package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-S1(로그인 → 토큰 → Bearer 인증) + /api/modes 스모크(D10) E2E.
 * AuthInterceptor가 /api/** 전체를 보호하고, 미지/만료 토큰은 401을 반환하는지도 검증.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AuthAndModesTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @LocalServerPort
    private int port;

    private final TestRestTemplate rest = new TestRestTemplate();

    private String baseUrl(String path) {
        return "http://localhost:" + port + path;
    }

    @Test
    void loginCreatesUserAndSessionThenBearerAuthPasses() {
        ResponseEntity<Map> loginResponse = rest.postForEntity(
                baseUrl("/api/auth/login"), Map.of("nickname", "tester1"), Map.class);

        assertThat(loginResponse.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> body = loginResponse.getBody();
        assertThat(body).isNotNull();
        assertThat((Boolean) body.get("isNew")).isTrue();
        String token = (String) body.get("token");
        assertThat(token).isNotBlank();

        // 재로그인은 기존 유저 재사용(isNew=false)
        ResponseEntity<Map> secondLogin = rest.postForEntity(
                baseUrl("/api/auth/login"), Map.of("nickname", "tester1"), Map.class);
        assertThat((Boolean) secondLogin.getBody().get("isNew")).isFalse();

        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + token);
        ResponseEntity<List> modesResponse = rest.exchange(
                baseUrl("/api/modes"), HttpMethod.GET, new HttpEntity<>(headers), List.class);

        assertThat(modesResponse.getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void unknownTokenIsRejectedWith401() {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer not-a-real-token");
        ResponseEntity<Map> response = rest.exchange(
                baseUrl("/api/modes"), HttpMethod.GET, new HttpEntity<>(headers), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(response.getBody()).containsEntry("code", "UNAUTHORIZED");
    }

    @Test
    void missingAuthorizationHeaderIsRejectedWith401() {
        ResponseEntity<Map> response = rest.getForEntity(baseUrl("/api/modes"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** W0 독립검증에서 이월된 케이스: 세션이 존재해도 expires_at이 지났으면 401. */
    @Test
    void expiredSessionTokenIsRejectedWith401() {
        // 유저 생성(정상 로그인) 후 만료된 세션을 직접 삽입
        ResponseEntity<Map> loginResponse = rest.postForEntity(
                baseUrl("/api/auth/login"), Map.of("nickname", "expired1"), Map.class);
        String userId = (String) ((Map<?, ?>) loginResponse.getBody().get("user")).get("id");

        String expiredToken = "expired-token-for-test";
        jdbcClient.sql("INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)")
                .params(expiredToken, userId, Instant.now().minus(1, ChronoUnit.HOURS).toString())
                .update();

        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + expiredToken);
        ResponseEntity<Map> response = rest.exchange(
                baseUrl("/api/me"), HttpMethod.GET, new HttpEntity<>(headers), Map.class);

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(response.getBody()).containsEntry("code", "UNAUTHORIZED");
    }

    @Test
    void modesReturnsSingleAvailableAndMultiComingSoon() {
        String token = (String) rest.postForEntity(
                        baseUrl("/api/auth/login"), Map.of("nickname", "tester2"), Map.class)
                .getBody().get("token");

        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + token);
        ResponseEntity<List> response = rest.exchange(
                baseUrl("/api/modes"), HttpMethod.GET, new HttpEntity<>(headers), List.class);

        List<?> modes = response.getBody();
        assertThat(modes).hasSize(2);

        Map<?, ?> single = (Map<?, ?>) modes.stream()
                .filter(m -> "single".equals(((Map<?, ?>) m).get("id")))
                .findFirst().orElseThrow();
        assertThat((Boolean) single.get("available")).isTrue();

        Map<?, ?> multi = (Map<?, ?>) modes.stream()
                .filter(m -> "multi".equals(((Map<?, ?>) m).get("id")))
                .findFirst().orElseThrow();
        assertThat((Boolean) multi.get("available")).isFalse();
        assertThat(multi.get("label")).isEqualTo("준비중");
    }

    @Test
    void invalidNicknameIsRejectedWith400() {
        ResponseEntity<Map> response = rest.postForEntity(
                baseUrl("/api/auth/login"), Map.of("nickname", "a"), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody()).containsEntry("code", "VALIDATION_ERROR");
    }
}
