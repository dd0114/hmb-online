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
 * 단건 조회가 <b>목록 창에 갇히지 않는다</b>(#323, 독립검증 MAJOR-3).
 *
 * <p><b>왜 클래스를 따로 두나</b>: 이 계약은 서버의 발송 이력 창을 <b>1건</b>으로 좁혀야 성립하는데
 * (`hmb.mail.campaign-list-max`), 그 설정을 {@code AdminMailSendTest} 전역에 걸면 같은 클래스의
 * 다른 테스트들(수령률 통계·감사 이력)이 <b>1행만 보고 단언</b>하게 된다 — 지금은 우연히 통과하지만
 * 순서가 바뀌면 깨진다(3차 독립검증 m-4). 조건이 특별한 계약은 자기 방을 갖는다.
 *
 * <p><b>왜 창을 좁히나</b>: 결함은 "캠페인 101건 뒤 가장 오래된 건이 404" 였다. 101건을 만드는 것은
 * 느리고, 그 비용 때문에 초판은 <b>어차피 참인 명제</b>를 검증했다(2차 blocker). 창을 config 로 빼면
 * 4건으로 같은 조건이 만들어진다 — {@code MailFanoutCapTest} 가 상한을 낮춰 팬아웃 거부를 재현하는
 * 것과 같은 패턴이다.
 *
 * <p>변이체 킬 검증: {@code detail()} 을 {@code list(...)} 스캔으로 되돌리면 이 테스트가 죽는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MailCampaignDetailTest extends ApiTestBase {

    private static final String ADMIN_NICK = "mldet_admin";
    private static final String ADMIN_PW = "mldet-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
        registry.add("hmb.mail.campaign-list-max", () -> 1);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void detailFindsCampaignsBeyondTheListWindow() {
        String admin = adminToken();
        String userId = user("mldet_user");

        String oldest = (String) asMap(send(admin, targeted(userId, 1L), "idem-det-0")).get("campaignId");
        for (int i = 1; i <= 3; i++) {
            send(admin, targeted(userId, 1L + i), "idem-det-" + i);
        }

        // 서버 목록 창이 1건이므로 오래된 건은 **어떤 limit 을 줘도** 목록에 없다.
        HttpResult listed = get("/api/admin/mails?limit=100", admin);
        assertThat(listed.body()).as("목록 창(1건) 밖이어야 조건이 성립한다").doesNotContain(oldest);

        HttpResult detail = get("/api/admin/mails/" + oldest, admin);
        assertThat(detail.status()).as(detail.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(detail).get("id")).isEqualTo(oldest);
    }

    /** 회수는 id 로 되는데 확인만 404 인 상태가 이 결함의 실제 모습이었다 — 둘 다 되는지 본다. */
    @Test
    void revokeAlsoWorksForCampaignsBeyondTheWindow() {
        String admin = adminToken();
        String userId = user("mldet_rv");

        String oldest = (String) asMap(send(admin, targeted(userId, 1L), "idem-detrv-0")).get("campaignId");
        send(admin, targeted(userId, 2L), "idem-detrv-1");

        HttpResult revoked = postJsonAuth("/api/admin/mails/" + oldest + "/revoke", admin,
                Map.of("reason", "창 밖 회수"), null);
        assertThat(revoked.status()).as(revoked.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(get("/api/admin/mails/" + oldest, admin)).get("revokedAt")).isNotNull();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private Map<String, Object> targeted(String userId, long points) {
        Map<String, Object> body = new HashMap<>();
        body.put("audience", "USERS");
        body.put("userIds", List.of(userId));
        body.put("title", "창 밖 조회");
        body.put("body", "본문");
        body.put("attachments", Map.of("points", points, "gems", 0, "players", List.of()));
        body.put("reason", "계약 테스트");
        return body;
    }

    private HttpResult send(String token, Map<String, Object> body, String idemKey) {
        return postJsonAuth("/api/admin/mails", token, body, idemKey);
    }

    private String user(String nickname) {
        login(nickname);
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
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

    private HttpResult get(String path, String token) {
        try {
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(baseUrl(path)))
                            .header("Authorization", "Bearer " + token)
                            .GET().build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private HttpResult postJsonAuth(String path, String token, Map<String, Object> body, String idemKey) {
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token);
            if (idemKey != null) {
                builder.header("Idempotency-Key", idemKey);
            }
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    builder.POST(java.net.http.HttpRequest.BodyPublishers.ofString(
                            MAPPER.writeValueAsString(body))).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
