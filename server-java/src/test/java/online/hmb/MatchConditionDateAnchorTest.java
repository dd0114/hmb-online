package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 컨디션 날짜 <b>앵커</b> 검증(#98 W3 검증 이월 픽스 1) — 매치의 컨디션 시드 날짜는 '오늘'이 아니라
 * <b>matches.created_at(KST)</b> 이다. 브리핑 중 KST 자정을 넘겨 킥오프해도 재캡처가 create 시점과
 * 같은 날짜 시드를 써야 한다(유저가 브리핑에서 본 값 = AI 컨텍스트 값 = 실제 경기 값).
 *
 * <p>반면 덱 리스트용 {@code GET /api/conditions/today} 는 계속 '오늘'이어야 한다 — 자정 통과 후
 * 값이 바뀌는 것으로 시계가 실제로 움직였음을 함께 증명한다(앵커 단언이 tautology 가 아님).
 *
 * <p>시각은 가변 고정 Clock 빈(@Primary)으로 제어한다(TradeSeedSource 고정 시드와 같은 패턴).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MatchConditionDateAnchorTest extends MatchTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    /** KST 2026-07-19 23:59 — 자정 1분 전. */
    private static final Instant BEFORE_MIDNIGHT = Instant.parse("2026-07-19T14:59:00Z");
    /** KST 2026-07-20 00:30 — 자정 통과 후. */
    private static final Instant AFTER_MIDNIGHT = Instant.parse("2026-07-19T15:30:00Z");

    static final AtomicReference<Instant> NOW = new AtomicReference<>(BEFORE_MIDNIGHT);

    @TestConfiguration
    static class MutableClockConfig {
        @Bean
        @Primary
        Clock testClock() {
            return new Clock() {
                @Override
                public ZoneId getZone() {
                    return KST;
                }

                @Override
                public Clock withZone(ZoneId zone) {
                    return this;
                }

                @Override
                public Instant instant() {
                    return NOW.get();
                }
            };
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode conditionsOf(String matchId) {
        String json = jdbcClient.sql("SELECT conditions_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> today(String token) {
        ResponseEntity<Map> res = authGet("/api/conditions/today", token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    @Test
    void kickoffAfterKstMidnightKeepsCreateTimeConditions() {
        NOW.set(BEFORE_MIDNIGHT);
        String token = setupUserWithDeck("anchor_user");

        String matchId = createMatch(token, "BOT_BAL");
        JsonNode before = conditionsOf(matchId);
        assertThat(before.size()).isEqualTo(13);
        // created_at 이 고정 Clock 시각으로 기록됐는지(앵커 소스) — KST 19일.
        String createdAt = jdbcClient.sql("SELECT created_at FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(Instant.parse(createdAt)).isEqualTo(BEFORE_MIDNIGHT);

        // 브리핑 중 KST 자정 통과
        Map<String, Object> todayOn19 = today(token);
        NOW.set(AFTER_MIDNIGHT);
        Map<String, Object> todayOn20 = today(token);
        // 시계가 실제로 움직였다 — '오늘' 조회는 갱신된다(앵커 단언이 tautology 가 아님을 보장).
        assertThat(todayOn20).isNotEqualTo(todayOn19);
        assertThat(todayOn20.keySet()).isEqualTo(todayOn19.keySet());

        // 킥오프 → 재캡처. 컨디션은 create 시점(19일) 값 그대로여야 한다.
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        JsonNode after = conditionsOf(matchId);
        assertThat(after).isEqualTo(before);
        // 그리고 그 값은 (자정 넘은) '오늘' 값과는 다르다 — 앵커가 실제로 작동.
        after.properties().forEach(e -> assertThat(e.getValue().asDouble())
                .as("anchored " + e.getKey())
                .isNotEqualTo(((Number) todayOn20.get(e.getKey())).doubleValue()));
        // create 당일('오늘'이던 19일) 값과는 일치.
        after.properties().forEach(e -> assertThat(e.getValue().asDouble())
                .isEqualTo(((Number) todayOn19.get(e.getKey())).doubleValue()));
    }
}
