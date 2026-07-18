package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AC-A1(서버측): 로그인 provider 파라미터(guest|mock:google|mock:apple) → 세션 발급 +
 * users.auth_provider 기록. mock:* 는 {provider, nickname} 그대로 세션 발급(웹 동의화면·닉네임
 * 입력은 목업). provider 생략은 guest(V1 하위호환).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class OAuthMockTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    private ResponseEntity<Map> loginWith(String nickname, String provider) {
        Map<String, Object> body = new HashMap<>();
        body.put("nickname", nickname);
        if (provider != null) {
            body.put("provider", provider);
        }
        return rest.postForEntity(baseUrl("/api/auth/login"), body, Map.class);
    }

    private String authProviderOf(String nickname) {
        return jdbcClient.sql("SELECT auth_provider FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }

    @Test
    void mockGoogleRecordsProviderAndIssuesSession() {
        ResponseEntity<Map> res = loginWith("g_user", "mock:google");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((Boolean) res.getBody().get("isNew")).isTrue();
        assertThat((String) res.getBody().get("token")).isNotBlank();
        assertThat(authProviderOf("g_user")).isEqualTo("mock:google");
    }

    @Test
    void mockAppleRecordsProvider() {
        loginWith("a_user", "mock:apple");
        assertThat(authProviderOf("a_user")).isEqualTo("mock:apple");
    }

    @Test
    void guestIsDefaultWhenProviderOmitted() {
        loginWith("guest_user", null);
        assertThat(authProviderOf("guest_user")).isEqualTo("guest");
    }

    @Test
    void explicitGuestRecordsGuest() {
        loginWith("guest_explicit", "guest");
        assertThat(authProviderOf("guest_explicit")).isEqualTo("guest");
    }

    @Test
    void unsupportedProviderRejected() {
        ResponseEntity<Map> res = loginWith("bad_user", "mock:facebook");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
        // 유저 생성 안 됨
        Long count = jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname = ?")
                .param("bad_user").query(Long.class).single();
        assertThat(count).isZero();
    }

    @Test
    void reLoginDoesNotOverwriteOriginalProvider() {
        loginWith("keep_user", "mock:google");
        assertThat(authProviderOf("keep_user")).isEqualTo("mock:google");
        // 다른 provider 로 재로그인해도 최초 가입 값 유지(기존 유저 분기 — 재기록 안 함)
        ResponseEntity<Map> second = loginWith("keep_user", "mock:apple");
        assertThat((Boolean) second.getBody().get("isNew")).isFalse();
        assertThat(authProviderOf("keep_user")).isEqualTo("mock:google");
    }
}
