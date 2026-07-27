package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#207 {@code active} 경계</b> — 비활성 유닛은 <b>신규 획득 경로에서만</b> 빠지고, <b>보유·사용
 * 경로는 하나도 건드리지 않는다</b>(hero 결정 U-D1 = 기보유 유저 손실 0).
 *
 * <p>이 경계가 이 웨이브에서 가장 틀리기 쉬운 지점이다. 필터를 한 곳 덜 걸면 비활성 유닛이 계속
 * 뽑히고(개편이 무의미), 한 곳 더 걸면 <b>이미 가진 카드가 사라진다</b>(뺏는 것 = U-D1 정면 위반).
 * 그래서 <b>빠져야 하는 곳</b>과 <b>빠지면 안 되는 곳</b>을 같은 파일에서 대조한다.
 *
 * <p>덱 편성·매치는 {@link InactiveUnitMatchFlowTest} 가 전담한다(러너·서번트 스텁이 필요해 분리).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminUnitActiveFilterTest extends ApiTestBase {

    private static final String ADMIN_NICK = "active_admin";
    private static final String ADMIN_PW = "active-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    /**
     * 클래스 단위로 DB 를 공유하므로 매 메서드 시작 시 <b>전원 활성</b>으로 되돌린다. 없으면 앞 테스트가
     * 끈 유닛이 다음 테스트의 전제를 무너뜨려 실행 순서에 따라 결과가 달라진다(재현 안 되는 실패).
     */
    @org.junit.jupiter.api.BeforeEach
    void reactivateEverything() {
        jdbcClient.sql("UPDATE players SET active = 1").update();
    }

    // ═══════════ 빠져야 하는 곳 ═══════════

    /**
     * <b>가챠 추첨 풀</b> — 비활성 유닛은 뽑히지 않는다. 어드민 API 로 끈 뒤 확인해 <b>API →
     * 필터</b> 사슬 전체를 한 번에 건다(DB 를 직접 고쳐 확인하면 API 가 죽어도 통과한다).
     */
    @Test
    void deactivatedUnitNeverAppearsInGachaPool() {
        String admin = adminToken();
        // GOLD 3종 중 2종을 끈다 — 남은 1종이 있어야 "등급이 통째로 빈" 케이스와 구분된다.
        deactivateViaApi(admin, "P010");
        deactivateViaApi(admin, "P011");

        Set<String> drawn = drawMany("gacha_active", 40);
        assertThat(drawn).as("비활성 유닛이 뽑혔다").doesNotContain("P010", "P011");
        assertThat(drawn).as("같은 등급의 활성 유닛까지 사라졌다 — 필터가 등급 단위로 번졌다").contains("P014");
    }

    /**
     * <b>어떤 등급이 통째로 비활성</b>이어도 500 이 나지 않고 나머지 등급으로 재분배된다.
     *
     * <p>{@code drawOne} 은 풀이 빈 등급을 후보에서 빼고 가중치를 정규화하므로 확률표를 손댈 필요가
     * 없다. 위험한 건 <b>10연차 pity</b>다 — pity 등급 이상이 전부 비면 교체 대상이 없어
     * "추첨 가능한 등급이 없습니다"로 <b>10연차가 통째로 500</b> 이 됐다(운영자가 상위 등급을
     * 끄는 순간 상점이 죽는다). 그 경로를 실제로 밟는다: fixture pity = GOLD 이므로 GOLD·DIA·LEGEND 를
     * 전부 끈다.
     */
    @Test
    void wholeGradeDeactivationRedistributesInsteadOfFailing() {
        String token = login("gacha_grade_off");
        setActive(false, "P010", "P011", "P014", "P016", "P017");   // GOLD 3 + LEGEND 1 + DIA 1

        for (int i = 0; i < 3; i++) {
            ResponseEntity<Map> ten = authPost("/api/shop/gacha", token, Map.of("kind", "ten"), Map.class);
            assertThat(ten.getStatusCode())
                    .as("상위 등급이 전부 비활성인데 10연차가 터졌다(pity 교체 경로): " + ten.getBody())
                    .isEqualTo(HttpStatus.OK);
            for (String id : idsOf(ten)) {
                assertThat(gradeOf(id)).as(id + " — 비활성 등급이 뽑혔다").isIn("BRONZE", "SILVER");
            }
            grant(token, 3000);
        }
    }

    /** <b>트레이드 타깃 선정</b> — 비활성 유닛은 오퍼로 등장하지 않는다. */
    @Test
    void deactivatedUnitIsNeverOfferedInTrade() {
        String token = login("trade_active");
        setActive(false, "P016", "P017");   // LEGEND·DIA 전부 끄기 → 상위 등급 오퍼가 사라져야 한다

        List<String> targets = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            int slot = (i % 3) + 1;
            ResponseEntity<Map> start = authPost("/api/trade/" + slot + "/start", token, Map.of(), Map.class);
            if (!start.getStatusCode().is2xxSuccessful()) {
                continue;   // 카운트다운 중 재시작 불가(정상 전이) — 이 테스트의 주제가 아니다
            }
            targets.addAll(jdbcClient.sql("SELECT target_player_id FROM trade_slots WHERE user_id = ?")
                    .param(userIdOf("trade_active")).query(String.class).list());
        }
        assertThat(targets).as("트레이드 오퍼가 하나도 안 생겨 검사가 공허하다").isNotEmpty();
        assertThat(targets).as("비활성 유닛이 트레이드 타깃으로 나왔다").doesNotContain("P016", "P017");
    }

    /** <b>도감 목록</b> — 미보유 비활성 유닛은 목록에서 빠진다. */
    @Test
    void deactivatedUnitIsHiddenFromCatalogWhenNotOwned() {
        String token = login("catalog_active");
        setActive(false, "P016");   // 스타터팩은 P001..P014 라 P016 은 미보유

        assertThat(catalogIds(token)).as("미보유 비활성 유닛이 도감에 남아 있다").doesNotContain("P016");
    }

    // ═══════════ 빠지면 안 되는 곳 ═══════════

    /**
     * <b>보유분은 뺏지 않는다</b> — 같은 {@code /api/players} 라도 이미 가진 비활성 유닛은 계속 보인다.
     *
     * <p>이 엔드포인트는 도감<b>과</b> 덱 편성 화면 공용이다. 무조건 걸러 버리면 내 카드가
     * 덱 화면에서 사라져 사실상 뺏는 것이 된다 — U-D1(손실 0) 위반이자 "내 카드가 없어졌다" 클레임이다.
     */
    @Test
    void ownedInactiveUnitRemainsVisibleInCatalog() {
        String token = login("catalog_owned");
        setActive(false, "P005");   // 스타터팩으로 보유 중인 유닛을 끈다

        List<Map<String, Object>> players = catalog(token);
        Map<String, Object> owned = players.stream()
                .filter(p -> "P005".equals(p.get("id"))).findFirst().orElse(null);
        assertThat(owned).as("보유 중인 비활성 유닛이 목록에서 사라졌다 — 카드를 뺏은 것과 같다").isNotNull();
        assertThat(owned.get("owned")).isEqualTo(true);
        assertThat(((Number) owned.get("ownedCount")).intValue()).isGreaterThanOrEqualTo(1);
    }

    /**
     * <b>도감이 활성/비활성을 구분해 내려준다(U-D7)</b> — 보유분은 계속 보이므로(위 테스트) 클라 입장에선
     * "펠레가 도감에 있는데 아무리 뽑아도 안 나온다 = 버그인가?" 가 된다. {@code active} 필드가 있어야
     * 도감이 "off" 로 표기해 그 인지 갭을 해소할 수 있다.
     *
     * <p>필드 존재만이 아니라 <b>두 값이 실제로 갈리는지</b>를 같은 응답 안에서 대조한다 —
     * 상수 true 를 박아도 통과하는 검사는 계약이 아니다.
     */
    @Test
    void catalogReportsActiveFlagForOwnedUnits() {
        String token = login("cat_activeflag");
        setActive(false, "P005");   // 스타터팩 보유분을 끈다 → 목록엔 남되 active=false 여야 한다

        List<Map<String, Object>> players = catalog(token);

        Map<String, Object> inactiveOwned = byId(players, "P005");
        assertThat(inactiveOwned).as("보유 중인 비활성 유닛이 목록에서 사라졌다").isNotNull();
        assertThat(inactiveOwned.get("active"))
                .as("보유 비활성 유닛이 active=false 로 내려오지 않는다 — 도감이 off 표기를 할 수 없다")
                .isEqualTo(false);
        assertThat(inactiveOwned.get("owned")).as("비활성이라고 보유 표시까지 사라졌다").isEqualTo(true);

        Map<String, Object> activeOwned = byId(players, "P006");
        assertThat(activeOwned).as("활성 유닛이 목록에 없다").isNotNull();
        assertThat(activeOwned.get("active"))
                .as("활성 유닛까지 active=false 로 내려온다 — 플래그가 실제 값을 안 싣고 있다")
                .isEqualTo(true);
    }

    /** <b>보유 데이터는 손대지 않는다</b> — 비활성화는 {@code user_players} 행을 지우거나 바꾸지 않는다. */
    @Test
    void deactivationDoesNotTouchOwnershipRows() {
        login("holdings_intact");
        String userId = userIdOf("holdings_intact");
        List<String> before = ownedIds(userId);
        long starsBefore = jdbcClient.sql("SELECT COALESCE(SUM(star), 0) FROM user_players WHERE user_id = ?")
                .param(userId).query(Long.class).single();

        setActive(false, "P003", "P004", "P005");

        assertThat(ownedIds(userId)).as("비활성화가 보유 행을 건드렸다").isEqualTo(before);
        assertThat(jdbcClient.sql("SELECT COALESCE(SUM(star), 0) FROM user_players WHERE user_id = ?")
                .param(userId).query(Long.class).single()).isEqualTo(starsBefore);
    }

    /** <b>성장(유효스탯) 계산</b>은 활성 여부와 무관하다 — 비활성 카드도 성장·조회가 정상 동작한다. */
    @Test
    void growthStillWorksForInactiveOwnedUnit() {
        String token = login("growth_inactive");
        ResponseEntity<Map> before = authGet("/api/growth/card/P006", token, Map.class);
        assertThat(before.getStatusCode()).isEqualTo(HttpStatus.OK);

        setActive(false, "P006");

        ResponseEntity<Map> after = authGet("/api/growth/card/P006", token, Map.class);
        assertThat(after.getStatusCode()).as("비활성 카드의 성장 조회가 막혔다").isEqualTo(HttpStatus.OK);
        assertThat(after.getBody().get("ovr")).isEqualTo(before.getBody().get("ovr"));
        assertThat(after.getBody().get("caps")).isEqualTo(before.getBody().get("caps"));
    }

    // ───────────────────────── helpers ─────────────────────────

    private void setActive(boolean active, String... playerIds) {
        for (String id : playerIds) {
            jdbcClient.sql("UPDATE players SET active = ? WHERE id = ?").params(active ? 1 : 0, id).update();
        }
    }

    private void deactivateViaApi(String adminToken, String playerId) {
        HttpResult res = post("/api/admin/units/" + playerId + "/deactivate", adminToken,
                Map.of("reason", "필터 검증"));
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
    }

    /** 뽑기를 여러 번 돌려 등장한 playerId 집합을 모은다(포인트는 그때그때 어드민 지급으로 충전). */
    private Set<String> drawMany(String nickname, int pulls) {
        String token = login(nickname);
        Set<String> seen = new java.util.HashSet<>();
        for (int i = 0; i < pulls; i++) {
            ResponseEntity<Map> res = authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class);
            if (!res.getStatusCode().is2xxSuccessful()) {
                grant(token, 3000);
                continue;
            }
            seen.addAll(idsOf(res));
        }
        assertThat(seen).as("뽑기가 한 번도 성공하지 않아 검사가 공허하다").isNotEmpty();
        return seen;
    }

    @SuppressWarnings("unchecked")
    private List<String> idsOf(ResponseEntity<Map> gachaResponse) {
        List<Map<String, Object>> results =
                (List<Map<String, Object>>) gachaResponse.getBody().get("results");
        List<String> ids = new ArrayList<>();
        for (Map<String, Object> r : results) {
            ids.add((String) ((Map<?, ?>) r.get("player")).get("id"));
        }
        return ids;
    }

    /** 뽑기 자금 보충 — admin 지급 경로를 그대로 쓴다(테스트 전용 뒷문을 만들지 않는다). */
    private void grant(String userToken, long amount) {
        String userId = jdbcClient.sql("""
                        SELECT user_id FROM sessions WHERE token = ?
                        """).param(userToken).query(String.class).single();
        Map<String, Object> body = new HashMap<>();
        body.put("delta", amount);
        body.put("reason", "테스트 자금");
        HttpResult res = post("/api/admin/users/" + userId + "/points", adminToken(), body);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> catalog(String token) {
        return authGet("/api/players", token, List.class).getBody();
    }

    private Map<String, Object> byId(List<Map<String, Object>> players, String playerId) {
        return players.stream().filter(p -> playerId.equals(p.get("id"))).findFirst().orElse(null);
    }

    private List<String> catalogIds(String token) {
        return catalog(token).stream().map(p -> (String) p.get("id")).toList();
    }

    private List<String> ownedIds(String userId) {
        return jdbcClient.sql("SELECT player_id FROM user_players WHERE user_id = ? ORDER BY player_id")
                .param(userId).query(String.class).list();
    }

    private String gradeOf(String playerId) {
        return jdbcClient.sql("SELECT grade FROM players WHERE id = ?").param(playerId)
                .query(String.class).single();
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private HttpResult post(String path, String token, Map<String, Object> body) {
        try {
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(baseUrl(path)))
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
