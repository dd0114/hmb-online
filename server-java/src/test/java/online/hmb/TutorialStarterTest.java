package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #493 W6-v3 — <b>스타터 확장</b>: 튜토리얼 재료가 신규 유저 계정에 실제로 서 있는가.
 *
 * <p>계약을 <b>장수(3장)로 걸지 않는다</b>. 3 은 {@code star.copies[2]} 에서 파생된 값이라 계수를
 * 조정하면 같이 움직여야 하고, 숫자를 박으면 계수를 바꾼 순간 "테스트는 통과하는데 승급 버튼은
 * 막혀 있는" 상태가 된다. 그래서 <b>실제로 승급이 되는가</b>로 건다 — 그게 hero 요구
 * ("무조건 한명 강화, 승급시켜야돼")의 문자 그대로다.
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
class TutorialStarterTest extends ApiTestBase {

    /** 픽스처 카탈로그의 BRONZE 카드이자 기본팩 구성원(출하 기본 P122 는 픽스처에 없다). */
    private static final String TUTORIAL_CARD = "P002";

    @Resource
    JdbcClient jdbcClient;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.tutorial.starter.card-id", () -> TUTORIAL_CARD);
    }

    @Test
    void newUserGetsEnoughCopiesToActuallyStarUpTheTutorialCard() {
        String token = login("tut-star");

        // 승급이 되는 것이 계약이다(장수는 계수에서 파생).
        ResponseEntity<Map> star = authPost("/api/growth/star", token,
                Map.of("playerId", TUTORIAL_CARD), Map.class);
        assertThat(star.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(star.getBody().get("star")).isEqualTo(2);
        // 2★ = 잠재능력 해금 = "강화(다이스)"를 할 수 있는 상태. 튜토리얼 순서가 여기 걸려 있다.
        assertThat(star.getBody().get("potentialUnlocked")).isEqualTo(true);
    }

    @Test
    void theTutorialCardComesWithExactlyOneReadyToUseEnhanceChoice() {
        String token = login("tut-xp");

        ResponseEntity<Map> choices = authGet(
                "/api/growth/choices?playerId=" + TUTORIAL_CARD, token, Map.class);
        assertThat(choices.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        java.util.List<Map<String, Object>> pending =
                (java.util.List<Map<String, Object>>) choices.getBody().get("choices");
        assertThat(pending).as("XP 프리필 = 강화 1회 가능(3지선다 1장 대기)").hasSize(1);
        @SuppressWarnings("unchecked")
        java.util.List<Object> candidates = (java.util.List<Object>) pending.get(0).get("candidates");
        assertThat(candidates).as("빈 선택권을 만들지 않는다").isNotEmpty();

        // 다른 카드에는 안 붙는다 — "고정 한 명"이 계약이다.
        ResponseEntity<Map> other = authGet("/api/growth/choices?playerId=P005", token, Map.class);
        @SuppressWarnings("unchecked")
        java.util.List<Object> otherPending = (java.util.List<Object>) other.getBody().get("choices");
        assertThat(otherPending).isEmpty();
    }

    @Test
    void newUserHoldsTheThreeTutorialCoupons() {
        String token = login("tut-coupon");

        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Integer> coupons = (Map<String, Integer>) me.getBody().get("coupons");
        assertThat(coupons)
                .containsEntry("FREE_ENHANCE", 1)
                .containsEntry("FREE_TRADE_RUSH", 1)
                .containsEntry("FIRST_TRADE_EPIC", 1);
    }

    /**
     * 지급 멱등 — 같은 {@code (user, type, grant_key)} 는 몇 번을 시도해도 한 장이다.
     * (가입 tx 가 busy-retry 로 재실행되는 경로가 실재한다 — 그때 쿠폰이 늘면 안 된다.)
     */
    @Test
    void grantingTheSameCouponTwiceDoesNotStack() {
        String token = login("tut-idem");
        String userId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param("tut-idem").query(String.class).single();

        // 가입이 이미 한 번 준 것을 그대로 다시 시도한다(같은 grant_key).
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_coupons(id, user_id, type, grant_key, granted_at,
                                                           used_at, used_ref, expires_at)
                        VALUES ('dup', ?, 'FREE_ENHANCE', 'starter', '2026-01-01T00:00:00Z', NULL, NULL, NULL)
                        """)
                .param(userId).update();

        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Integer> coupons = (Map<String, Integer>) me.getBody().get("coupons");
        assertThat(coupons).containsEntry("FREE_ENHANCE", 1);
    }

    /**
     * #493 W9 — <b>서버가 아는 값을 클라가 추론하지 않게 한다</b>. web 은 고정 카드 id 를
     * "대기 중인 3지선다의 주인"으로 <b>추론</b>하고 있었는데(apps/web {@code onrail-api.ts}),
     * 유저가 다른 카드로 경기를 치르거나 선택권을 이미 써 버리면 어긋나는 추론이다.
     *
     * <p>단언을 출하 기본값({@code P122})이 아니라 <b>이 클래스가 오버라이드한 값</b>으로 거는 것이
     * 계약의 전부다 — 컨트롤러가 id 를 하드코딩하거나 별도 프로퍼티를 읽으면 여기서 죽는다
     * (지급 로직이 쓰는 그 필드가 유일한 출처여야 한다).
     */
    @Test
    void theConfigEndpointPublishesTheCardIdThatTheGrantLogicUses() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/config"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> tutorial = (Map<String, Object>) res.getBody().get("tutorial");
        assertThat(tutorial).as("additive 필드 — 없으면 web 이 추론으로 되돌아간다").isNotNull();
        assertThat(tutorial.get("starterCardId")).isEqualTo(TUTORIAL_CARD);

        // 그 카드가 실제로 재료를 받은 카드다 = 표시와 지급이 같은 값을 가리킨다.
        String token = login("tut-config");
        ResponseEntity<Map> star = authPost("/api/growth/star", token,
                Map.of("playerId", (String) tutorial.get("starterCardId")), Map.class);
        assertThat(star.getStatusCode()).isEqualTo(HttpStatus.OK);
    }
}
