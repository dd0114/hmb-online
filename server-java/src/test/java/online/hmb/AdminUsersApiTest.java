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
 * admin 유저 목록·검색·페이징 + 유저 상태 조회(PRD-v4 §C 기능 요구).
 *
 * <p>가장 중요한 단정은 <b>비번 미노출</b>이다. 필드 이름을 확인하는 데 그치지 않고 응답
 * <b>원문 문자열</b>에서 실제 비번 값을 검색한다 — 필드명을 바꿔 담아도, 중첩 객체에 섞여도 잡힌다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUsersApiTest extends ApiTestBase {

    private static final String ADMIN_NICK = "list_admin";
    private static final String ADMIN_PW = "list-admin-pw-9876";
    /** 조회 응답 어디에도 나타나면 안 되는 값. */
    private static final String VICTIM_PW = "V1ctim-Secret-Passw0rd";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    /** 소독기 검증용 — 실제 빈을 감싼 스파이라 다른 테스트의 정상 동작은 그대로다. */
    @org.springframework.boot.test.mock.mockito.SpyBean
    private online.hmb.admin.AdminUserQueryService userQueryService;

    @Test
    void listsSearchesAndPages() {
        String admin = adminToken();
        login("alpha_one");
        login("alpha_two");
        login("beta_one");

        // 전체 목록 — admin 계정 포함
        Map<String, Object> all = asMap(get("/api/admin/users", admin));
        assertThat(((Number) all.get("total")).longValue()).isGreaterThanOrEqualTo(4);

        // 검색(닉네임 부분 일치)
        Map<String, Object> alpha = asMap(get("/api/admin/users?q=alpha", admin));
        assertThat(((Number) alpha.get("total")).longValue()).isEqualTo(2);
        assertThat(nicknames(alpha)).containsExactlyInAnyOrder("alpha_one", "alpha_two");

        // 페이징 — limit/offset 이 실제로 창을 자른다(합집합 = 전체, 교집합 = 공집합)
        Map<String, Object> page0 = asMap(get("/api/admin/users?q=alpha&limit=1&offset=0", admin));
        Map<String, Object> page1 = asMap(get("/api/admin/users?q=alpha&limit=1&offset=1", admin));
        assertThat(nicknames(page0)).hasSize(1);
        assertThat(nicknames(page1)).hasSize(1);
        assertThat(nicknames(page0)).doesNotContainAnyElementsOf(nicknames(page1));
        assertThat(((Number) page0.get("total")).longValue()).as("total 은 페이지가 아니라 전체 건수").isEqualTo(2);

        // LIKE 와일드카드는 리터럴 — '%' 검색이 전량을 긁지 않는다
        assertThat(((Number) asMap(get("/api/admin/users?q=%25", admin)).get("total")).longValue()).isZero();
    }

    @Test
    void userDetailShowsWalletHoldingsAndRecords() {
        String admin = adminToken();
        registerLocal("detail_target", VICTIM_PW);
        String targetId = userIdOf("detail_target");

        Map<String, Object> detail = asMap(get("/api/admin/users/" + targetId, admin));

        @SuppressWarnings("unchecked")
        Map<String, Object> user = (Map<String, Object>) detail.get("user");
        assertThat(user.get("id")).isEqualTo(targetId);
        assertThat(user.get("nickname")).isEqualTo("detail_target");
        assertThat(user.get("isAdmin")).isEqualTo(false);

        // 스타터 팩 온보딩 결과가 그대로 보인다(지갑 포인트 + 보유 선수).
        // 지갑은 user.points 하나로만 노출한다 — 중복 필드를 만들지 않는다.
        assertThat(((Number) user.get("points")).longValue()).isGreaterThan(0);

        @SuppressWarnings("unchecked")
        Map<String, Object> players = (Map<String, Object>) detail.get("players");
        assertThat(((Number) players.get("distinct")).longValue()).isGreaterThan(0);

        @SuppressWarnings("unchecked")
        Map<String, Object> records = (Map<String, Object>) detail.get("records");
        assertThat(records).containsKeys("wins", "draws", "losses");
        assertThat(detail).containsKeys("presets", "deck");
    }

    @Test
    void unknownUserDetailIs404() {
        assertThat(get("/api/admin/users/NO_SUCH_ID", adminToken()).status()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    /** <b>AC-A2 연장</b>: 어떤 admin 응답에도 비번 평문이 등장하지 않는다(원문 검색). */
    @Test
    void passwordNeverAppearsInAnyAdminResponse() {
        String admin = adminToken();
        registerLocal("secret_holder", VICTIM_PW);
        String targetId = userIdOf("secret_holder");

        // DB 에는 실제로 그 비번이 저장돼 있다(테스트가 공허하지 않음을 먼저 증명).
        assertThat(jdbcClient.sql("SELECT password FROM users WHERE id = ?").param(targetId)
                .query(String.class).single()).isEqualTo(VICTIM_PW);

        List<String> bodies = List.of(
                get("/api/admin/users", admin).body(),
                get("/api/admin/users?q=secret", admin).body(),
                get("/api/admin/users/" + targetId, admin).body(),
                authGet("/api/me", admin, String.class).getBody());

        for (String body : bodies) {
            assertThat(body).doesNotContain(VICTIM_PW);
            assertThat(body).doesNotContain(ADMIN_PW);
            assertThat(body.toLowerCase()).doesNotContain("password");
        }
    }

    /** {@code /api/me} additive — isAdmin 이 실제 플래그를 반영한다(기존 필드 무변경). */
    @Test
    void meExposesIsAdminAdditively() {
        String admin = adminToken();
        String regular = login("me_regular");

        Map<String, Object> adminMe = asMap(new HttpResult(HttpStatus.OK,
                authGet("/api/me", admin, String.class).getBody()));
        Map<String, Object> regularMe = asMap(new HttpResult(HttpStatus.OK,
                authGet("/api/me", regular, String.class).getBody()));

        @SuppressWarnings("unchecked")
        Map<String, Object> adminUser = (Map<String, Object>) adminMe.get("user");
        @SuppressWarnings("unchecked")
        Map<String, Object> regularUser = (Map<String, Object>) regularMe.get("user");

        assertThat(adminUser.get("isAdmin")).isEqualTo(true);
        assertThat(regularUser.get("isAdmin")).isEqualTo(false);
        // 기존 필드 무변경(무회귀)
        assertThat(adminUser).containsKeys("id", "nickname");
        assertThat(adminMe).containsKeys("user", "wallet", "records");
    }

    /**
     * <b>DB 예외가 admin 응답으로 새지 않는다</b>(하드닝 2). V6 로 스코프를 맞춘 뒤로는 정상 경로에서
     * DB 예외가 나지 않으므로, 소독기가 살아 있는지 확인하려면 <b>예외를 주입</b>해야 한다 —
     * 안 그러면 이 방어는 영원히 실행되지 않은 채 "테스트 green" 이 된다.
     *
     * <p>주입 메시지는 검증자가 실제로 응답에서 목격한 것과 같은 모양이다(INSERT 문 + 인덱스 구성).
     */
    @Test
    void databaseExceptionsAreSanitizedBeforeReachingTheClient() {
        String admin = adminToken();
        String leaky = "INSERT INTO admin_audit(id, actor_user_id, target_user_id, action) VALUES (?,?,?,?) "
                + "[SQLITE_CONSTRAINT_UNIQUE] UNIQUE constraint failed: admin_audit.action, admin_audit.idem_key";

        // 1) UNIQUE 계열 → 409 + 소독
        org.mockito.Mockito.doThrow(new org.springframework.dao.DataIntegrityViolationException(leaky))
                .when(userQueryService).list(org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        HttpResult conflict = get("/api/admin/users", admin);
        assertThat(conflict.status()).isEqualTo(HttpStatus.CONFLICT);
        assertLeakFree(conflict.body());

        // 2) 그 외 DB 예외 → 상태코드는 500 **그대로 유지**(선재 이슈 상태코드 불변 정책) + 소독
        org.mockito.Mockito.doThrow(new org.springframework.dao.TransientDataAccessResourceException(
                        "SELECT * FROM users [SQLITE_BUSY] database is locked"))
                .when(userQueryService).list(org.mockito.ArgumentMatchers.any(),
                        org.mockito.ArgumentMatchers.any(), org.mockito.ArgumentMatchers.any());
        HttpResult busy = get("/api/admin/users", admin);
        assertThat(busy.status()).isEqualTo(HttpStatus.INTERNAL_SERVER_ERROR);
        assertLeakFree(busy.body());
    }

    /**
     * <b>minor-C 인접 점검</b>: admin 경로의 잘못된 쿼리 파라미터 타입({@code limit=abc})이
     * 프레임워크 내부(변환기·{@code NumberFormatException}·JDK 타입명)를 응답으로 흘리지 않는지 본다.
     * 상태코드는 이 웨이브의 관심이 아니다(선재 정책 불변) — <b>노출 여부만</b> 단정한다.
     * {@code AdminErrorHandler.handleTypeMismatch} 하드닝을 제거하면 이 단정이 FAIL 한다(뮤테이션 확인).
     */
    @Test
    void malformedQueryParamDoesNotLeakInternals() {
        String admin = adminToken();
        for (String bad : List.of("/api/admin/users?limit=abc", "/api/admin/users?offset=NaN")) {
            HttpResult res = get(bad, admin);
            assertThat(res.body()).as("타입 변환 실패가 내부를 노출했다: " + res.body())
                    .doesNotContain("NumberFormatException").doesNotContain("For input string")
                    .doesNotContain("java.lang.Integer").doesNotContain("java.lang.String")
                    .doesNotContain("MethodArgumentTypeMismatch").doesNotContain("ConversionFailed")
                    .doesNotContain("com.fasterxml").doesNotContain("org.springframework");
        }
    }

    private void assertLeakFree(String body) {
        assertThat(body).as("응답에 내부 SQL/스키마가 노출됐다: " + body)
                .doesNotContain("INSERT").doesNotContain("SELECT")
                .doesNotContain("UNIQUE constraint").doesNotContain("SQLITE_")
                .doesNotContain("admin_audit").doesNotContain("users")
                .doesNotContain("org.springframework").doesNotContain("org.sqlite");
    }

    // ───────────────────────── helpers ─────────────────────────

    @SuppressWarnings("unchecked")
    private List<String> nicknames(Map<String, Object> page) {
        return ((List<Map<String, Object>>) page.get("items")).stream()
                .map(m -> (String) m.get("nickname")).toList();
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

    private void registerLocal(String nickname, String password) {
        Map<String, Object> body = new HashMap<>();
        body.put("nickname", nickname);
        body.put("password", password);
        assertThat(postJson("/api/auth/register", body).status()).isEqualTo(HttpStatus.OK);
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

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }
}
