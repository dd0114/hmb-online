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

    @SuppressWarnings("unchecked")
    @Test
    void diceBalanceEndpointDefaultsToZero() {
        String token = login("api_dice_balance");
        ResponseEntity<Map> res = authGet("/api/growth/dice", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody().get("normal")).isEqualTo(0);
        assertThat(res.getBody().get("cash")).isEqualTo(0);
    }

    @SuppressWarnings("unchecked")
    @Test
    void diceEndpointRollsAfterUnlockAndPurchase() {
        String token = login("api_dice_ok");
        String userId = userIdOf("api_dice_ok");
        setCount(userId, "P001", 2);
        authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);

        // 상점에서 노말 다이스 1개 구매(500P, 스타터 3000P 지급 충분). DiceBuyResult(shared): dice{normal,cash} 중첩.
        ResponseEntity<Map> buy = authPost("/api/shop/dice", token, Map.of("kind", "NORMAL", "count", 1), Map.class);
        assertThat(buy.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(((Map<?, ?>) buy.getBody().get("dice")).get("normal")).isEqualTo(1);

        // GET 잔액도 구매 반영.
        ResponseEntity<Map> balance = authGet("/api/growth/dice", token, Map.class);
        assertThat(balance.getBody().get("normal")).isEqualTo(1);

        ResponseEntity<Map> roll = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(roll.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(roll.getBody().get("tierBefore")).isEqualTo("RARE");
        assertThat((List<?>) roll.getBody().get("lines")).hasSize(1); // BRONZE linesByGrade=1
        assertThat(roll.getBody().get("diceLeft")).isEqualTo(0);
    }

    @SuppressWarnings("unchecked")
    @Test
    void diceEndpointInsufficientDiceRejected() {
        String token = login("api_dice_none");
        String userId = userIdOf("api_dice_none");
        setCount(userId, "P001", 2);
        authPost("/api/growth/star", token, Map.of("playerId", "P001"), Map.class);
        ResponseEntity<Map> res = authPost("/api/growth/dice", token,
                Map.of("playerId", "P001", "kind", "NORMAL"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("INSUFFICIENT_DICE");
    }

    @SuppressWarnings("unchecked")
    @Test
    void shopDiceInsufficientPointsRejected() {
        String token = login("api_dice_poor");
        // 캐시 다이스 1개 = 5000P > 스타터 3000P.
        ResponseEntity<Map> res = authPost("/api/shop/dice", token, Map.of("kind", "CASH", "count", 1), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("INSUFFICIENT_POINTS");
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
