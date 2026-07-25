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
 * 성장 HTTP 엔드포인트(#179 §3·§6) — 카드 상세·강화·한계돌파. 계산 로직은 GrowthServiceTest.
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
        assertThat(body.get("baseGrade")).isEqualTo("BRONZE");
        assertThat(body).containsKeys("attributes", "caps", "base", "ovr", "completion", "effectiveGrade");
    }

    @SuppressWarnings("unchecked")
    @Test
    void enhanceHappyPathThenInsufficient() {
        String token = login("api_enh");
        String userId = userIdOf("api_enh");
        setCount(userId, "P001", 1); // 스타터 기본 1

        ResponseEntity<Map> ok = authPost("/api/growth/enhance", token, Map.of("playerId", "P001"), Map.class);
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getBody().get("enhanceLevel")).isEqualTo(1);

        // 중복 소진 → 두 번째 강화는 4xx.
        ResponseEntity<Map> fail = authPost("/api/growth/enhance", token, Map.of("playerId", "P001"), Map.class);
        assertThat(fail.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @SuppressWarnings("unchecked")
    @Test
    void enhanceMaxRequiresLimitBreak() {
        String token = login("api_max");
        String userId = userIdOf("api_max");
        setCount(userId, "P001", 20);
        for (int i = 0; i < 5; i++) {
            authPost("/api/growth/enhance", token, Map.of("playerId", "P001"), Map.class);
        }
        ResponseEntity<Map> capped = authPost("/api/growth/enhance", token, Map.of("playerId", "P001"), Map.class);
        assertThat(capped.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST); // ENHANCE_MAX
    }

    @SuppressWarnings("unchecked")
    @Test
    void limitBreakPromotesGrade() {
        String token = login("api_lb");
        String userId = userIdOf("api_lb");
        setCount(userId, "P001", 3);
        ResponseEntity<Map> lb = authPost("/api/growth/limitbreak", token, Map.of("playerId", "P001"), Map.class);
        assertThat(lb.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(lb.getBody().get("promoted")).isEqualTo(true);
        assertThat(lb.getBody().get("effectiveGrade")).isEqualTo("SILVER");
    }

    @SuppressWarnings("unchecked")
    @Test
    void limitBreakInsufficientRejected() {
        String token = login("api_lbno");
        String userId = userIdOf("api_lbno");
        setCount(userId, "P001", 2);
        ResponseEntity<Map> res = authPost("/api/growth/limitbreak", token, Map.of("playerId", "P001"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
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
