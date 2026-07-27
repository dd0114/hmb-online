package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * economy 무배포 운영 (#209 B안) — <b>재배포·재기동 없이</b> 스타터 최상위 후보를 갈아끼운다.
 *
 * <p>이 클래스의 존재 이유는 한 문장이다: <b>"바꿨다"가 아니라 "바꾼 게 실제 가입에 반영된다"</b>를
 * 증명하는 것. 그래서 핵심 테스트는 설정 응답을 확인하는 데서 멈추지 않고, 교체 <b>후에 가입한 유저</b>가
 * 새 후보를 받는지까지 본다(서버 프로세스는 그대로 살아 있다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminEconomyOpsTest extends ApiTestBase {

    private static final String ADMIN_NICK = "hmbadmin";
    private static final String ADMIN_PW = "econ-admin-pw-1234";

    /** 픽스처 economy 의 기본 pool(P018~P021)과 겹치지 않는 새 후보 — 교체가 실제로 먹혔는지 구분된다. */
    private static final List<String> NEW_POOL = List.of("P016", "P017");

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private online.hmb.catalog.EconomyService economyService;

    @AfterEach
    void removeOverride() throws Exception {
        // 테스트가 남긴 override 파일이 다음 클래스로 새지 않게(스냅샷은 컨텍스트와 함께 사라진다).
        Files.deleteIfExists(Path.of(economyService.overridePath()));
    }

    // ── 게이트 ───────────────────────────────────────────────────────────

    @Test
    void everyEconomyOpsEndpointIsBehindTheAdminGate() {
        String user = login("econ_plain");   // 비-admin
        long auditBefore = auditCount();     // 절대값이 아니라 델타 — 같은 DB 를 다른 테스트도 쓴다

        assertThat(authGet("/api/admin/economy", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authGet("/api/admin/economy/history", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authPost("/api/admin/economy/reload", user, Map.of("reason", "x"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authPut("/api/admin/economy/starter-top", user,
                Map.of("pool", NEW_POOL, "count", 1, "reason", "x"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authDelete("/api/admin/economy/override?reason=x", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        // 비-admin 의 시도는 원장에 **한 줄도 늘지 않는다**(게이트가 핸들러 앞에서 끊는다 = 부수효과 0).
        assertThat(auditCount()).isEqualTo(auditBefore);
    }

    // ── 실제 반영 ─────────────────────────────────────────────────────────

    @Test
    void replacingStarterTopChangesWhatNewSignupsGet_withoutRestart() {
        String admin = adminToken();

        // 교체 전에 가입한 유저는 발행물(BAKED) pool 에서 받는다.
        login("econ_before");
        String beforeGrant = grantedTopOf("econ_before");
        assertThat(beforeGrant).startsWith("P0");
        assertThat(List.of("P018", "P019", "P020", "P021")).contains(beforeGrant);

        ResponseEntity<Map> put = authPut("/api/admin/economy/starter-top", admin,
                Map.of("pool", NEW_POOL, "count", 1, "reason", "레전드 개편 반영"), Map.class);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(put.getBody().get("source")).isEqualTo("OVERRIDE");
        assertThat((Boolean) put.getBody().get("overrideApplied")).isTrue();
        assertThat(((Map<?, ?>) put.getBody().get("starterTop")).get("pool")).isEqualTo(NEW_POOL);

        // ★ 핵심: **재기동 없이** 그 다음 가입부터 새 pool 이 적용된다.
        login("econ_after");
        assertThat(NEW_POOL).contains(grantedTopOf("econ_after"));

        // 기존 유저의 지급 이력은 그대로다(박제 — 목록이 바뀌어도 과거가 뒤집히지 않는다).
        assertThat(grantedTopOf("econ_before")).isEqualTo(beforeGrant);

        // 원장에 성공 이력 + before/after 스냅샷이 남는다.
        List<Map<String, Object>> history = historyOf(admin);
        assertThat(history).isNotEmpty();
        Map<String, Object> latest = history.get(0);
        assertThat(latest.get("action")).isEqualTo("economy_starter_top");
        assertThat(latest.get("result")).isEqualTo("ok");
        assertThat(latest.get("reason")).isEqualTo("레전드 개편 반영");
        assertThat((String) latest.get("detailJson")).contains("before").contains("after").contains("P016");
        assertThat(latest.get("actor")).isEqualTo("hmbadmin");
    }

    @Test
    void overrideSurvivesReloadAndClearRollsBackToTheBakedFile() {
        String admin = adminToken();
        authPut("/api/admin/economy/starter-top", admin,
                Map.of("pool", NEW_POOL, "count", 1, "reason", "교체"), Map.class);

        // 리로드는 override 를 계속 우선한다(디스크에 남아 있으므로 재기동에도 살아남는다는 뜻).
        ResponseEntity<Map> reloaded = authPost("/api/admin/economy/reload", admin,
                Map.of("reason", "재확인"), Map.class);
        assertThat(reloaded.getBody().get("source")).isEqualTo("OVERRIDE");

        // 롤백 = override 삭제 한 번. 발행물 값으로 즉시 되돌아간다.
        ResponseEntity<Map> cleared = authDelete("/api/admin/economy/override?reason=롤백", admin, Map.class);
        assertThat(cleared.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(cleared.getBody().get("source")).isEqualTo("BAKED");
        assertThat((Boolean) cleared.getBody().get("overrideApplied")).isFalse();
        assertThat(((Map<?, ?>) cleared.getBody().get("starterTop")).get("pool"))
                .isEqualTo(List.of("P018", "P019", "P020", "P021"));

        login("econ_rolledback");
        assertThat(List.of("P018", "P019", "P020", "P021")).contains(grantedTopOf("econ_rolledback"));

        // 두 번째 롤백은 400 — 지울 게 없다(조용한 성공보다 명시적 거절이 낫다).
        assertThat(authDelete("/api/admin/economy/override?reason=또", admin, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ── 검증 · 실패 처리 ──────────────────────────────────────────────────

    @Test
    void rejectsInvalidPoolsAndLeavesTheRunningConfigUntouched() {
        String admin = adminToken();
        Object poolBefore = ((Map<?, ?>) authGet("/api/admin/economy", admin, Map.class)
                .getBody().get("starterTop")).get("pool");

        record Case(String label, Map<String, Object> body) {
        }
        List<Case> cases = List.of(
                new Case("카탈로그에 없는 id", Map.of("pool", List.of("P999"), "count", 1, "reason", "r")),
                new Case("중복 id", Map.of("pool", List.of("P016", "P016"), "count", 1, "reason", "r")),
                new Case("기본팩과 겹침", Map.of("pool", List.of("P001"), "count", 1, "reason", "r")),
                new Case("count > pool", Map.of("pool", List.of("P016"), "count", 5, "reason", "r")),
                new Case("count < 1", Map.of("pool", List.of("P016"), "count", 0, "reason", "r")),
                new Case("빈 pool", Map.of("pool", List.of(), "count", 1, "reason", "r")),
                new Case("사유 없음", Map.of("pool", List.of("P016"), "count", 1)));

        for (Case c : cases) {
            ResponseEntity<Map> res = authPut("/api/admin/economy/starter-top", admin, c.body(), Map.class);
            assertThat(res.getStatusCode()).as(c.label()).isEqualTo(HttpStatus.BAD_REQUEST);
        }

        // 어느 실패도 살아 있는 설정을 건드리지 않았고, override 파일도 생기지 않았다.
        Map<?, ?> after = authGet("/api/admin/economy", admin, Map.class).getBody();
        assertThat(((Map<?, ?>) after.get("starterTop")).get("pool")).isEqualTo(poolBefore);
        assertThat(after.get("source")).isEqualTo("BAKED");
        assertThat(Files.exists(Path.of(economyService.overridePath()))).isFalse();
    }

    /**
     * <b>거절된 시도도 이력이다</b> (독립검증 BL-1). 이게 없으면 "왜 안 바뀌었나"를 나중에 아무도
     * 모른다 — 운영자는 눌렀다고 기억하는데 원장에는 흔적이 없다.
     */
    @Test
    void rejectedAttemptsAreRecordedInTheLedgerToo() {
        String admin = adminToken();
        long before = auditCount();

        // 검증에서 걸리는 3종 — 카탈로그 부재 · 사유 누락 · 롤백할 override 없음.
        assertThat(authPut("/api/admin/economy/starter-top", admin,
                Map.of("pool", List.of("P999"), "count", 1, "reason", "없는 선수"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(authPut("/api/admin/economy/starter-top", admin,
                Map.of("pool", List.of("P016"), "count", 1), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(authDelete("/api/admin/economy/override?reason=없는걸지움", admin, Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(auditCount()).as("거절 3건이 원장에 남아야 한다").isEqualTo(before + 3);

        List<Map<String, Object>> history = historyOf(admin);
        assertThat(history.stream().filter(e -> "failed".equals(e.get("result")))).hasSizeGreaterThanOrEqualTo(3);
        Map<String, Object> latest = history.get(0);
        assertThat(latest.get("result")).isEqualTo("failed");
        assertThat((String) latest.get("detailJson")).contains("error");
    }

    /**
     * <b>파싱 성공 ≠ 쓸 수 있는 내용</b> (독립검증 BL-2). 볼륨의 파일을 손으로 고쳐 카탈로그에 없는
     * id 를 넣고 리로드하면, 예전 구현은 200 을 돌려주고 스냅샷을 갈아끼웠다 — 그 뒤 <b>모든 신규
     * 가입이 FK 로 500</b> 이 됐고(전면 장애), 파일은 파싱되므로 재기동해도 그대로였다.
     */
    @Test
    void reloadRefusesAFileThatWouldBreakSignup() throws Exception {
        String admin = adminToken();
        Map<?, ?> healthy = authGet("/api/admin/economy", admin, Map.class).getBody();

        String poison = Files.readString(Path.of("src/test/resources/fixtures/economy.v1.json"))
                .replace("\"P018\"", "\"P999_NOT_IN_CATALOG\"");
        Files.writeString(Path.of(economyService.overridePath()), poison);

        ResponseEntity<Map> reload = authPost("/api/admin/economy/reload", admin,
                Map.of("reason", "손으로 고친 파일 반영"), Map.class);
        assertThat(reload.getStatusCode()).as("쓸 수 없는 내용은 400").isEqualTo(HttpStatus.BAD_REQUEST);

        // **기본팩**도 같은 기준으로 본다 — 여기 없는 id 는 starterTop 보다 폭발 반경이 크다
        // (모든 가입이 지나가는 경로라 한 장만 틀려도 신규 유저가 한 명도 못 들어온다).
        String poisonBasics = Files.readString(Path.of("src/test/resources/fixtures/economy.v1.json"))
                .replace("\"P014\"", "\"P995_NOT_IN_CATALOG\"");
        Files.writeString(Path.of(economyService.overridePath()), poisonBasics);
        assertThat(authPost("/api/admin/economy/reload", admin,
                Map.of("reason", "기본팩 오염 반영"), Map.class).getStatusCode())
                .as("기본팩 오염도 400").isEqualTo(HttpStatus.BAD_REQUEST);

        // 살아 있는 설정은 그대로고(파일이 디스크에 남은 것과 **적용된 것**은 다른 사실이다),
        Map<?, ?> after = authGet("/api/admin/economy", admin, Map.class).getBody();
        assertThat(after.get("starterTop")).isEqualTo(healthy.get("starterTop"));
        assertThat(after.get("source")).isEqualTo("BAKED");
        assertThat(after.get("overrideApplied")).as("거절된 파일은 '적용'이 아니다").isEqualTo(false);
        assertThat(after.get("overrideFilePresent")).as("파일 자체는 남아 있다").isEqualTo(true);
        // 무엇보다 **가입이 계속 된다**(이게 이 테스트의 본론).
        String token = login("econ_poison");
        assertThat(authGet("/api/me", token, Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void aCorruptOverrideNeverTakesTheServiceDown() throws Exception {
        String admin = adminToken();
        // 운영이 볼륨의 파일을 직접 망가뜨린 상황(바인드마운트·수동 편집).
        Files.writeString(Path.of(economyService.overridePath()), "{ this is not json");

        ResponseEntity<Map> reload = authPost("/api/admin/economy/reload", admin,
                Map.of("reason", "손상 파일 반영 시도"), Map.class);
        // 리로드 자체는 거절되지만(400) 서버는 살아 있고 **직전 설정이 그대로** 동작한다.
        assertThat(reload.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        login("econ_corrupt");
        assertThat(List.of("P018", "P019", "P020", "P021")).contains(grantedTopOf("econ_corrupt"));

        // 실패도 원장에 남는다 — "왜 반영이 안 됐나"를 나중에 추적할 수 있어야 한다.
        Map<String, Object> latest = historyOf(admin).get(0);
        assertThat(latest.get("action")).isEqualTo("economy_reload");
        assertThat(latest.get("result")).isEqualTo("failed");
        assertThat((String) latest.get("detailJson")).contains("error");
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private String adminToken() {
        ResponseEntity<Map> res = rest.postForEntity(baseUrl("/api/auth/login"),
                Map.of("nickname", ADMIN_NICK, "provider", "local", "password", ADMIN_PW), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("token");
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> historyOf(String adminToken) {
        return authGet("/api/admin/economy/history", adminToken, List.class).getBody();
    }

    private String grantedTopOf(String nickname) {
        return jdbcClient.sql("""
                        SELECT g.player_id FROM starter_grants g JOIN users u ON u.id = g.user_id
                        WHERE u.nickname = ?
                        """)
                .param(nickname).query(String.class).single();
    }

    private long auditCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit").query(Long.class).single();
    }
}
