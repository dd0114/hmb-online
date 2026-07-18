package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
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
 * AC-B1~B2 팀 스냅샷 3슬롯: GET(빈 슬롯 포함)/PUT(덱 검증 재사용 + teamTactics 0..1)/apply(→ 활성 덱).
 * 스타터 팩 P001(GK)+P002..P011 선발, P012..P014 벤치.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class TeamPresetApiTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private static Map<String, Object> entry(String playerId, int slotIndex) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("playerId", playerId);
        m.put("slotIndex", slotIndex);
        return m;
    }

    private static Map<String, Object> entry(String playerId, int slotIndex, String prompt) {
        Map<String, Object> m = entry(playerId, slotIndex);
        m.put("promptText", prompt);
        return m;
    }

    private static List<Map<String, Object>> validStarters() {
        List<Map<String, Object>> starters = new ArrayList<>();
        starters.add(entry("P001", 0));
        for (int i = 2; i <= 11; i++) {
            starters.add(entry(String.format("P%03d", i), i - 1));
        }
        return starters;
    }

    private static Map<String, Object> snapshotBody(Map<String, Object> teamTactics) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("name", "메인 스쿼드");
        body.put("formation", "4-4-2");
        body.put("starters", validStarters());
        body.put("bench", List.of(entry("P012", 0), entry("P013", 1)));
        if (teamTactics != null) {
            body.put("teamTactics", teamTactics);
        }
        body.put("teamPrompt", "높은 압박");
        return body;
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
    void emptySlotsReturnedInitially() {
        String token = login("tp_empty");
        ResponseEntity<List> res = authGet("/api/presets/team", token, List.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> slots = res.getBody();
        assertThat(slots).hasSize(3);
        assertThat(slots.stream().map(s -> s.get("slot"))).containsExactly(1, 2, 3);
        assertThat(slots).allSatisfy(s -> assertThat(s.get("snapshot")).isNull());
    }

    @Test
    void saveAndRoundTripWithTactics() {
        String token = login("tp_save");
        ResponseEntity<Map> put = authPut("/api/presets/team/1", token,
                snapshotBody(tactics(0.6, 0.7, 0.5, 0.4)), Map.class);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(put.getBody().get("slot")).isEqualTo(1);
        assertThat(put.getBody().get("name")).isEqualTo("메인 스쿼드");

        ResponseEntity<List> get = authGet("/api/presets/team", token, List.class);
        Map<String, Object> slot1 = (Map<String, Object>) get.getBody().get(0);
        Map<String, Object> snap = (Map<String, Object>) slot1.get("snapshot");
        assertThat(snap).isNotNull();
        assertThat(snap.get("formation")).isEqualTo("4-4-2");
        assertThat((List<?>) snap.get("starters")).hasSize(11);
        assertThat((List<?>) snap.get("bench")).hasSize(2);
        Map<String, Object> savedTactics = (Map<String, Object>) snap.get("teamTactics");
        assertThat(((Number) savedTactics.get("line")).doubleValue()).isEqualTo(0.6);
        assertThat(snap.get("teamPrompt")).isEqualTo("높은 압박");
    }

    @Test
    void saveWithoutTacticsOmitsField() {
        String token = login("tp_notactics");
        authPut("/api/presets/team/2", token, snapshotBody(null), Map.class);
        ResponseEntity<List> get = authGet("/api/presets/team", token, List.class);
        Map<String, Object> slot2 = (Map<String, Object>) get.getBody().get(1);
        Map<String, Object> snap = (Map<String, Object>) slot2.get("snapshot");
        assertThat(snap.get("teamTactics")).isNull();
    }

    @Test
    void tacticsOutOfRangeRejected() {
        String token = login("tp_range");
        ResponseEntity<Map> res = authPut("/api/presets/team/1", token,
                snapshotBody(tactics(0.5, 0.5, 0.5, 1.5)), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void deckValidationReusedForSnapshot() {
        String token = login("tp_deckval");
        // 미보유 선수(P015)를 선발에 넣으면 덱 검증 재사용으로 DECK_INVALID
        Map<String, Object> body = snapshotBody(null);
        List<Map<String, Object>> starters = (List<Map<String, Object>>) body.get("starters");
        starters.set(1, entry("P015", 1)); // P015 미보유
        ResponseEntity<Map> res = authPut("/api/presets/team/1", token, body, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("DECK_INVALID");
        assertThat(((Map<?, ?>) res.getBody().get("detail")).get("rule")).isEqualTo("NOT_OWNED");
    }

    @Test
    void invalidSlotRejected() {
        String token = login("tp_slot");
        assertThat(authPut("/api/presets/team/4", token, snapshotBody(null), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(authPut("/api/presets/team/0", token, snapshotBody(null), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @Test
    void applyReflectsSnapshotToActiveDeck() {
        String token = login("tp_apply");
        authPut("/api/presets/team/3", token, snapshotBody(tactics(0.5, 0.5, 0.5, 0.5)), Map.class);

        ResponseEntity<Map> apply = authPost("/api/presets/team/3/apply", token, null, Map.class);
        assertThat(apply.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(apply.getBody().get("formation")).isEqualTo("4-4-2");

        // 활성 덱이 스냅샷과 일치
        ResponseEntity<Map> deck = authGet("/api/deck", token, Map.class);
        assertThat(deck.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(deck.getBody().get("formation")).isEqualTo("4-4-2");
        assertThat((List<?>) deck.getBody().get("slots")).hasSize(13); // 11 선발 + 2 벤치
    }

    @Test
    void applyEmptySlotIs404() {
        String token = login("tp_apply_empty");
        ResponseEntity<Map> res = authPost("/api/presets/team/2/apply", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody().get("code")).isEqualTo("NOT_FOUND");
    }
}
