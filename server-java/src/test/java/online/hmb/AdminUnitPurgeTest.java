package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import online.hmb.admin.AdminCatalogService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 유닛 회수 (#210, #309 W2 에서 흡수).
 *
 * <p><b>문제</b>: 오타·잘못된 스탯으로 만든 유닛을 되돌릴 수단이 {@code deactivate} 뿐이었다.
 * 비활성 유닛은 획득 경로에서만 빠질 뿐 <b>카탈로그에 영원히 남고 P-번호를 점유</b>한다.
 *
 * <p><b>이 테스트가 지키는 균형</b>: 회수는 <b>되돌릴 수 없는</b> 동작이라 넓으면 위험하고 좁으면
 * 쓸모없다. 그래서 두 방향을 같이 태운다 — ①아무도 손대지 않은 유닛은 <b>지워진다</b>
 * ②한 명이라도 보유하면 <b>절대 안 지워지고</b> 왜 막혔는지 알려준다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUnitPurgeTest extends ApiTestBase {

    private static final String ADMIN_NICK = "purgeadmin";
    private static final String ADMIN_PW = "purge-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    /** 방금 만들어 아무도 손대지 않은 유닛은 회수된다 — 그게 #210 이 말한 경우다. */
    @Test
    @SuppressWarnings("rawtypes")
    void aFreshlyCreatedUnitWithNoReferencesCanBeReclaimed() {
        String admin = adminToken();
        String id = createUnit(admin, "오타난이름");

        ResponseEntity<Map> res = authPost("/api/admin/units/" + id + "/purge", admin,
                Map.of("reason", "오타로 잘못 만듦"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(unitExists(id)).as("카탈로그에서 사라진다").isFalse();
        assertThat(authGet("/api/admin/units/" + id, admin, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    /**
     * <b>보유자가 있으면 절대 안 지운다.</b> 지우면 그 유저의 카드가 사라진다 —
     * 되돌릴 수 없는 데이터 손실이라 409 가 맞고, <b>무엇이 막았는지</b>를 응답에 담는다.
     */
    @Test
    @SuppressWarnings("rawtypes")
    void aUnitSomebodyOwnsIsNeverPurgedAndTheBlockerIsReported() {
        String admin = adminToken();
        String id = createUnit(admin, "누군가보유중");
        String userId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .params(ADMIN_NICK).query(String.class).single();
        jdbcClient.sql("INSERT INTO user_players(user_id, player_id, count, acquired_at) VALUES (?, ?, 1, ?)")
                .params(userId, id, java.time.Instant.now().toString())
                .update();

        ResponseEntity<Map> res = authPost("/api/admin/units/" + id + "/purge", admin,
                Map.of("reason", "지워보자"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(String.valueOf(res.getBody())).contains("user_players");
        assertThat(unitExists(id)).as("거부는 부수효과 0").isTrue();
        // 문구가 대안을 알려 준다 — 막다른 토스트를 만들지 않는다(#217 규율).
        assertThat(String.valueOf(res.getBody().get("message"))).contains("비활성화");
    }

    /** 사유 없는 회수는 없다(카탈로그 운영 공통 규약 — reason 은 원장의 존재 이유다). */
    @Test
    @SuppressWarnings("rawtypes")
    void aReasonIsRequired() {
        String admin = adminToken();
        String id = createUnit(admin, "사유없이");

        assertThat(authPost("/api/admin/units/" + id + "/purge", admin, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(unitExists(id)).isTrue();
    }

    /** 회수는 admin 게이트 뒤 — 일반 유저는 403 이고 유닛이 남는다. */
    @Test
    @SuppressWarnings("rawtypes")
    void purgeIsBehindTheAdminGate() {
        String admin = adminToken();
        String id = createUnit(admin, "게이트확인");
        String user = login("purge_plain");

        assertThat(authPost("/api/admin/units/" + id + "/purge", user,
                Map.of("reason", "x"), Map.class).getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(unitExists(id)).isTrue();
    }

    /**
     * 지운 뒤에도 <b>그 유닛의 이력은 남고, 회수도 같은 원장에 있다</b>(hero 지시 2026-07-30).
     *
     * <p>처음엔 회수만 V18 범용 원장에 남겼다 — 이 표의 {@code action} CHECK 를 넓히는 테이블
     * 재작성이 부담스러웠기 때문이다. 그러면 <b>한 유닛의 이력이 두 곳으로 갈리고</b> 회수는
     * 하필 유닛 감사 조회에 안 나오는 유일한 액션이 된다. V32 가 CHECK 를 넓혀 합쳤다.
     *
     * <p>행이 남을 수 있는 근거는 {@code player_id} 에 FK 가 <b>없다</b>는 것이고, V14 가
     * "삭제·미존재 유닛의 이력도 보존해야 한다"며 일부러 그렇게 만들었다.
     */
    @Test
    @SuppressWarnings("rawtypes")
    void historySurvivesThePurgeInTheSameLedger() {
        String admin = adminToken();
        String id = createUnit(admin, "이력보존");
        authPost("/api/admin/units/" + id + "/purge", admin, Map.of("reason", "회수"), Map.class);

        List<String> actions = jdbcClient.sql(
                        "SELECT action FROM admin_catalog_audit WHERE player_id = ? ORDER BY created_at")
                .params(id).query(String.class).list();

        assertThat(actions).as("생성과 회수가 **한 원장**에 나란히 있다")
                .contains(AdminCatalogService.ACTION_CREATE, AdminCatalogService.ACTION_PURGE);
        // 회수 행은 무엇을 지웠는지 스냅샷으로 갖고 있다 — "이름이 뭐였나"에 답할 수 있어야 한다.
        String before = jdbcClient.sql(
                        "SELECT before_json FROM admin_catalog_audit WHERE player_id = ? AND action = ?")
                .params(id, AdminCatalogService.ACTION_PURGE).query(String.class).single();
        assertThat(before).as("지운 유닛의 스냅샷").contains("이력보존");

        // ⚠️ 범용 원장(V18)에는 **더 이상 남기지 않는다** — 두 곳에 쓰면 이력이 다시 갈린다.
        int opsRows = jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit WHERE action = ?")
                .params(AdminCatalogService.ACTION_PURGE).query(Integer.class).single();
        assertThat(opsRows).as("회수는 카탈로그 원장 한 곳에만").isZero();
    }

    /** 유닛 감사 조회에 회수가 <b>보인다</b> — 이력을 합친 이유가 이것이다. */
    @Test
    @SuppressWarnings("rawtypes")
    void purgeShowsUpInTheUnitAuditQuery() {
        String admin = adminToken();
        String id = createUnit(admin, "감사조회");
        authPost("/api/admin/units/" + id + "/purge", admin, Map.of("reason", "회수"), Map.class);

        ResponseEntity<Map> res = authGet(
                "/api/admin/units/audit?playerId=" + id, admin, Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(String.valueOf(res.getBody()))
                .as("운영자가 '이 번호에 무슨 일이 있었나'를 한 곳에서 본다")
                .contains(AdminCatalogService.ACTION_PURGE);
    }

    /**
     * <b>회수한 번호는 다시 발급되지 않는다</b>(hero 지시 2026-07-30).
     *
     * <p>왜 중요한가: 채번이 {@code MAX(players)+1} 이라 가장 큰 번호를 회수하면 다음 생성이 그
     * 번호를 가져갔다. 라이브 데이터는 안전하지만(참조 0 이어야 회수된다) {@code admin_catalog_audit}
     * 은 그 번호의 <b>옛 이력을 갖고 있다</b>(V14 가 일부러 FK 를 안 걸었다) — 그래서 새 유닛 상세에
     * 남의 이력이 섞여 보였다. 실측으로 재현됐던 자리다(P022 → 회수 → 재생성이 다시 P022).
     */
    @Test
    @SuppressWarnings("rawtypes")
    void aPurgedNumberIsNeverIssuedAgain() {
        String admin = adminToken();
        String first = createUnit(admin, "회수될유닛");

        authPost("/api/admin/units/" + first + "/purge", admin, Map.of("reason", "잘못 만듦"), Map.class);
        String second = createUnit(admin, "다음유닛");

        assertThat(second).as("비운 번호를 재사용하지 않는다").isNotEqualTo(first);
        assertThat(numberOf(second)).isGreaterThan(numberOf(first));
        // 그 번호의 옛 이력이 새 유닛에 붙지 않는다 — 재사용을 막는 이유가 이것이다.
        int strayHistory = jdbcClient.sql(
                        "SELECT COUNT(*) FROM admin_catalog_audit WHERE player_id = ?")
                .params(second).query(Integer.class).single();
        assertThat(strayHistory).as("새 유닛의 이력은 자기 생성 1건뿐").isEqualTo(1);
    }

    /** 낮은 번호를 회수해도 수위가 <b>내려가지</b> 않는다(그러면 다음 생성이 충돌한다). */
    @Test
    @SuppressWarnings("rawtypes")
    void purgingALowNumberDoesNotLowerTheHighWaterMark() {
        String admin = adminToken();
        String high = createUnit(admin, "높은번호");
        String alsoHigh = createUnit(admin, "더높은번호");
        // 높은 것을 먼저 회수해 수위를 올려 둔 뒤, 낮은 것을 회수한다.
        authPost("/api/admin/units/" + alsoHigh + "/purge", admin, Map.of("reason", "a"), Map.class);
        authPost("/api/admin/units/" + high + "/purge", admin, Map.of("reason", "b"), Map.class);

        String next = createUnit(admin, "그다음");

        assertThat(numberOf(next)).isGreaterThan(numberOf(alsoHigh));
    }

    private int numberOf(String playerId) {
        return Integer.parseInt(playerId.substring(1));
    }

    /**
     * ⚠️ <b>참조 표 목록이 스키마와 일치하는가.</b> 새 표가 {@code players} 를 참조하는데 이 목록에
     * 없으면, 회수가 그 참조를 <b>못 보고</b> 지워서 데이터가 끊긴다. 목록을 손으로 관리하는 이상
     * 이 대조가 유일한 안전장치다.
     *
     * <p>스키마를 직접 읽는다(코드가 아니라) — 구현과 검증이 같은 목록을 공유하면 둘 다 틀려도
     * 통과한다(루트 CLAUDE.md 의 league-difficulty-sweep 교훈과 같은 축).
     */
    @Test
    void referencingTablesListMatchesTheSchema() {
        List<String> ddl = jdbcClient.sql(
                        "SELECT sql FROM sqlite_master WHERE type = 'table' AND sql IS NOT NULL")
                .query(String.class).list();

        Map<String, Set<String>> fromSchema = new LinkedHashMap<>();
        Pattern table = Pattern.compile("CREATE TABLE\\s+\"?(\\w+)\"?", Pattern.CASE_INSENSITIVE);
        for (String sql : ddl) {
            Matcher m = table.matcher(sql);
            if (!m.find()) {
                continue;
            }
            String name = m.group(1);
            // 마이그레이션이 남긴 임시/구 테이블은 제외(_new 접미 등 — 살아 있는 스키마가 아니다).
            if (name.endsWith("_new") || name.startsWith("sqlite_")) {
                continue;
            }
            for (String line : sql.split("\n")) {
                if (line.contains("REFERENCES players(id)")) {
                    Matcher col = Pattern.compile("^\\s*\"?(\\w+)\"?").matcher(line);
                    if (col.find()) {
                        fromSchema.computeIfAbsent(name, k -> new java.util.LinkedHashSet<>()).add(col.group(1));
                    }
                }
            }
        }

        assertThat(fromSchema.keySet())
                .as("players 를 참조하는 표가 회수 가드 목록과 일치해야 한다 — "
                        + "새 표를 추가했다면 AdminCatalogService.REFERENCING_TABLES 에도 넣어라")
                .isEqualTo(AdminCatalogService.REFERENCING_TABLES.keySet());

        // ⚠️ **표 이름만 대조하면 부족하다**(독립검증 MIN-3): `trade_slots` 처럼 참조 컬럼이
        //    **둘**인 표에 컬럼이 하나 더 생기면 이름 집합은 그대로라 못 잡는다. 가드의 WHERE 절이
        //    그 컬럼을 실제로 보는지까지 확인한다.
        for (Map.Entry<String, Set<String>> e : fromSchema.entrySet()) {
            String where = AdminCatalogService.REFERENCING_TABLES.get(e.getKey());
            for (String column : e.getValue()) {
                assertThat(where)
                        .as(e.getKey() + "." + column + " 을 회수 가드가 검사하지 않는다 — "
                                + "참조 컬럼이 늘면 WHERE 절도 같이 늘려라")
                        .contains(column);
            }
        }
    }

    @SuppressWarnings("rawtypes")
    private String createUnit(String admin, String name) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", name);
        body.put("position", "FW");
        body.put("grade", "GOLD");
        // 능력치 9종은 생성 필수다(부분 생성이 없다 — 빠진 값을 서버가 지어내지 않는다).
        Map<String, Object> attrs = new LinkedHashMap<>();
        for (String key : List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning")) {
            attrs.put(key, 50);
        }
        body.put("attributes", attrs);
        body.put("reason", "테스트 생성");
        ResponseEntity<Map> res = authPost("/api/admin/units", admin, body, Map.class);
        assertThat(res.getStatusCode().is2xxSuccessful()).as("생성 실패: " + res.getBody()).isTrue();
        @SuppressWarnings("unchecked")
        Map<String, Object> unit = (Map<String, Object>) res.getBody().get("unit");
        return (String) unit.get("id");
    }

    private boolean unitExists(String id) {
        return jdbcClient.sql("SELECT COUNT(*) FROM players WHERE id = ?")
                .params(id).query(Integer.class).single() > 0;
    }

    @SuppressWarnings("rawtypes")
    private String adminToken() {
        ResponseEntity<Map> res = rest.postForEntity(baseUrl("/api/auth/login"),
                Map.of("nickname", ADMIN_NICK, "provider", "local", "password", ADMIN_PW), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("token");
    }
}
