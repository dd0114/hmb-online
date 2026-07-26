package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * GET /api/conditions/today (이슈 #98 계약 A) — 로그인 유저의 **보유 선수** 당일 컨디션 맵
 * {playerId: 0.0~1.0}. 날짜시드 롤이라 같은 날 재호출은 동일하고, 매치 생성 시
 * matches.conditions_json 에 같은 값이 스냅샷된다(엔진 재현 계약 불변 — 저장은 그대로).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class ConditionsTodayApiTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private final com.fasterxml.jackson.databind.ObjectMapper mapper =
            new com.fasterxml.jackson.databind.ObjectMapper();

    private JsonNode readMatchJson(String matchId, String column) {
        String json = jdbcClient.sql("SELECT " + column + " FROM matches WHERE id = ?")
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
    void requiresAuth() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/conditions/today"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    @Test
    void returnsOwnedPlayersOnlyWithValuesInRange() {
        String token = login("cond_owned");
        String userId = userIdOf("cond_owned");

        List<String> owned = jdbcClient
                .sql("SELECT player_id FROM user_players WHERE user_id = ? ORDER BY player_id")
                .param(userId).query(String.class).list();
        assertThat(owned).isNotEmpty();

        Map<String, Object> map = today(token);
        assertThat(map.keySet()).containsExactlyInAnyOrderElementsOf(owned);
        // 미보유 선수는 포함되지 않는다(카탈로그 전체가 아님)
        long catalogSize = jdbcClient.sql("SELECT COUNT(*) FROM players").query(Long.class).single();
        assertThat(map.size()).isLessThan((int) catalogSize);
        map.values().forEach(v -> assertThat(((Number) v).doubleValue()).isBetween(0.0, 1.0));
    }

    @Test
    void isStableWithinTheSameDayAndDiffersPerUser() {
        String a = login("cond_stable_a");
        String b = login("cond_stable_b");

        Map<String, Object> first = today(a);
        assertThat(today(a)).isEqualTo(first); // 같은 날 재호출 = 동일(하루 고정)

        Map<String, Object> other = today(b);
        // #209 이후 두 계정의 보유는 **기본팩(공통) + 최상위 1장(계정마다 다를 수 있음)** 이다.
        // 그래서 키셋 동일이 아니라 "기본팩은 양쪽 다 있고, 장수는 같다"로 본다.
        assertThat(other.keySet()).hasSameSizeAs(first.keySet());
        Set<String> basics = first.keySet().stream().filter(id -> id.compareTo("P015") < 0)
                .collect(java.util.stream.Collectors.toSet());
        assertThat(basics).hasSize(14);
        assertThat(other.keySet()).containsAll(basics);
        // userId 가 시드에 들어가므로 같은 선수라도 값이 다르다(그게 이 테스트의 본론).
        assertThat(basics.stream().anyMatch(id -> !other.get(id).equals(first.get(id)))).isTrue();
    }

    /** 매치 생성/킥오프 재캡처가 '당일' 값을 그대로 conditions_json 에 저장(재현 계약 불변). */
    @Test
    void matchConditionsJsonSnapshotsTodayValues() {
        String token = setupUserWithDeck("cond_match");
        Map<String, Object> map = today(token);

        String matchId = createMatch(token, "BOT_BAL");
        JsonNode stored = readMatchJson(matchId, "conditions_json");
        assertThat(stored.size()).isEqualTo(13); // 선발 11 + 벤치 2
        stored.properties().forEach(e -> assertThat(e.getValue().asDouble())
                .as("conditions_json " + e.getKey())
                .isEqualTo(((Number) map.get(e.getKey())).doubleValue()));

        // 킥오프 재캡처 후에도 동일(매치 시드와 무관 — 날짜시드)
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        JsonNode after = readMatchJson(matchId, "conditions_json");
        after.properties().forEach(e -> assertThat(e.getValue().asDouble())
                .isEqualTo(((Number) map.get(e.getKey())).doubleValue()));
    }
}
