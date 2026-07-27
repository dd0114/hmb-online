package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#207 blocker B1 — 오염 복구.</b> 감사 원장에 같은 {@code (unit_create, idem_key)} 가 <b>이미</b>
 * 2행 있는 DB 에서도 그 키가 <b>영구 500 이 되면 안 된다</b>.
 *
 * <p>왜 별도 클래스인가: 이 시나리오를 만들려면 {@code V15} 백스톱 인덱스를 <b>내려야</b> 한다
 * (인덱스가 있으면 중복을 심을 수 없다 — 그게 인덱스의 목적이다). DDL 을 되돌릴 수 없으므로
 * 같은 클래스의 다른 테스트에 영향을 주지 않게 <b>전용 임시 DB</b>({@code TestDbSupport.registerTempDb}
 * 는 클래스마다 새 파일)를 쓴다.
 *
 * <p>그리고 이 분리 자체가 계약이다: 인덱스와 조회 견고성은 <b>서로를 대체하지 않는다</b>.
 * 인덱스는 <b>새 중복</b>을 막고, 조회는 <b>이미 생긴 중복</b>에서 살아남는다. 검증자가 만난 DB 는
 * 후자였고(경합이 이미 지나간 뒤였다), 인덱스만 넣었다면 그 DB 는 여전히 500 이었다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUnitContaminatedIdemTest extends ApiTestBase {

    private static final String ADMIN_NICK = "unit_dirty_admin";
    private static final String ADMIN_PW = "unit-dirty-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    private final HttpClient client = HttpClient.newHttpClient();

    private record Res(int status, String body) {
    }

    @Test
    void duplicateAuditRowsForOneKeyStillReplayInsteadOfCrashing() throws Exception {
        String admin = adminToken();
        String idemKey = "K-DIRTY";
        String unitName = "오염-선행";
        Map<String, Object> body = createBody(unitName);

        // ── 1) 정상 생성(승자) ──
        Res first = post(admin, idemKey, body);
        assertThat(first.status()).as(first.body()).isEqualTo(200);
        String winnerUnitId = (String) ((Map<?, ?>) parse(first.body()).get("unit")).get("id");

        // ── 2) 경합이 이미 지나간 DB 를 재현: 백스톱을 내리고 같은 키의 두 번째 감사행을 심는다 ──
        // 이건 "가상의 상태"가 아니라 검증자가 실서버에서 실제로 만든 상태다(같은 키 2행).
        jdbcClient.sql("DROP INDEX uq_catalog_audit_create_idem").update();
        String loserPlayerId = "P999";
        jdbcClient.sql("""
                        INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action, before_json,
                                                        after_json, changed_fields, reason, idem_key, created_at)
                        SELECT ?, actor_user_id, ?, 'unit_create', NULL, ?, 'id,name', '경합으로 중복된 행', ?, ?
                          FROM admin_catalog_audit WHERE idem_key = ? LIMIT 1
                        """)
                // after_json 의 name 을 **일부러 다르게** 둔다: 뒤 행이 재생되면 내용 불일치로 409 가 나므로,
                // 200 이라는 사실 자체가 "최초 성공분이 재생됐다"를 증명한다(정렬이 임의면 이 단정이 깨진다).
                .params("01DIRTYLOSERAUDITROW000000", loserPlayerId,
                        "{\"id\":\"" + loserPlayerId + "\",\"name\":\"오염-후행\",\"position\":\"FW\","
                                + "\"grade\":\"LEGEND\",\"personality\":\"CALM\",\"active\":true}",
                        idemKey, Instant.now().plusSeconds(60).toString(), idemKey)
                .update();
        assertThat(countAuditWithKey(idemKey)).as("오염 상태를 만들지 못했다 — 검사가 공허하다").isEqualTo(2L);

        // ── 3) 같은 키로 다시 요청 → 500 이 아니라 **정의된 응답**(200 재생) ──
        Res replay = post(admin, idemKey, body);
        assertThat(replay.status()).as("오염된 DB 에서 영구 500 이 났다: %s", replay).isNotEqualTo(500);
        assertThat(replay.status()).as(replay.body()).isEqualTo(200);
        assertThat(parse(replay.body()).get("applied")).isEqualTo(false);
        assertThat(((Map<?, ?>) parse(replay.body()).get("unit")).get("id"))
                .as("최초 성공분이 아니라 다른 행이 재생됐다").isEqualTo(winnerUnitId);

        // ── 4) 부수효과 0 — 오염 상태에서도 유닛이 더 생기지 않는다 ──
        assertThat(countPlayersNamed(unitName)).isEqualTo(1L);
        assertThat(countAuditWithKey(idemKey)).isEqualTo(2L);

        // ── 5) 같은 키 + 다른 내용은 오염 상태에서도 409(계약 무회귀) ──
        Res conflict = post(admin, idemKey, createBody("오염-정정시도"));
        assertThat(conflict.status()).as(conflict.body()).isEqualTo(409);
        assertThat(countPlayersNamed("오염-정정시도")).isZero();

        // ── 6) 감사 조회도 살아 있다(운영자가 무슨 일이 있었는지 볼 수 있어야 복구가 가능하다) ──
        Res audit = get(admin, "/api/admin/units/audit?action=unit_create&limit=200");
        assertThat(audit.status()).as(audit.body()).isEqualTo(200);
        assertThat(audit.body()).contains(loserPlayerId);
    }

    // ───────────────────────── 헬퍼 ─────────────────────────

    private Res post(String token, String idemKey, Map<String, Object> body) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl("/api/admin/units")))
                .header("Authorization", "Bearer " + token)
                .header("Content-Type", "application/json")
                .header("Idempotency-Key", idemKey)
                .POST(HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                .build();
        HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
        return new Res(res.statusCode(), res.body());
    }

    private Res get(String token, String path) throws Exception {
        HttpRequest req = HttpRequest.newBuilder()
                .uri(URI.create(baseUrl(path)))
                .header("Authorization", "Bearer " + token)
                .GET().build();
        HttpResponse<String> res = client.send(req, HttpResponse.BodyHandlers.ofString());
        return new Res(res.statusCode(), res.body());
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> parse(String json) {
        try {
            return MAPPER.readValue(json, Map.class);
        } catch (Exception e) {
            throw new IllegalStateException("bad json: " + json, e);
        }
    }

    private static Map<String, Object> createBody(String name) {
        Map<String, Object> attrs = new HashMap<>();
        for (String k : List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning")) {
            attrs.put(k, 80);
        }
        Map<String, Object> body = new HashMap<>();
        body.put("name", name);
        body.put("position", "FW");
        body.put("grade", "LEGEND");
        body.put("attributes", attrs);
        body.put("personality", "CALM");
        body.put("reason", "오염 복구 계약 검증");
        return body;
    }

    private String adminToken() {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status().value()).as(res.body()).isEqualTo(200);
        return (String) asMap(res).get("token");
    }

    private long countPlayersNamed(String name) {
        return jdbcClient.sql("SELECT COUNT(*) FROM players WHERE name = ?").param(name)
                .query(Long.class).single();
    }

    private long countAuditWithKey(String idemKey) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit WHERE idem_key = ?")
                .param(idemKey).query(Long.class).single();
    }
}
