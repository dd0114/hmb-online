package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * {@code GET /api/config} 계약 + <b>변이체 킬</b> (#232).
 *
 * <p>이 클래스의 요점은 "심볼이 G 인가"가 아니다 — 그건 언제든 바뀌는 값이다. 요점은
 * <b>표기가 데이터를 따라오는가</b>다. 그래서 economy 발행물을 <b>일부러 이상한 표기</b>
 * (심볼 Ω/Ξ · 이름 "오메가"/"크시")로 만들어 놓고, API 응답과 <b>서버 에러 문구</b>가 그 값을
 * 그대로 따라오는지 본다. 어딘가에 "P"·"젬"이 하드코딩돼 있으면 여기서 죽는다.
 *
 * <p>서버 문구까지 보는 이유: 클라이언트는 4xx 의 {@code message} 를 그대로 토스트로 띄운다.
 * 화면 라벨만 서버 주도로 바꾸고 에러 문구를 상수로 두면 "잔액이 Ω 인데 젬이 부족합니다"가 뜬다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class CurrencyConfigApiTest extends ApiTestBase {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /** 발행물이 이기는지 보려고 <b>기본값과 겹치지 않는</b> 표기를 쓴다. */
    private static final String POINT_SYMBOL = "Ω";
    private static final String POINT_NAME = "오메가";
    private static final String GEM_SYMBOL = "Ξ";
    private static final String GEM_NAME = "크시";
    /** 가입 지급 젬(6,000)으로 절대 못 사는 가격 — 단뽑 한 번으로 잔액부족 문구를 끌어낸다. */
    private static final int UNAFFORDABLE = 9_999_999;

    /** #247: 리롤 잔액부족 문구를 끌어내려면 먼저 잠재를 해금해야 해서 DB 준비가 필요하다. */
    @jakarta.annotation.Resource
    private org.springframework.jdbc.core.simple.JdbcClient jdbcClient;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // #493 W6-v3: 이 테스트의 주제는 튜토리얼이 아니다 — 가입 무료 쿠폰을 끄고
        // 과금·롤을 '출발 상태 그대로' 본다(TestDbSupport.disableTutorialStarter javadoc).
        TestDbSupport.disableTutorialStarter(registry);
        registry.add("hmb.data.economy-file", () -> economyWithOddCurrencies().toString());
    }

    /**
     * 표준 픽스처를 읽어 {@code currencies} 만 얹은 파일을 만든다. 픽스처를 통째로 복사해 두면
     * 원본이 바뀔 때 조용히 갈라지므로, <b>원본 위에 덮는</b> 방식으로 만든다.
     */
    private static Path economyWithOddCurrencies() {
        try {
            ObjectNode root = (ObjectNode) MAPPER.readTree(
                    Path.of("src/test/resources/fixtures/economy.v1.json").toFile());
            ArrayNode currencies = root.putArray("currencies");
            currencies.addObject().put("code", "POINT").put("symbol", POINT_SYMBOL).put("name", POINT_NAME);
            currencies.addObject().put("code", "GEM").put("symbol", GEM_SYMBOL).put("name", GEM_NAME);
            ((ObjectNode) root.path("gacha")).put("singleCost", UNAFFORDABLE);
            Path out = Files.createTempDirectory("hmb-currency-econ-").resolve("economy.json");
            Files.writeString(out, MAPPER.writeValueAsString(root));
            return out.toAbsolutePath();
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> config(String token) {
        ResponseEntity<Map> res = authGet("/api/config", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> currency(Map<String, Object> config, String code) {
        List<Map<String, Object>> list = (List<Map<String, Object>>) config.get("currencies");
        return list.stream().filter(c -> code.equals(c.get("code"))).findFirst().orElseThrow();
    }

    /**
     * <b>인증 없이도 200</b> (#232 BL-1).
     *
     * <p>이걸 401 로 두면 클라가 부팅 때 한 번 부르는 이 요청이 <b>로그인 전에</b> 실패하고,
     * 재조회 트리거가 없어 <b>그 세션 전체</b>가 코드 폴백("62,000 POINT")으로 굴러간다.
     * 실제로 그 상태로 구현돼 독립검증에서 잡혔다 — 신규·세션만료 유저의 첫 진입이 전부 그 경로다.
     * 내용은 공개 카탈로그(심볼·이름·공시 가격)라 감출 것이 없다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void configIsReachableWithoutAuth() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/config"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(currency(res.getBody(), "POINT")).containsEntry("symbol", POINT_SYMBOL);
    }

    /** 표기표가 발행물 그대로 내려간다 — 클라가 심볼을 알 필요가 없어지는 지점. */
    @Test
    void configServesTheCurrencyTableFromData() {
        Map<String, Object> config = config(login("cfg-user"));
        assertThat(currency(config, "POINT")).containsEntry("symbol", POINT_SYMBOL)
                .containsEntry("name", POINT_NAME);
        assertThat(currency(config, "GEM")).containsEntry("symbol", GEM_SYMBOL)
                .containsEntry("name", GEM_NAME);
    }

    /**
     * 가격은 <b>재화 코드와 함께</b> 내려간다. 이 둘이 떨어져 있던 것이 #213 버그의 형태였다
     * (뽑기 가격은 클라 상수, 결제 재화는 서버 config → 화면 "300 P" / 실제 다이아 300 차감).
     */
    @Test
    @SuppressWarnings("unchecked")
    void everyPriceCarriesItsCurrency() {
        Map<String, Object> shop = (Map<String, Object>) config(login("cfg-price")).get("shop");
        Map<String, Object> gacha = (Map<String, Object>) shop.get("gacha");
        for (String kind : List.of("single", "ten")) {
            Map<String, Object> price = (Map<String, Object>) gacha.get(kind);
            assertThat(price.get("currency")).as(kind).isEqualTo("GEM"); // 픽스처 gacha.currency
            assertThat((Integer) price.get("cost")).as(kind).isPositive();
        }
        Map<String, Object> dice = (Map<String, Object>) shop.get("dice");
        // 노말=무료재화 / 캐시=유상재화 (#179 V2.2 이원화). 값이 아니라 이 갈림을 박제한다.
        assertThat(((Map<String, Object>) dice.get("normal")).get("currency")).isEqualTo("POINT");
        assertThat(((Map<String, Object>) dice.get("cash")).get("currency")).isEqualTo("GEM");
        assertThat((Integer) ((Map<String, Object>) dice.get("normal")).get("cost"))
                .isEqualTo(5_000); // 픽스처 dice.normalCost — 클라 미러(500)가 틀렸던 그 값
    }

    /** 충전 목업 활성 플래그가 노출된다 — 클라가 죽은 탭을 그리지 않으려면 이게 필요하다. */
    @Test
    @SuppressWarnings("unchecked")
    void gemTopupEnabledFlagIsExposed() {
        Map<String, Object> shop = (Map<String, Object>) config(login("cfg-topup")).get("shop");
        Map<String, Object> topup = (Map<String, Object>) shop.get("gemTopup");
        assertThat(topup.get("enabled")).isEqualTo(false); // 픽스처 gems.topupEnabled
        assertThat((List<?>) topup.get("packs")).isNotEmpty(); // 되살릴 때 쓸 팩 목록은 계속 내려간다
    }

    /**
     * <b>변이체 킬 1</b> — 뽑기 잔액부족 문구가 발행물 이름을 따른다. "젬이 부족합니다"가
     * 상수로 남아 있으면 실패한다. 조사도 이름을 따라간다("크시" → "크시가").
     */
    @Test
    @SuppressWarnings("unchecked")
    void gachaShortageMessageFollowsTheConfiguredName() {
        String token = login("cfg-gacha");
        ResponseEntity<Map> res = authPost("/api/shop/gacha", token, Map.of("kind", "single"), Map.class);
        assertThat(res.getStatusCode().is4xxClientError()).isTrue();
        Map<String, Object> body = res.getBody();
        // 코드는 내부 계약이라 그대로 — 바뀐 것은 표기뿐이다.
        assertThat(body.get("code")).isEqualTo("INSUFFICIENT_GEMS");
        assertThat((String) body.get("message")).isEqualTo(GEM_NAME + "가 부족합니다")
                .doesNotContain("젬").doesNotContain("포인트");
    }

    /**
     * <b>변이체 킬 2</b> — 잠재 리롤(무료재화) 문구도 같은 출처를 탄다.
     * #247 로 결제 지점이 <b>상점 구매 → 롤 자체</b>로 옮겨졌으므로 이 계약도 따라 옮긴다
     * (구매 엔드포인트에만 걸어 두면 실제로 유저가 보는 문구를 아무도 안 지키게 된다).
     */
    @Test
    @SuppressWarnings("unchecked")
    void diceShortageMessageFollowsTheConfiguredName() {
        String token = login("cfg-dice");
        String userId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param("cfg-dice").query(String.class).single();
        unlockPotential(userId, token);
        // 가입 지급 3,000 < 롤 비용 5,000 → 첫 롤부터 잔액부족.
        ResponseEntity<Map> res = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(res.getStatusCode().is4xxClientError()).isTrue();
        assertThat(res.getBody().get("code")).isEqualTo("INSUFFICIENT_POINTS");
        assertThat((String) res.getBody().get("message")).isEqualTo(POINT_NAME + "가 부족합니다")
                .doesNotContain("포인트");
    }

    /** 잠재는 2★부터 해금이라(POTENTIAL_LOCKED) 리롤 문구를 보려면 먼저 성★을 올려야 한다. */
    @SuppressWarnings("unchecked")
    private void unlockPotential(String userId, String token) {
        jdbcClient.sql("""
                        INSERT INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, 'P001', 3, ?)
                        ON CONFLICT(user_id, player_id) DO UPDATE SET count = 3
                        """)
                .params(userId, java.time.Instant.now().toString())
                .update();
        ResponseEntity<Map> star = authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        assertThat(star.getStatusCode()).isEqualTo(HttpStatus.OK);
        // 성 승급은 재화를 쓰지 않는다(중복 소모) — 잔액은 가입 지급 그대로여야 아래 단언이 성립한다.
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single()).isEqualTo(3000L);
    }

    /** <b>변이체 킬 3</b> — 충전 비활성 문구도 이름을 따른다(코드는 TOPUP_DISABLED 유지). */
    @Test
    @SuppressWarnings("unchecked")
    void topupDisabledMessageFollowsTheConfiguredName() {
        ResponseEntity<Map> res = authPost("/api/shop/gems/topup", login("cfg-td"),
                Map.of("packId", "p1"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(res.getBody().get("code")).isEqualTo("TOPUP_DISABLED");
        assertThat((String) res.getBody().get("message")).startsWith(GEM_NAME + " 충전");
    }

    /** 트레이드 단축 비용은 재화 코드를 달고 내려간다(금액과 단위를 떼어 놓지 않는다). */
    @Test
    @SuppressWarnings("unchecked")
    void tradeSpeedupCostCarriesItsCurrency() {
        String token = login("cfg-trade");
        authPost("/api/trade/1/start", token, Map.of(), Map.class);
        ResponseEntity<Map> res = authGet("/api/trade", token, Map.class);
        List<Map<String, Object>> slots = (List<Map<String, Object>>) res.getBody().get("slots");
        Map<String, Object> waiting = slots.stream()
                .filter(s -> "WAITING".equals(s.get("state"))).findFirst().orElseThrow();
        assertThat(waiting.get("speedupCost")).isNotNull();
        assertThat(waiting.get("speedupCurrency")).isEqualTo("POINT");
        // 단축 불가 상태(IDLE)면 비용과 재화가 **같이** 없다 — 한쪽만 남으면 클라가 단위를 지어낸다.
        slots.stream().filter(s -> "IDLE".equals(s.get("state"))).findFirst()
                .ifPresent(idle -> {
                    assertThat(idle.get("speedupCost")).isNull();
                    assertThat(idle.get("speedupCurrency")).isNull();
                });
    }
}
