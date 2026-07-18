package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * W0 이월 a (AC-B2): 킥오프 시점에 현재 덱 + 요청 teamTactics 로 매치 스냅샷을 재캡처한다.
 * create 이후 브리핑에서 덱을 수정하면 킥오프 시 그 수정이 매치 스냅샷(=AI 컨텍스트 근거)에 반영돼야
 * 한다. create 시점 캡처는 폴백. teamTactics 미지정 시 기존 스냅샷 전술 유지.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class KickoffRecaptureTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode snapshot(String matchId) {
        String json = jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private Set<String> benchIds(JsonNode snap) {
        Set<String> ids = new HashSet<>();
        snap.path("bench").forEach(b -> ids.add(b.path("playerId").asText()));
        return ids;
    }

    @Test
    void kickoffRecapturesEditedDeckIntoMatchSnapshot() {
        String token = setupUserWithDeck("recap_edit");
        String matchId = createMatch(token, "BOT_BAL");

        // create 시점 스냅샷: 벤치 = P012, P013
        assertThat(benchIds(snapshot(matchId))).containsExactlyInAnyOrder("P012", "P013");

        // 브리핑 중 덱 수정: 벤치 P013 → P014 로 교체
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P014", "bench", 1));
        assertThat(authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // 킥오프 → 재캡처. 매치 스냅샷 벤치가 편집 반영(P014) 돼야 함
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        JsonNode after = snapshot(matchId);
        assertThat(benchIds(after)).containsExactlyInAnyOrder("P012", "P014");
        // conditions 도 새 로스터로 재롤 — P014 포함, P013 제외
        JsonNode conditions = readConditions(matchId);
        assertThat(conditions.has("P014")).isTrue();
        assertThat(conditions.has("P013")).isFalse();
    }

    @Test
    void kickoffTeamTacticsOverridesAndFallsBackToCreateCapture() {
        String token = setupUserWithDeck("recap_tac");
        // create 시 전술 미지정
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(snapshot(matchId).has("teamTactics")).isFalse();

        // 킥오프에서 teamTactics 지정 → 스냅샷에 반영
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token,
                Map.of("teamTactics", Map.of("line", 0.8, "press", 0.7, "tempo", 0.6, "width", 0.5)),
                Map.class).getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        JsonNode snap = snapshot(matchId);
        assertThat(snap.path("teamTactics").path("line").asDouble()).isEqualTo(0.8);
    }

    private JsonNode readConditions(String matchId) {
        String json = jdbcClient.sql("SELECT conditions_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        try {
            return mapper.readTree(json);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
