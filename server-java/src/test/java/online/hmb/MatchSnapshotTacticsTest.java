package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * LLD-p2-server §2: 매치 스냅샷(user_deck_json)에 teamTactics 포함 확장. create 시 teamTactics 를
 * 넘기면 스냅샷에 저장돼 AI 컨텍스트로 전달될 수 있어야 한다(§4). 생략 시 미포함(additive).
 * 범위 밖(0..1) teamTactics 는 create 자체가 400.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MatchSnapshotTacticsTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode userDeckJson(String matchId) {
        String json = jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private static Map<String, Object> tactics(double line, double press, double tempo, double width) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("line", line);
        t.put("press", press);
        t.put("tempo", tempo);
        t.put("width", width);
        return t;
    }

    @Test
    void teamTacticsIncludedInMatchSnapshot() {
        String token = setupUserWithDeck("mt_tactics");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("botId", "BOT_BAL");
        body.put("teamTactics", tactics(0.7, 0.6, 0.55, 0.45));

        ResponseEntity<Map> res = authPost("/api/matches", token, body, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) res.getBody().get("id");

        JsonNode snap = userDeckJson(matchId);
        assertThat(snap.has("teamTactics")).isTrue();
        assertThat(snap.path("teamTactics").path("line").asDouble()).isEqualTo(0.7);
        assertThat(snap.path("teamTactics").path("width").asDouble()).isEqualTo(0.45);
        // 기존 스냅샷 구조 유지
        assertThat(snap.path("starters").size()).isEqualTo(11);
    }

    @Test
    void snapshotOmitsTacticsWhenAbsent() {
        String token = setupUserWithDeck("mt_notactics");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(userDeckJson(matchId).has("teamTactics")).isFalse();
    }

    @Test
    void outOfRangeTacticsRejectedAtCreate() {
        String token = setupUserWithDeck("mt_badtactics");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("botId", "BOT_BAL");
        body.put("teamTactics", tactics(0.5, 0.5, 0.5, 2.0));
        ResponseEntity<Map> res = authPost("/api/matches", token, body, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }
}
