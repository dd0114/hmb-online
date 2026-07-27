package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#207 §1.2 왕복(round-trip)</b> — 어드민 API 로 개편한 카탈로그를 {@code GET /units/export} 로
 * 뽑아 <b>그 파일로 새 DB 를 부팅</b>하면 같은 상태가 재현된다.
 *
 * <p>왜 이게 계약인가: 어드민 API 는 <b>런타임 DB</b>만 바꾼다. 시드 파일이 그대로면 새 배포나
 * 테스터 DB 리셋 시 <b>개편 전 상태로 부팅</b>한다 — 개편이 그 DB 한 대에만 살고 조용히 사라진다.
 * export 가 "시드로 승격 가능한 형태"임을 <b>실제 부팅으로</b> 증명해야 그 사슬이 닫힌다.
 * 포맷을 눈으로 비교하는 것만으로는 부족하다 — 임포터가 {@code active} 를 왕복시키지 못하면
 * 파일은 옳은데 부팅 결과가 다르다.
 *
 * <p>검증용 두 번째 컨텍스트는 <b>랜덤 포트 + 새 임시 DB 파일</b>로 띄운다(배포·데모 스택 무접촉).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUnitExportRoundTripTest extends ApiTestBase {

    private static final String ADMIN_NICK = "export_admin";
    private static final String ADMIN_PW = "export-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void exportedCatalogBootsIntoAnIdenticalCatalog() throws Exception {
        String admin = adminToken();

        // ── 개편 3종: 신규 추가 · 비활성화 · 스탯/등급 수정 ──
        Map<String, Object> create = new HashMap<>();
        create.put("name", "석신");
        create.put("position", "GK");
        create.put("grade", "LEGEND");
        create.put("attributes", attrs());
        create.put("personality", "CALM");
        create.put("reason", "신규 8종 투입");
        assertThat(send("POST", "/api/admin/units", admin, create).status()).isEqualTo(HttpStatus.OK);

        assertThat(send("POST", "/api/admin/units/P016/deactivate", admin,
                Map.of("reason", "구 LEGEND 비활성")).status()).isEqualTo(HttpStatus.OK);

        assertThat(send("PATCH", "/api/admin/units/P013", admin,
                Map.of("name", "Tuned Forward", "attributes", Map.of("shooting", 77),
                        "personality", "FIERY", "reason", "스탯 보정")).status()).isEqualTo(HttpStatus.OK);

        // ── export → 시드 파일로 저장 ──
        HttpResult exported = send("GET", "/api/admin/units/export", admin, null);
        assertThat(exported.status()).as(exported.body()).isEqualTo(HttpStatus.OK);
        Path seed = Files.createTempFile("players.", ".vexp.json");
        Files.writeString(seed, exported.body(), StandardCharsets.UTF_8);

        Map<String, Object[]> expected = catalogSnapshot(jdbcClient);

        // ── 그 파일로 새 DB 부팅 ──
        Path db = Files.createTempFile("hmb-roundtrip-", ".db");
        Files.deleteIfExists(db);
        // ⚠️ 설정은 **커맨드라인 인자**로 준다. SpringApplicationBuilder.properties(...) 는
        // defaultProperties(최저 우선순위)라 application.yml 의 server.port: 8080 을 못 이긴다 —
        // 실제로 이 테스트가 **8080(데모 스택 포트)** 을 잡으려다 PortInUseException 으로 터졌다.
        // 인자는 최고 우선순위라 확실히 이긴다. port 0 = 임의 빈 포트(배포/데모 포트 무접촉).
        try (ConfigurableApplicationContext ctx = new SpringApplicationBuilder(Application.class)
                .run(
                        "--server.port=0",
                        "--hmb.db.path=" + db.toAbsolutePath(),
                        "--hmb.data.players-file=" + seed.toAbsolutePath(),
                        "--hmb.data.economy-file=src/test/resources/fixtures/economy.v1.json",
                        "--hmb.data.bots-file=src/test/resources/fixtures/bots.v1.json",
                        "--hmb.match.clock.enabled=false")) {

            Map<String, Object[]> reloaded = catalogSnapshot(ctx.getBean(JdbcClient.class));

            assertThat(reloaded.keySet())
                    .as("export 로 부팅한 카탈로그의 유닛 집합이 다르다").isEqualTo(expected.keySet());
            for (Map.Entry<String, Object[]> e : expected.entrySet()) {
                assertThat(reloaded.get(e.getKey()))
                        .as("유닛 " + e.getKey() + " 이 왕복에서 달라졌다")
                        .isEqualTo(e.getValue());
            }

            // 왕복의 핵심 3점을 이름으로 다시 못박는다(집합 비교가 우연히 통과하는 걸 막는다).
            JdbcClient fresh = ctx.getBean(JdbcClient.class);
            assertThat(str(fresh, "SELECT name FROM players WHERE position = 'GK' AND grade = 'LEGEND'"))
                    .as("신규 유닛이 시드 왕복에서 사라졌다").isEqualTo("석신");
            assertThat(num(fresh, "SELECT active FROM players WHERE id = 'P016'"))
                    .as("비활성 상태가 왕복에서 유실됐다 — 재부팅하면 다시 뽑히게 된다").isZero();
            assertThat(str(fresh, "SELECT name FROM players WHERE id = 'P013'")).isEqualTo("Tuned Forward");
            assertThat(str(fresh, "SELECT personality FROM players WHERE id = 'P013'")).isEqualTo("FIERY");

            // 시드로 들어온 행은 잠기지 않는다 — 다음 시드 버전이 계속 권위를 갖는다.
            assertThat(num(fresh, "SELECT COUNT(*) FROM players WHERE admin_locked <> 0")).isZero();
        } finally {
            Files.deleteIfExists(seed);
            Files.deleteIfExists(db);
        }
    }

    /** 유닛별 비교 키 — 시드가 담아야 하는 값 전부(런타임 전용 admin_locked·data_version 제외). */
    private Map<String, Object[]> catalogSnapshot(JdbcClient client) {
        Map<String, Object[]> out = new java.util.LinkedHashMap<>();
        client.sql("""
                        SELECT id, name, position, grade, attributes_json, personality, active
                        FROM players ORDER BY id
                        """)
                .query((rs, n) -> Map.entry(rs.getString("id"), new Object[]{
                        rs.getString("name"), rs.getString("position"), rs.getString("grade"),
                        normalizeAttrs(rs.getString("attributes_json")), rs.getString("personality"),
                        rs.getInt("active")}))
                .list()
                .forEach(e -> out.put(e.getKey(), e.getValue()));
        return out;
    }

    /** 키 순서·공백에 흔들리지 않게 정렬된 문자열로 정규화(왕복은 값이 같으면 통과여야 한다). */
    private String normalizeAttrs(String json) {
        try {
            Map<String, Object> parsed = MAPPER.readValue(json, Map.class);
            return new java.util.TreeMap<>(parsed).toString();
        } catch (Exception e) {
            throw new IllegalStateException("attributes_json 파싱 실패: " + json, e);
        }
    }

    private String str(JdbcClient client, String sql) {
        return client.sql(sql).query(String.class).single();
    }

    private int num(JdbcClient client, String sql) {
        return client.sql(sql).query(Integer.class).single();
    }

    private static Map<String, Object> attrs() {
        Map<String, Object> a = new HashMap<>();
        for (String k : List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning")) {
            a.put(k, 88);
        }
        return a;
    }

    private HttpResult send(String method, String path, String token, Object body) {
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token);
            if ("GET".equals(method)) {
                builder.GET();
            } else {
                builder.method(method, java.net.http.HttpRequest.BodyPublishers
                        .ofString(MAPPER.writeValueAsString(body == null ? Map.of() : body)));
            }
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient()
                    .send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString());
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
