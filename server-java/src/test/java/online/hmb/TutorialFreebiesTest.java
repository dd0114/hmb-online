package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #493 W6-v3 — <b>무료 쿠폰이 실제로 값을 대신 내는가</b> + 첫 트레이드 등급 확정 + 첫 강화 보상.
 *
 * <p>이 테스트가 성립하는 이유는 픽스처 경제가 <b>쿠폰 없이는 못 하게</b> 되어 있기 때문이다 —
 * 잠재 다이스는 5,000 G 인데 가입 지급은 3,000 G 다. 즉 "무료였다"는 응답 플래그가 아니라
 * <b>성공했다는 사실 자체</b>로 관측된다(쿠폰을 떼면 400 INSUFFICIENT_POINTS 로 뒤집힌다).
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        // ⚠️ #493 W9 — 플래키 제거. **오퍼 등급은 SecureRandom 시드에서 굴러 나온다**
        // (TradeSeedSource → deriveOffer). 등급이 대기시간을 정하고(economy trade.waitHours),
        // 대기시간이 단축 비용을 정하므로(ceil(h × 50)), 두 번째 단축의 청구액이 **매 실행 달라졌다**:
        // BRONZE 50 · SILVER 300 · GOLD 1,200 · DIA 2,400 · **LEGEND 3,600**. 신규 지갑은 3,000 이라
        // LEGEND 가 나오는 실행(가중치 0.05)만 402 PAYMENT_REQUIRED 로 뒤집혔다 — 실측 1/27.
        // (기제 증빙: 전 등급 대기를 72h 로 고정하면 이 클래스가 **결정론적으로** 그 실패를 낸다.)
        //
        // 고침 = **등급→비용 의존 자체를 끊는다**. 전 등급 카운트다운을 1시간으로 고정하면 어떤 롤이
        // 나와도 청구액이 50 P 다. 프로덕션 랜덤(SecureRandom)은 그대로 두고 이 클래스의 **출발
        // 상태**만 고정하는 것이다 — 이 클래스의 주제는 쿠폰이지 등급별 대기 곡선이 아니고,
        // 그 곡선의 계약은 TradeWaitSecondsOverrideTest 가 전담한다
        // (TestDbSupport.disableMatchClock·disableTutorialStarter 와 같은 규율).
        "hmb.trade.wait-seconds.BRONZE=3600",
        "hmb.trade.wait-seconds.SILVER=3600",
        "hmb.trade.wait-seconds.GOLD=3600",
        "hmb.trade.wait-seconds.DIA=3600",
        "hmb.trade.wait-seconds.LEGEND=3600"
})
class TutorialFreebiesTest extends ApiTestBase {

    private static final String TUTORIAL_CARD = "P002";
    /** 픽스처의 유일한 DIA 카드 — 첫 트레이드 확정 등급의 결과가 이것이어야 한다. */
    private static final String FIXTURE_DIA = "P017";

    @Resource
    JdbcClient jdbcClient;

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.tutorial.starter.card-id", () -> TUTORIAL_CARD);
    }

    private String userId(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }

    private long points(String nickname) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId(nickname)).query(Long.class).single();
    }

    private int unusedCoupons(String nickname, String type) {
        return jdbcClient.sql("SELECT COUNT(*) FROM user_coupons WHERE user_id = ? AND type = ? "
                        + "AND used_at IS NULL")
                .params(userId(nickname), type).query(Integer.class).single();
    }

    private int mails(String nickname, String campaignId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM user_mails WHERE user_id = ? AND campaign_id = ?")
                .params(userId(nickname), campaignId).query(Integer.class).single();
    }

    // ── 첫 강화 무료 (FREE_ENHANCE) ─────────────────────────────────────

    @Test
    void theFirstEnhanceIsFreeAndTheSecondOneIsNot() {
        String nick = "tut-dice";
        String token = login(nick);
        // 강화(잠재 다이스)는 2★ 부터다 — 튜토리얼 순서(승급 → 강화)가 여기 걸려 있다.
        assertThat(authPost("/api/growth/star", token, Map.of("playerId", TUTORIAL_CARD), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        long before = points(nick);
        ResponseEntity<Map> dice = authPost("/api/growth/dice", token,
                Map.of("playerId", TUTORIAL_CARD, "kind", "NORMAL"), Map.class);

        assertThat(dice.getStatusCode()).as("쿠폰이 없으면 잔액(3,000)이 비용(5,000)에 못 미쳐 400 이다")
                .isEqualTo(HttpStatus.OK);
        assertThat(dice.getBody().get("freeByCoupon")).isEqualTo(true);
        assertThat(points(nick)).as("무료면 원장에 0원 행도 만들지 않는다").isEqualTo(before);
        assertThat(unusedCoupons(nick, "FREE_ENHANCE")).as("쿠폰은 소비된다").isZero();

        // 두 번째는 값을 낸다 — 그래서 잔액이 모자라 거부된다(= 쿠폰이 1회성임의 관측).
        ResponseEntity<Map> second = authPost("/api/growth/dice", token,
                Map.of("playerId", TUTORIAL_CARD, "kind", "NORMAL"), Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(second.getBody().get("code")).isEqualTo("INSUFFICIENT_POINTS");
    }

    @Test
    void theFirstEnhanceSendsTheRewardMailExactlyOnce() {
        String nick = "tut-dice-reward";
        String token = login(nick);
        authPost("/api/growth/star", token, Map.of("playerId", TUTORIAL_CARD), Map.class);

        assertThat(mails(nick, "uxa_first_enhance")).isZero();
        authPost("/api/growth/dice", token, Map.of("playerId", TUTORIAL_CARD, "kind", "NORMAL"), Map.class);
        assertThat(mails(nick, "uxa_first_enhance")).isEqualTo(1);

        // 두 번째 강화가 성공하더라도 우편은 늘지 않는다(멱등) — 잔액을 채워 실제로 한 번 더 굴린다.
        jdbcClient.sql("UPDATE wallets SET points = 99999 WHERE user_id = ?").param(userId(nick)).update();
        ResponseEntity<Map> second = authPost("/api/growth/dice", token,
                Map.of("playerId", TUTORIAL_CARD, "kind", "NORMAL"), Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(second.getBody().get("freeByCoupon")).as("쿠폰은 이미 썼다").isEqualTo(false);
        assertThat(mails(nick, "uxa_first_enhance")).isEqualTo(1);
    }

    // ── 첫 트레이드: 등급 확정 + 단축 무료 ──────────────────────────────

    @Test
    void theFirstTradeOfferIsForcedToTheConfiguredHighGradeAndTheRushIsFree() {
        String nick = "tut-trade";
        String token = login(nick);

        ResponseEntity<Map> start = authPost("/api/trade/1/start", token, Map.of(), Map.class);
        assertThat(start.getStatusCode()).isEqualTo(HttpStatus.OK);
        @SuppressWarnings("unchecked")
        Map<String, Object> slot = (Map<String, Object>) start.getBody().get("slot");
        assertThat(slot.get("state")).isEqualTo("WAITING");
        assertThat(slot.get("targetGrade")).as("첫 트레이드는 확정 등급").isEqualTo("DIA");
        assertThat(unusedCoupons(nick, "FIRST_TRADE_EPIC")).as("티켓은 소비된다").isZero();
        // 카운트다운 중에는 정체를 가리므로(WAITING 마스킹) 대상 확인은 DB 로 한다.
        assertThat(jdbcClient.sql("SELECT target_player_id FROM trade_slots WHERE user_id = ? AND slot_no = 1")
                .param(userId(nick)).query(String.class).single()).isEqualTo(FIXTURE_DIA);

        long before = points(nick);
        ResponseEntity<Map> rush = authPost("/api/trade/1/speedup", token, Map.of(), Map.class);
        assertThat(rush.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(rush.getBody().get("spent")).as("무료면 지출은 0 이다").isEqualTo(0);
        assertThat(points(nick)).isEqualTo(before);
        assertThat(unusedCoupons(nick, "FREE_TRADE_RUSH")).isZero();
        @SuppressWarnings("unchecked")
        Map<String, Object> opened = (Map<String, Object>) rush.getBody().get("slot");
        assertThat(opened.get("state")).as("무료여도 단축은 실제로 일어난다").isEqualTo("OPEN");
    }

    /**
     * 쿠폰을 다 쓰면 <b>서버가 제시한 그 값을 그대로</b> 낸다. {@code > 0} 이 아니라 <b>견적과 청구가
     * 같다</b>로 거는 이유: 등급 롤이 값을 흔들던 자리라(클래스 머리말) "0보다 크다"는 흔들림을
     * 통과시켰고, 값이 견적과 어긋나는 것이 #213 이 만든 버그의 형태다.
     */
    @Test
    void theSecondRushIsChargedNormally() {
        String nick = "tut-trade-2nd";
        String token = login(nick);
        authPost("/api/trade/1/start", token, Map.of(), Map.class);
        authPost("/api/trade/1/speedup", token, Map.of(), Map.class);   // 무료 1회 소진
        // 오퍼를 버리고 새로 시작 = 새 대기 회차
        ResponseEntity<Map> restart = authPost("/api/trade/1/start", token, Map.of(), Map.class);
        @SuppressWarnings("unchecked")
        Map<String, Object> waiting = (Map<String, Object>) restart.getBody().get("slot");
        int quoted = (Integer) waiting.get("speedupCost");
        assertThat(quoted).as("대기 중인 슬롯은 단축 견적을 들고 있다").isGreaterThan(0);

        long before = points(nick);
        ResponseEntity<Map> rush = authPost("/api/trade/1/speedup", token, Map.of(), Map.class);
        assertThat(rush.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((Integer) rush.getBody().get("spent")).as("견적대로 청구된다").isEqualTo(quoted);
        assertThat(points(nick)).isEqualTo(before - quoted);
    }

    /**
     * 반대편 — 쿠폰이 없고 <b>잔액도 없으면</b> 단축은 거부된다. 위 테스트가 "값을 낸다"를 보는데,
     * 값을 내는 경로가 살아 있으려면 못 낼 때 거부되는 것도 같이 참이어야 한다(쿠폰을 떼어도
     * 무료로 열리면 위 계약은 공허하다). 잔액은 롤과 무관하게 0 으로 고정해 결정론으로 만든다.
     */
    @Test
    void theRushIsRefusedWhenTheCouponIsGoneAndTheWalletCannotPay() {
        String nick = "tut-trade-broke";
        String token = login(nick);
        authPost("/api/trade/1/start", token, Map.of(), Map.class);
        authPost("/api/trade/1/speedup", token, Map.of(), Map.class);   // 무료 1회 소진
        authPost("/api/trade/1/start", token, Map.of(), Map.class);

        jdbcClient.sql("UPDATE wallets SET points = 0 WHERE user_id = ?").param(userId(nick)).update();
        ResponseEntity<Map> rush = authPost("/api/trade/1/speedup", token, Map.of(), Map.class);
        assertThat(rush.getStatusCode()).isEqualTo(HttpStatus.PAYMENT_REQUIRED);
        assertThat(rush.getBody().get("code")).isEqualTo("INSUFFICIENT_POINTS");
    }

    /**
     * 두 번째 트레이드는 <b>확정이 아니다</b>. 등급을 직접 단언하면 확률 롤이라 플래키가 되므로,
     * 관측 가능한 성질(<b>티켓이 한 장뿐이었다</b>)로 건다 — 두 번째 start 에서는 소비할 티켓이 없다.
     */
    @Test
    void theRiggedGradeAppliesOnlyOnce() {
        String nick = "tut-trade-once";
        String token = login(nick);
        authPost("/api/trade/1/start", token, Map.of(), Map.class);
        assertThat(unusedCoupons(nick, "FIRST_TRADE_EPIC")).isZero();

        authPost("/api/trade/2/start", token, Map.of(), Map.class);
        List<String> used = jdbcClient.sql(
                        "SELECT used_ref FROM user_coupons WHERE user_id = ? AND type = 'FIRST_TRADE_EPIC'")
                .param(userId(nick)).query(String.class).list();
        assertThat(used).as("티켓은 한 장이고 한 번만 쓰였다").hasSize(1);
        assertThat(used.get(0)).isNotNull();
    }
}
