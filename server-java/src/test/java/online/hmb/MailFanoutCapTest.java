package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 팬아웃 상한(#323) — <b>넘으면 거부한다. 조용히 자르지 않는다.</b>
 *
 * <p>절반만 받은 이벤트는 회수도 재발송도 어렵다(누가 받았는지로 대상을 다시 만들어야 하고, 그
 * 계산이 틀리면 이중 지급이다). 그래서 "일부라도 보내는 것"보다 "아무것도 안 보내는 것"이 낫다.
 *
 * <p>상한을 1 로 낮춰 재현한다 — 5000명을 만들어 확인할 수는 없고, <b>값이 config 라는 사실 자체가
 * 이 테스트로 증명된다</b>(하드코딩이면 이 클래스가 통과할 수 없다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MailFanoutCapTest extends ApiTestBase {

    private static final String ADMIN_NICK = "fanout_admin";
    private static final String ADMIN_PW = "fanout-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
        registry.add("hmb.mail.fanout-max", () -> 1);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void overTheCapIsRejectedWholeNotTruncated() {
        String admin = adminToken();
        login("fanout_a");
        login("fanout_b");   // admin 계정까지 최소 3명 — 상한 1 을 확실히 넘는다

        Map<String, Object> body = new HashMap<>();
        body.put("audience", "ALL");
        body.put("title", "전체 발송");
        body.put("body", "본문");
        body.put("attachments", Map.of("points", 100, "gems", 0, "players", List.of()));
        body.put("reason", "상한 계약 테스트");

        HttpResult res = send(admin, body);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(count("mail_campaigns")).as("캠페인 0").isZero();
        assertThat(count("user_mails")).as("수신 행 0 — 잘라서 일부만 보내지 않는다").isZero();
        // 거절도 이력이다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit WHERE action = 'mail_send' AND result = 'failed'")
                .query(Long.class).single()).isEqualTo(1);
    }

    private long count(String table) {
        return jdbcClient.sql("SELECT COUNT(*) FROM " + table).query(Long.class).single();
    }

    private HttpResult send(String token, Map<String, Object> body) {
        try {
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(baseUrl("/api/admin/mails")))
                            .header("Content-Type", "application/json")
                            .header("Authorization", "Bearer " + token)
                            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(
                                    MAPPER.writeValueAsString(body)))
                            .build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String adminToken() {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }
}
