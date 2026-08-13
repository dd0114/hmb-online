package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.Ulid;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#492 AC4</b> — {@code GET /api/admin/events}(필터·페이징·미지 event 400) +
 * {@code GET /api/admin/events/funnel}(유저별 도달 단계).
 *
 * <p>계약은 <b>동결본</b>(§Plan D3 + D6)이다 — web 이 이 스펙 그대로 목을 만들고 있으므로 필드
 * 이름·모양을 여기서 못박는다. 특히 {@code props} 는 <b>파싱된 객체</b>여야 한다(문자열로 내려가면
 * 클라가 한 번 더 파싱해야 하고, 그 파싱이 실패하면 화면이 조용히 빈다).
 *
 * <p>미인증 401 / 비admin 403 은 {@code AdminGateTest} 가 핸들러 매핑을 반사로 훑어 자동 커버한다 —
 * 여기서도 <b>이 두 라우트에 한해</b> 한 번 더 확인한다(자동 커버가 실제로 이 경로를 집었는지는
 * 그 테스트가 라우트를 못 찾으면 조용히 통과하기 때문).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminEventsApiTest extends ApiTestBase {

    private static final String ADMIN_NICK = "evt_admin";
    private static final String ADMIN_PW = "evt-admin-pw-4242";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    /**
     * 이 클래스는 <b>조회</b>의 계약이라 입력을 통제한다 — DB 를 클래스 단위로 공유하므로 앞 메서드가
     * 남긴 이벤트(로그인 = user_signup)가 total·정렬 단정을 오염시킨다. 기록 경로 자체의 계약은
     * {@code BusinessEventFlowTest} 소관이다.
     */
    @org.junit.jupiter.api.BeforeEach
    void clearEvents() {
        jdbcClient.sql("DELETE FROM business_events").update();
    }

    // ── 스트림: 필터 · 페이징 · 미지 event 400 ────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void listFiltersPagesAndRejectsUnknownEventNames() {
        String admin = adminToken();
        String alice = seedUser("evt_api_alice");
        String bob = seedUser("evt_api_bob");

        seed(alice, "user_signup", Map.of("provider", "guest", "nickname", "evt_api_alice"), "2026-08-10T00:00:01Z");
        seed(alice, "match_start", Map.of("mode", "practice", "matchId", "M1"), "2026-08-10T00:00:02Z");
        seed(alice, "match_start", Map.of("mode", "league", "matchId", "M2"), "2026-08-10T00:00:03Z");
        seed(bob, "user_signup", Map.of("provider", "local", "nickname", "evt_api_bob"), "2026-08-10T00:00:04Z");
        seed(bob, "match_start", Map.of("mode", "away", "matchId", "M3"), "2026-08-10T00:00:05Z");

        // 전체 — 최신이 먼저(occurred_at DESC).
        HttpResult listRes = get("/api/admin/events", admin);
        // 실서버 응답 원문을 로그로 남긴다 — web 세션이 목 페이로드를 이것과 대조한다(AC6).
        System.out.println("[#492 AC4 sample] GET /api/admin/events -> " + listRes.body());
        Map<String, Object> all = asMap(listRes);
        assertThat(((Number) all.get("total")).longValue()).isEqualTo(5);
        assertThat(((Number) all.get("limit")).intValue()).isEqualTo(50);   // config 기본값
        assertThat(((Number) all.get("offset")).intValue()).isZero();
        List<Map<String, Object>> items = (List<Map<String, Object>>) all.get("items");
        assertThat(items).hasSize(5);
        assertThat(items.get(0).get("occurredAt")).isEqualTo("2026-08-10T00:00:05Z");

        // props 는 **객체**다(문자열이면 web 이 또 파싱해야 한다).
        Object props = items.get(0).get("props");
        assertThat(props).isInstanceOf(Map.class);
        assertThat(((Map<String, Object>) props).get("mode")).isEqualTo("away");
        // nickname 은 users JOIN 으로 서버가 붙인다(클라가 유저 목록을 따로 받지 않게).
        assertThat(items.get(0).get("nickname")).isEqualTo("evt_api_bob");
        assertThat(items.get(0).get("userId")).isEqualTo(bob);

        // event 필터
        assertThat(((Number) asMap(get("/api/admin/events?event=user_signup", admin)).get("total"))
                .longValue()).isEqualTo(2);
        // userId 필터
        assertThat(((Number) asMap(get("/api/admin/events?userId=" + alice, admin)).get("total"))
                .longValue()).isEqualTo(3);
        // mode 필터(props 안의 값으로 자른다 — 매치를 종류별 이벤트로 쪼개지 않은 D1 의 귀결)
        assertThat(((Number) asMap(get("/api/admin/events?mode=league", admin)).get("total"))
                .longValue()).isEqualTo(1);
        // 조합
        assertThat(((Number) asMap(get("/api/admin/events?event=match_start&userId=" + alice, admin))
                .get("total")).longValue()).isEqualTo(2);

        // 페이징 — total 은 페이지가 아니라 전체 건수이고, 창은 실제로 겹치지 않는다.
        Map<String, Object> page0 = asMap(get("/api/admin/events?limit=2&offset=0", admin));
        Map<String, Object> page1 = asMap(get("/api/admin/events?limit=2&offset=2", admin));
        assertThat(((Number) page0.get("total")).longValue()).isEqualTo(5);
        assertThat(ids(page0)).hasSize(2);
        assertThat(ids(page1)).hasSize(2);
        assertThat(ids(page0)).doesNotContainAnyElementsOf(ids(page1));

        // limit 상한은 config(200) — 운영 도구라도 전량 덤프는 막는다.
        assertThat(((Number) asMap(get("/api/admin/events?limit=5000", admin)).get("limit")).intValue())
                .isEqualTo(200);

        // 미지 event → 400 (오타 난 필터가 "0건"으로 조용히 거짓말하지 않는다)
        HttpResult bad = get("/api/admin/events?event=nope", admin);
        assertThat(bad.status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(asMap(bad).get("code")).isEqualTo("VALIDATION_ERROR");

        // 타입 오류도 admin 전용 핸들러가 잡는다(전역 핸들러로 새면 예외 메시지가 노출된다).
        HttpResult badLimit = get("/api/admin/events?limit=abc", admin);
        assertThat(badLimit.status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(badLimit.body()).doesNotContain("java.lang.Integer");
    }

    // ── 퍼널: hero 가 실제로 볼 화면 ─────────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void funnelReportsHowFarEachUserGot() {
        String admin = adminToken();
        String far = seedUser("evt_fn_far");
        String near = seedUser("evt_fn_near");

        // far: 원정까지 갔고 두 판 끝냈다.
        seed(far, "user_signup", Map.of("provider", "guest"), "2026-08-09T10:00:00Z");
        seed(far, "tutorial_complete", Map.of("grantedDeck", true), "2026-08-09T10:01:00Z");
        seed(far, "deck_save", Map.of("source", "deck"), "2026-08-09T10:02:00Z");
        seed(far, "gacha_pull", Map.of("kind", "ten"), "2026-08-09T10:03:00Z");
        seed(far, "match_start", Map.of("mode", "practice"), "2026-08-09T10:04:00Z");
        seed(far, "match_finish", Map.of("mode", "practice", "result", "WIN"), "2026-08-09T10:05:00Z");
        seed(far, "league_season_start", Map.of("seasonNo", 1), "2026-08-09T10:06:00Z");
        seed(far, "match_start", Map.of("mode", "league"), "2026-08-09T10:07:00Z");
        seed(far, "match_finish", Map.of("mode", "league", "result", "LOSS"), "2026-08-09T10:08:00Z");
        seed(far, "match_start", Map.of("mode", "away"), "2026-08-09T10:09:00Z");

        // near: 가입하고 튜토리얼까지만.
        seed(near, "user_signup", Map.of("provider", "local"), "2026-08-09T11:00:00Z");
        seed(near, "tutorial_complete", Map.of("grantedDeck", true), "2026-08-09T11:01:00Z");

        HttpResult funnelRes = get("/api/admin/events/funnel", admin);
        System.out.println("[#492 AC4 sample] GET /api/admin/events/funnel -> " + funnelRes.body());
        Map<String, Object> funnel = asMap(funnelRes);
        assertThat((String) funnel.get("generatedAt")).isNotBlank();
        List<Map<String, Object>> users = (List<Map<String, Object>>) funnel.get("users");

        Map<String, Object> farRow = rowOf(users, far);
        assertThat(farRow.get("nickname")).isEqualTo("evt_fn_far");
        assertThat(farRow.get("firstSeenAt")).isEqualTo("2026-08-09T10:00:00Z");
        assertThat(farRow.get("lastSeenAt")).isEqualTo("2026-08-09T10:09:00Z");
        assertThat(((Number) farRow.get("matchesFinished")).intValue()).isEqualTo(2);
        assertThat(((Number) farRow.get("eventCount")).intValue()).isEqualTo(10);
        assertThat((Map<String, Object>) farRow.get("reached")).containsExactlyInAnyOrderEntriesOf(Map.of(
                "signup", true, "tutorial", true, "deck", true, "gacha", true,
                "practice", true, "league", true, "away", true));

        Map<String, Object> nearRow = rowOf(users, near);
        assertThat(((Number) nearRow.get("matchesFinished")).intValue()).isZero();
        assertThat((Map<String, Object>) nearRow.get("reached")).containsExactlyInAnyOrderEntriesOf(Map.of(
                "signup", true, "tutorial", true, "deck", false, "gacha", false,
                "practice", false, "league", false, "away", false));

        // 정렬 = lastSeenAt DESC (심사 중 방금 움직인 사람이 위에 있어야 한다)
        List<String> order = users.stream().map(u -> (String) u.get("lastSeenAt")).toList();
        assertThat(order).isSortedAccordingTo(java.util.Comparator.reverseOrder());
    }

    /** 실제 유저 행동이 그대로 두 API 에 나타난다(스키마만 맞고 배선이 죽어 있는 것을 막는다). */
    @SuppressWarnings("unchecked")
    @Test
    void realHttpActivityShowsUpInBothViews() {
        String admin = adminToken();
        login("evt_live_user");
        String userId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param("evt_live_user").query(String.class).single();

        Map<String, Object> page = asMap(get("/api/admin/events?userId=" + userId, admin));
        assertThat(((Number) page.get("total")).longValue()).isEqualTo(1);
        Map<String, Object> row = ((List<Map<String, Object>>) page.get("items")).get(0);
        assertThat(row.get("event")).isEqualTo("user_signup");
        assertThat(((Map<String, Object>) row.get("props")).get("nickname")).isEqualTo("evt_live_user");

        Map<String, Object> funnelRow = rowOf(
                (List<Map<String, Object>>) asMap(get("/api/admin/events/funnel", admin)).get("users"),
                userId);
        assertThat((Map<String, Object>) funnelRow.get("reached")).containsEntry("signup", true);
        assertThat((Map<String, Object>) funnelRow.get("reached")).containsEntry("practice", false);
    }

    // ── 게이트(자동 커버가 이 두 라우트를 실제로 집는지 한 번 더) ──────────

    @Test
    void bothRoutesAreBehindTheAdminGate() {
        String victim = login("evt_gate_victim");
        for (String path : List.of("/api/admin/events", "/api/admin/events/funnel")) {
            assertThat(rest.getForEntity(baseUrl(path), String.class).getStatusCode())
                    .as("미인증 " + path).isEqualTo(HttpStatus.UNAUTHORIZED);
            assertThat(authGet(path, victim, String.class).getStatusCode())
                    .as("비admin " + path).isEqualTo(HttpStatus.FORBIDDEN);
        }
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private static Map<String, Object> rowOf(List<Map<String, Object>> users, String userId) {
        return users.stream().filter(u -> userId.equals(u.get("userId"))).findFirst()
                .orElseThrow(() -> new AssertionError("퍼널에 유저가 없다: " + userId));
    }

    @SuppressWarnings("unchecked")
    private static List<String> ids(Map<String, Object> page) {
        return ((List<Map<String, Object>>) page.get("items")).stream()
                .map(i -> (String) i.get("id")).toList();
    }

    private String seedUser(String nickname) {
        login(nickname);
        String id = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
        // 로그인이 남긴 실제 이벤트는 지운다 — 이 테스트는 **조회**의 계약이라 입력을 통제한다
        // (기록 경로의 계약은 BusinessEventFlowTest 소관).
        jdbcClient.sql("DELETE FROM business_events WHERE user_id = ?").param(id).update();
        return id;
    }

    private void seed(String userId, String event, Map<String, Object> props, String occurredAt) {
        try {
            jdbcClient.sql("""
                            INSERT INTO business_events(id, event, user_id, occurred_at, props_json)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(Ulid.next(), event, userId, occurredAt, MAPPER.writeValueAsString(props))
                    .update();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private HttpResult get(String path, String token) {
        try {
            java.net.http.HttpRequest req = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Authorization", "Bearer " + token)
                    .GET().build();
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient()
                    .send(req, java.net.http.HttpResponse.BodyHandlers.ofString());
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

    /** 시각 문자열이 ISO 라 문자열 비교가 곧 시간 비교다(리포 전역 규약). */
    @SuppressWarnings("unused")
    private static String nowIso() {
        return Instant.now().toString();
    }
}
