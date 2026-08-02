package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #405 W2a — 성장 계수 무배포 운영 admin API(설계 §2.8.3).
 *
 * <p>#383(엔진 계수)과의 결정적 차이는 <b>검증 주체</b>다: 저기는 러너에 위임했지만 성장 계수는
 * 서버가 소비자라 위임할 대상이 없다. 그래서 여기 테스트는 "서버가 남의 판정에 따르는가"가 아니라
 * <b>"서버의 판정이 실제로 게이트인가"</b>를 본다 — 거절된 값이 원장에 안 남고, 이유가 항목별로 오고,
 * 실패도 감사에 남는가.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminGrowthConfigTest extends ApiTestBase {

    private static final String ADMIN_NICK = "growth_cfg_admin";
    private static final String ADMIN_PW = "growth-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    /**
     * 오버레이는 전역 상태이고 클래스 안에서 DB 가 공유된다 — 앞 테스트가 남긴 리비전이 있으면
     * "지금 무엇이 바뀌나"의 답이 실행 순서에 달린다(실제로 {@code validate} 의 diff 가 앞 테스트의
     * 오버레이 해제까지 세어 깨졌다). 매 메서드를 <b>기본값</b>에서 시작시킨다. 리셋도 정식 경로
     * (빈 오버레이 PUT = 롤백)로 한다 — 테스트만 아는 뒷문을 만들지 않는다.
     */
    @org.junit.jupiter.api.BeforeEach
    void resetOverlayToDefaults() {
        put(adminToken(), Map.of("overrides", Map.of(), "reason", "테스트 리셋"), null);
    }

    // ── 접근 게이트 ──────────────────────────────────────────────────────

    @Test
    void nonAdminCannotReadOrWriteGrowthConfig() {
        String user = login("growth_cfg_plain");
        assertThat(authGet("/api/admin/growth-config", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(put(user, Map.of("overrides", Map.of("xp.maxLevel", 30), "reason", "x"), null)
                .getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
    }

    @Test
    void unauthenticatedIsRejected() {
        assertThat(rest.getForEntity(baseUrl("/api/admin/growth-config"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ── 검증 게이트 ──────────────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void anUnknownPathIsRejectedWithItsOwnReasonAndLeavesNoRevision() {
        String admin = adminToken();
        int before = revisionCount();
        int auditBefore = auditCount("growth_config_set", "failed");

        ResponseEntity<Map> res = put(admin,
                Map.of("overrides", Map.of("bands.GOLD.growCiel", 80), "reason", "오타 테스트"), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(String.valueOf(res.getBody().get("message"))).contains("bands.GOLD.growCiel");
        List<String> issues = (List<String>) ((Map<String, Object>) res.getBody().get("detail")).get("issues");
        assertThat(issues).as("항목별 이유가 없으면 운영자가 무엇을 고쳐야 하는지 모른다").hasSize(1);
        assertThat(revisionCount()).as("거절된 값이 원장에 남으면 그게 곧 현재 계수가 된다").isEqualTo(before);
        assertThat(auditCount("growth_config_set", "failed"))
                .as("거절된 시도도 이력이다 — 없으면 '왜 안 바뀌었나'를 아무도 모른다")
                .isEqualTo(auditBefore + 1);
    }

    /** <b>무효 노브는 타입 오류를 같이 돌려준다</b>(#383 m-C 선례) — 여러 건이면 한 번에 전부. */
    @Test
    @SuppressWarnings("unchecked")
    void everyBadKnobGetsItsOwnIssueInOneRoundTrip() {
        String admin = adminToken();
        ResponseEntity<Map> res = put(admin, Map.of("overrides", Map.of(
                "xp.maxLevel", "forty",              // 타입
                "attrHardCap", 500,                  // 범위
                "candidate.count", 2.5,              // 정수 아님
                "nope.path", 1                       // 없는 경로
        ), "reason", "복합 오류"), null);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        List<String> issues = (List<String>) ((Map<String, Object>) res.getBody().get("detail")).get("issues");
        assertThat(issues).as("첫 오류에서 끊으면 10개 고치는 데 10번 왕복한다").hasSize(4);
        assertThat(String.join(" / ", issues))
                .contains("xp.maxLevel").contains("attrHardCap")
                .contains("candidate.count").contains("nope.path");
    }

    @Test
    void reasonIsMandatory() {
        String admin = adminToken();
        int before = revisionCount();
        assertThat(put(admin, Map.of("overrides", Map.of("xp.maxLevel", 30)), null).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(revisionCount()).isEqualTo(before);
    }

    // ── 드라이런 ─────────────────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void validateShowsTheDiffWithoutCreatingARevision() {
        String admin = adminToken();
        int before = revisionCount();

        ResponseEntity<Map> res = rest.exchange(baseUrl("/api/admin/growth-config/validate"),
                HttpMethod.POST,
                new HttpEntity<>(Map.of("overrides", Map.of("bands.GOLD.growCeil", 80)), bearer(admin)),
                Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> changed = (List<Map<String, Object>>) res.getBody().get("changed");
        assertThat(changed).hasSize(1);
        assertThat(changed.get(0).get("path")).isEqualTo("bands.GOLD.growCeil");
        assertThat(((Number) changed.get(0).get("after")).intValue()).isEqualTo(80);
        assertThat(revisionCount()).as("드라이런이 원장을 만들면 그건 드라이런이 아니다").isEqualTo(before);
        assertThat(auditCount("growth_config_validate", "ok")).isGreaterThan(0);
    }

    // ── 적용 · 멱등 ──────────────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void putAppliesAndTheGetReflectsIt() {
        String admin = adminToken();
        ResponseEntity<Map> res = put(admin,
                Map.of("overrides", Map.of("bands.GOLD.growCeil", 80, "decay.gainMax", 3.0),
                        "reason", "밸런스 1차"), "growth-put-1");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        Map<String, Object> view = authGet("/api/admin/growth-config", admin, Map.class).getBody();
        assertThat(((Map<String, Object>) view.get("overrides")))
                .containsEntry("bands.GOLD.growCeil", 80);
        assertThat(view.get("revisionId")).isNotNull();
        assertThat(view.get("reason")).isEqualTo("밸런스 1차");
        // 유효값에도 반영돼 있어야 한다 — 오버레이만 보여 주고 계산은 옛 값을 쓰면 화면이 거짓말을 한다.
        Map<String, Object> effective = (Map<String, Object>) view.get("effective");
        Map<String, Object> bands = (Map<String, Object>) effective.get("bands");
        Map<String, Object> byGrade = (Map<String, Object>) bands.get("byGrade");
        assertThat(((Map<String, Object>) byGrade.get("GOLD")).get("growCeil")).isEqualTo(80);
    }

    @Test
    void sameKeySameContentIsAbsorbed_sameKeyDifferentContentIs409() {
        String admin = adminToken();
        Map<String, Object> body = Map.of("overrides", Map.of("xp.maxLevel", 35), "reason", "만렙 조정");

        assertThat(put(admin, body, "growth-idem-1").getStatusCode()).isEqualTo(HttpStatus.OK);
        int after = revisionCount();
        assertThat(put(admin, body, "growth-idem-1").getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(revisionCount()).as("같은 의도의 재전송은 행을 만들지 않는다").isEqualTo(after);

        ResponseEntity<Map> conflict = put(admin,
                Map.of("overrides", Map.of("xp.maxLevel", 36), "reason", "만렙 조정"), "growth-idem-1");
        assertThat(conflict.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(revisionCount()).isEqualTo(after);
    }

    /** 같은 값을 <b>다른 사유</b>로 다시 넣는 것은 다른 운영 행위다 — 같은 키를 재사용하면 409. */
    @Test
    void reasonIsPartOfTheIdempotencyIdentity() {
        String admin = adminToken();
        Map<String, Object> overrides = Map.of("xp.lvBase", 120);
        assertThat(put(admin, Map.of("overrides", overrides, "reason", "사유 A"), "growth-idem-2")
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(put(admin, Map.of("overrides", overrides, "reason", "사유 B"), "growth-idem-2")
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    /** PUT 은 <b>전체 교체</b>다 — 이전 리비전의 경로는 남지 않는다(부분 병합이 아니다). */
    @Test
    @SuppressWarnings("unchecked")
    void putReplacesTheWholeOverlayRatherThanMerging() {
        String admin = adminToken();
        put(admin, Map.of("overrides", Map.of("xp.maxLevel", 30, "attrHardCap", 95),
                "reason", "둘 다"), "growth-replace-1");
        put(admin, Map.of("overrides", Map.of("xp.maxLevel", 31), "reason", "하나만"), "growth-replace-2");

        Map<String, Object> view = authGet("/api/admin/growth-config", admin, Map.class).getBody();
        Map<String, Object> overrides = (Map<String, Object>) view.get("overrides");
        assertThat(overrides).containsOnlyKeys("xp.maxLevel");
        Map<String, Object> effective = (Map<String, Object>) view.get("effective");
        assertThat(effective.get("attrHardCap")).as("전체 교체라 이전 경로는 기본값으로 돌아간다").isEqualTo(99);
    }

    // ── 이력 · 노브 목록 ─────────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void historyKeepsWhoWhenWhyAndWhat() {
        String admin = adminToken();
        put(admin, Map.of("overrides", Map.of("xp.maxLevel", 33), "reason", "이력 확인"), "growth-hist-1");
        ResponseEntity<List> res = authGet("/api/admin/growth-config/history?limit=5", admin, List.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> latest = (Map<String, Object>) res.getBody().get(0);
        assertThat(latest.get("reason")).isEqualTo("이력 확인");
        assertThat(String.valueOf(latest.get("overridesJson"))).contains("xp.maxLevel");
        assertThat(latest.get("actor")).isEqualTo(ADMIN_NICK);
    }

    @Test
    @SuppressWarnings("unchecked")
    void knobsListIsServedSoOperatorsDoNotGuessPaths() {
        String admin = adminToken();
        Map<String, Object> res = authGet("/api/admin/growth-config/knobs", admin, Map.class).getBody();
        List<Map<String, Object>> knobs = (List<Map<String, Object>>) res.get("knobs");
        assertThat(((Number) res.get("count")).intValue()).isEqualTo(knobs.size());
        assertThat(knobs).anySatisfy(k -> {
            assertThat(k.get("path")).isEqualTo("bands.GOLD.growCeil");
            assertThat(k.get("type")).isEqualTo("INT");
            assertThat(k.get("scope")).isEqualTo("RUNTIME");
        });
        // ⚠️ 효력 시점이 응답에 없으면 운영자는 "저장됐다 = 적용됐다"로 읽는다. 발행 시점 노브는
        //    이미 구워진 카드 스탯을 바꾸지 않으므로 그 사실이 목록에 보여야 한다.
        assertThat(knobs).anySatisfy(k -> {
            assertThat(k.get("path")).isEqualTo("bands.primaryBias");
            assertThat(k.get("scope")).isEqualTo("PUBLISH");
            assertThat(String.valueOf(k.get("appliesWhen"))).contains("발행");
        });
        assertThat(knobs).allSatisfy(k -> assertThat(k.get("scope")).isNotNull());
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private ResponseEntity<Map> put(String token, Map<String, Object> body, String idemKey) {
        HttpHeaders headers = bearer(token);
        if (idemKey != null) {
            headers.set("Idempotency-Key", idemKey);
        }
        return rest.exchange(baseUrl("/api/admin/growth-config"), HttpMethod.PUT,
                new HttpEntity<>(body, headers), Map.class);
    }

    private String adminToken() {
        Map<String, Object> body = new java.util.HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as("admin 로그인 실패: " + res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }

    private int revisionCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM growth_config_revisions").query(Integer.class).single();
    }

    private int auditCount(String action, String result) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit WHERE action = ? AND result = ?")
                .params(action, result).query(Integer.class).single();
    }
}
