package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

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
 * 성장 HTTP 엔드포인트 — 메이플 피벗 V2(에픽 #179 §V2-4). 계산 로직은 GrowthServiceTest.
 * 구 enhance/limitbreak 엔드포인트는 제거됨(404).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthApiTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @SuppressWarnings("unchecked")
    @Test
    void cardEndpointReturnsEffectiveCard() {
        String token = login("api_card");
        ResponseEntity<Map> res = authGet("/api/growth/card/P001", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = res.getBody();
        assertThat(body.get("playerId")).isEqualTo("P001");
        assertThat(body.get("grade")).isEqualTo("BRONZE");
        assertThat(body.get("star")).isEqualTo(1);
        assertThat(body).containsKeys("attributes", "prePotential", "caps", "base", "statLevels",
                "potential", "ovr", "completion");
    }

    @SuppressWarnings("unchecked")
    @Test
    void starEndpointPromotesAndUnlocksPotentialAt2() {
        String token = login("api_star");
        String userId = userIdOf("api_star");
        setCount(userId, "P001", 5);

        ResponseEntity<Map> ok = authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getBody().get("star")).isEqualTo(2);
        assertThat(ok.getBody().get("spentCopies")).isEqualTo(2);
        assertThat(ok.getBody().get("potentialUnlocked")).isEqualTo(true);
        assertThat(ok.getBody().get("maxTier")).isEqualTo("RARE");

        Integer count = jdbcClient.sql("SELECT count FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, "P001").query(Integer.class).single();
        assertThat(count).isEqualTo(3);
    }

    @SuppressWarnings("unchecked")
    @Test
    void starInsufficientCopiesRejected() {
        String token = login("api_star_no");
        String userId = userIdOf("api_star_no");
        setCount(userId, "P001", 1); // 필요 2
        ResponseEntity<Map> res = authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("INSUFFICIENT_MATERIALS");
    }

    @SuppressWarnings("unchecked")
    @Test
    void diceEndpointRequiresPotentialUnlocked() {
        String token = login("api_dice_locked");
        ResponseEntity<Map> res = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("POTENTIAL_LOCKED");
    }

    /**
     * #247: 구매 단계 자체가 사라졌다 — 다이스는 사는 물건이 아니라 <b>롤 비용</b>이다.
     * 두 엔드포인트(구매·잔액조회)가 살아 있으면 "재고"라는 개념이 반쯤 남아 클라가 다시 그것을
     * 그리게 된다. 그래서 은퇴를 계약으로 박제한다. (미매핑 라우트는 이 서버에서 500 으로
     * 떨어지므로 — enhance/limitbreak 은퇴 계약과 같은 이유 — "OK 가 아니다"를 본다.)
     *
     * <p>⚠️ <b>"OK 가 아니다"만으로는 부족하다</b>(독립검증 major-1). 구매를 통째로 되살려도
     * 신규 유저 잔액(3,000) &lt; 가격(5,000)이라 <b>부활한 구매도 400</b> 을 주고 계약이 통과해
     * 버렸다. 그래서 ① <b>지갑을 넉넉히 채워</b> 잔액부족으로 가려지지 않게 하고 ② 결과가
     * 무엇이든 <b>재고가 한 톨도 생기지 않았음</b>을 함께 본다 — 이게 실제로 되살림을 죽인다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void shopDicePurchaseEndpointRemoved() {
        String token = login("api_dice_shopx");
        String uid = userIdOf("api_dice_shopx");
        // 잔액부족(400)이 은퇴(500)를 대신 통과시키지 못하게 — 살아 있었다면 200 이 나올 조건.
        jdbcClient.sql("UPDATE wallets SET points = 1000000, gems = 1000000 WHERE user_id = ?")
                .param(uid).update();

        ResponseEntity<Map> res = authPost("/api/shop/dice", token,
                Map.of("kind", "NORMAL", "count", 1), Map.class);
        assertThat(res.getStatusCode()).isNotEqualTo(HttpStatus.OK);

        // 재고가 생기지 않았다 = 구매 경로가 정말 없다(핸들러를 되살리면 여기서 죽는다).
        assertThat(diceStockOf(uid)).isZero();
        // 결제도 일어나지 않았다 — 원장에 'dice' 지출이 없다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='dice'")
                .param(uid).query(Integer.class).single()).isZero();
    }

    @SuppressWarnings("unchecked")
    @Test
    void diceBalanceEndpointRemoved() {
        String token = login("api_dice_balx");
        ResponseEntity<Map> res = authGet("/api/growth/dice", token, Map.class);
        assertThat(res.getStatusCode()).isNotEqualTo(HttpStatus.OK);
        // 재고 잔액을 말해 주는 응답 형태가 아니다(살아 있으면 {normal,cash} 200 이 온다).
        assertThat(res.getBody() == null || !res.getBody().containsKey("normal")).isTrue();
    }

    /**
     * 남은 재고 합. #247 이후 이 값은 <b>항상 0</b> 이어야 한다 — V21 이 소각했고 늘릴 경로가 없다.
     * (테이블 자체는 V10 선례대로 드롭하지 않았으므로 조회는 계속 가능하다.)
     */
    private int diceStockOf(String userId) {
        return jdbcClient.sql("SELECT COALESCE(SUM(normal + cash), 0) FROM user_dice WHERE user_id = ?")
                .param(userId).query(Integer.class).single();
    }

    /** 강화탭에서 바로 — 구매 없이 롤 한 번에 지갑이 깎이고 잠재가 바뀐다(#247 핵심 동선). */
    @SuppressWarnings("unchecked")
    @Test
    void diceRollChargesWalletDirectlyWithNoPurchaseStep() {
        String token = login("api_dice_ok");
        String userId = userIdOf("api_dice_ok");
        setCount(userId, "P001", 3); // B1: 여분 2장 + 원본 1장(원본은 절대 소모 안 됨)
        authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        jdbcClient.sql("UPDATE wallets SET points = 12000 WHERE user_id = ?").param(userId).update();

        ResponseEntity<Map> roll = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(roll.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(roll.getBody().get("tierBefore")).isEqualTo("RARE");
        assertThat((List<?>) roll.getBody().get("lines")).hasSize(1); // BRONZE linesByGrade=1
        assertThat(roll.getBody()).doesNotContainKey("diceLeft");
        Map<?, ?> wallet = (Map<?, ?>) roll.getBody().get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(7000L); // 12000 − 5000(normalCost)
        assertThat(((Number) wallet.get("gems")).longValue()).isEqualTo(6000L); // 무료 롤은 유상재화 무접촉
    }

    // 잔액이 롤 비용에 못 미치면 거절 — 구 가격(500)으로 되돌아가면 이 케이스가 통과해버린다.
    @SuppressWarnings("unchecked")
    @Test
    void diceRollRejectedWhenPointsBelowRollCost() {
        String token = login("api_dice_np");
        String uid = userIdOf("api_dice_np");
        setCount(uid, "P001", 3);
        authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        jdbcClient.sql("UPDATE wallets SET points = 4999 WHERE user_id = ?").param(uid).update();

        ResponseEntity<Map> res = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("INSUFFICIENT_POINTS");
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(uid).query(Long.class).single()).isEqualTo(4999L); // 롤백
    }

    // 유료 롤 = 유상재화 전용 결제(#179 V2.2 이원화 유지). 부족하면 INSUFFICIENT_GEMS + 롤백.
    @SuppressWarnings("unchecked")
    @Test
    void diceRollCashDeductsGemsAndRejectsWhenShort() {
        String token = login("api_dice_cash");
        String uid = userIdOf("api_dice_cash");
        setCount(uid, "P001", 3);
        authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        long before = gemsOf(uid);
        assertThat(before).isEqualTo(6000L); // economy initialGems

        ResponseEntity<Map> roll = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "CASH"), Map.class);
        assertThat(roll.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> wallet = (Map<?, ?>) roll.getBody().get("wallet");
        assertThat(((Number) wallet.get("gems")).longValue()).isEqualTo(before - 10); // cashGemCost

        // 잔액을 비용 미만으로 내리면 거절 + 무료재화는 손대지 않는다.
        jdbcClient.sql("UPDATE wallets SET gems = 9, points = 999999 WHERE user_id = ?").param(uid).update();
        ResponseEntity<Map> denied = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "CASH"), Map.class);
        assertThat(denied.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(denied.getBody().get("code")).isEqualTo("INSUFFICIENT_GEMS");
        assertThat(gemsOf(uid)).isEqualTo(9L);
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(uid).query(Long.class).single()).isEqualTo(999999L);
    }

    /**
     * #212: 젬 수급원은 <b>가입 지급 + 리그 우승</b> 둘뿐 — 목업 충전 수도꼭지는 config
     * ({@code gems.topupEnabled=false})로 잠겼다. 뽑기가 젬 결제로 바뀐 뒤 무제한 무료 충전이
     * 살아있으면 경제가 붕괴하므로, "충전이 막혀 있다"를 계약으로 박제한다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void gemsTopupIsDisabledSoGemsCannotBeFarmed() {
        String token = login("api_gems_topup");
        long before = gemsOf(userIdOf("api_gems_topup"));

        ResponseEntity<Map> res = authPost("/api/shop/gems/topup", token, Map.of("packId", "p1"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(res.getBody().get("code")).isEqualTo("TOPUP_DISABLED");
        assertThat(gemsOf(userIdOf("api_gems_topup"))).isEqualTo(before); // 한 톨도 안 늘어난다

        // 알 수 없는 팩도 마찬가지로 지급되지 않는다(게이트가 팩 검증보다 앞서든 뒤서든 결과는 동일).
        ResponseEntity<Map> unknown = authPost("/api/shop/gems/topup", token, Map.of("packId", "nope"), Map.class);
        assertThat(unknown.getStatusCode().is4xxClientError()).isTrue();
        assertThat(gemsOf(userIdOf("api_gems_topup"))).isEqualTo(before);
    }

    // /api/me 지갑에 gems additive — 기존 points 는 무변경. #212: 가입 지급분이 그대로 보인다.
    @SuppressWarnings("unchecked")
    @Test
    void meExposesGemsAdditive() {
        String token = login("api_me_gems");
        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> wallet = (Map<?, ?>) me.getBody().get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(3000L);
        assertThat(((Number) wallet.get("gems")).longValue()).isEqualTo(6000L); // economy initialGems

        // 젬을 쓰면(유료 롤) /api/me 에 그대로 반영된다. #247: 소비 지점이 구매에서 롤로 옮겨졌다.
        String uid = userIdOf("api_me_gems");
        setCount(uid, "P001", 3);
        authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        for (int i = 0; i < 3; i++) {
            authPost("/api/growth/dice", token, Map.of("playerId", "P001", "kind", "CASH"), Map.class);
        }
        ResponseEntity<Map> after = authGet("/api/me", token, Map.class);
        Map<?, ?> walletAfter = (Map<?, ?>) after.getBody().get("wallet");
        assertThat(((Number) walletAfter.get("gems")).longValue()).isEqualTo(6000L - 30L);
        assertThat(((Number) walletAfter.get("points")).longValue()).isEqualTo(3000L);
    }

    private long gemsOf(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    // 구 enhance/limitbreak 엔드포인트 제거 확인 — 이 서버의 GlobalExceptionHandler 는 미매핑 라우트를
    // 500 INTERNAL_ERROR 로 반환한다(NoHandlerFoundException 이 catch-all Exception 핸들러로 떨어짐,
    // 기존 프레임워크 동작 — 이 웨이브 범위 밖). 핵심 확인 대상은 "OK 가 아니다"(더 이상 동작 안 함).
    @SuppressWarnings("unchecked")
    @Test
    void enhanceEndpointRemoved() {
        String token = login("api_enh_gone");
        ResponseEntity<Map> res = authPost("/api/growth/enhance", token, Map.of("playerId", "P001"), Map.class);
        assertThat(res.getStatusCode()).isNotEqualTo(HttpStatus.OK);
    }

    @SuppressWarnings("unchecked")
    @Test
    void limitbreakEndpointRemoved() {
        String token = login("api_lb_gone");
        ResponseEntity<Map> res = authPost("/api/growth/limitbreak", token, Map.of("playerId", "P001"), Map.class);
        assertThat(res.getStatusCode()).isNotEqualTo(HttpStatus.OK);
    }

    @SuppressWarnings("unchecked")
    @Test
    void reportEmptyForUnsettledMatch() {
        String token = login("api_rep");
        ResponseEntity<Map> res = authGet("/api/growth/report/NOPE", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) res.getBody().get("entries")).isEmpty();
    }

    private void setCount(String userId, String playerId, int count) {
        jdbcClient.sql("UPDATE user_players SET count = ? WHERE user_id=? AND player_id=?")
                .params(count, userId, playerId).update();
    }
}
