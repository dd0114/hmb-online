package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayDeque;
import java.util.Deque;
import java.util.Map;
import java.util.UUID;
import online.hmb.trade.TradeSeedSource;
import online.hmb.trade.TradeService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #149: 레어도별 카운트다운은 config 다(하드코딩 금지). 기본은 economy {@code trade.waitHours[grade]}
 * 지만, 데모/로컬에서 초 단위로 줄일 수 있게 {@code hmb.trade.wait-seconds.{GRADE}} 오버라이드를 둔다
 * (env: {@code HMB_TRADE_WAITSECONDS_GOLD=10}). 기본값은 비어 있어 무회귀.
 *
 * <p>이 테스트는 전 등급을 초 단위로 오버라이드하고 start 후 remainingSec 이 시간 단위(≥3600)가 아니라
 * 오버라이드 값 이하임을 확인한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT, properties = {
        "hmb.trade.wait-seconds.BRONZE=7",
        "hmb.trade.wait-seconds.SILVER=7",
        "hmb.trade.wait-seconds.GOLD=7",
        "hmb.trade.wait-seconds.DIA=7",
        "hmb.trade.wait-seconds.LEGEND=7"
})
class TradeWaitSecondsOverrideTest extends ApiTestBase {

    static final Deque<String> SEEDS = new ArrayDeque<>();

    @TestConfiguration
    static class FixedSeedConfig {
        @Bean
        @Primary
        TradeSeedSource fixedSeedSource() {
            return () -> {
                String next = SEEDS.poll();
                return next != null ? next : "rand-" + UUID.randomUUID();
            };
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // #493 W6-v3: 이 테스트의 주제는 튜토리얼이 아니다 — 가입 무료 쿠폰을 끄고
        // 과금·롤을 '출발 상태 그대로' 본다(TestDbSupport.disableTutorialStarter javadoc).
        TestDbSupport.disableTutorialStarter(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private TradeService tradeService;

    @Test
    @SuppressWarnings("unchecked")
    void waitSecondsOverrideShortensCountdownForAnyGrade() {
        String token = login("trade_waitcfg");
        String uid = jdbcClient.sql("SELECT id FROM users WHERE nickname=?")
                .param("trade_waitcfg").query(String.class).single();
        SEEDS.add("wait-cfg-seed");
        authGet("/api/trade", token, Map.class);

        ResponseEntity<Map> res = authPost("/api/trade/1/start", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> slot = (Map<String, Object>) res.getBody().get("slot");
        assertThat(slot.get("state")).isEqualTo("WAITING");
        // 시간 단위(최소 1h=3600s)가 아니라 오버라이드 초가 적용돼야 한다
        assertThat(((Number) slot.get("remainingSec")).intValue()).isBetween(0, 7);
        // 등급 공개는 그대로
        assertThat(slot.get("targetGrade")).isEqualTo(jdbcClient.sql("SELECT grade FROM players WHERE id=?")
                .param(tradeService.deriveOffer(uid, "wait-cfg-seed").targetPlayerId())
                .query(String.class).single());
    }
}
