package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
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
 * AC-S2 덱 검증 매트릭스 + 저장/재조회 왕복. bench-max를 2로 오버라이드해
 * BENCH_MAX 규칙이 config에서 온다는 것(AC-S5)도 함께 검증한다.
 * 스타터 팩(P001..P014) 보유 전제 — P001=GK, P002..P006=DF, P007..P011=MF, P012..P014=FW,
 * P015/P016=미보유.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class DeckApiTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.deck.bench-max", () -> "2");
    }

    /** P001(GK) + P002..P011 = 유효 선발 11. */
    private static List<Map<String, Object>> validStarters() {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        return slots;
    }

    private ResponseEntity<Map> putDeck(String token, String formation, List<Map<String, Object>> slots) {
        return authPut("/api/deck", token, deckBody(formation, slots), Map.class);
    }

    private static void assertDeckInvalid(ResponseEntity<Map> response, String rule) {
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("DECK_INVALID");
        Map<?, ?> detail = (Map<?, ?>) response.getBody().get("detail");
        assertThat(detail).isNotNull();
        assertThat(detail.get("rule")).isEqualTo(rule);
    }

    @Test
    void validDeckSavesAndRoundTrips() {
        String token = login("deck_ok");
        List<Map<String, Object>> slots = validStarters();
        slots.set(1, slot("P002", "starter", 1, "라인 유지, 안전한 패스"));
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1));

        ResponseEntity<Map> put = putDeck(token, "4-4-2", slots);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(put.getBody().get("formation")).isEqualTo("4-4-2");
        assertThat((List<?>) put.getBody().get("slots")).hasSize(13);

        ResponseEntity<Map> get = authGet("/api/deck", token, Map.class);
        assertThat(get.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(get.getBody().get("id")).isEqualTo(put.getBody().get("id"));
        assertThat(get.getBody().get("formation")).isEqualTo("4-4-2");
        assertThat(get.getBody().get("slots")).isEqualTo(put.getBody().get("slots"));

        // prompt_text 저장 확인
        List<Map<String, Object>> saved = (List<Map<String, Object>>) get.getBody().get("slots");
        Map<String, Object> p002 = saved.stream()
                .filter(s -> "P002".equals(s.get("playerId"))).findFirst().orElseThrow();
        assertThat(p002.get("promptText")).isEqualTo("라인 유지, 안전한 패스");
    }

    @Test
    void replaceOverwritesPreviousDeck() {
        String token = login("deck_replace");
        ResponseEntity<Map> first = putDeck(token, "4-4-2", validStarters());
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);

        List<Map<String, Object>> newSlots = validStarters();
        newSlots.add(slot("P014", "bench", 0));
        ResponseEntity<Map> second = putDeck(token, "4-3-3", newSlots);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(second.getBody().get("id")).isEqualTo(first.getBody().get("id")); // 활성 덱 1개 유지

        ResponseEntity<Map> get = authGet("/api/deck", token, Map.class);
        assertThat(get.getBody().get("formation")).isEqualTo("4-3-3");
        assertThat((List<?>) get.getBody().get("slots")).hasSize(12);
    }

    @Test
    void getWithoutDeckIs404() {
        String token = login("deck_none");
        ResponseEntity<Map> response = authGet("/api/deck", token, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(response.getBody().get("code")).isEqualTo("NOT_FOUND");
    }

    @Test
    void notOwnedPlayerRejected() {
        String token = login("deck_notowned");
        List<Map<String, Object>> slots = validStarters();
        slots.set(0, slot("P015", "starter", 0)); // P015 = GK지만 미보유
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "NOT_OWNED");
    }

    @Test
    void unknownPlayerRejected() {
        String token = login("deck_unknown");
        List<Map<String, Object>> slots = validStarters();
        slots.set(10, slot("P999", "starter", 10));
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "UNKNOWN_PLAYER");
    }

    @Test
    void starterCountMustBeEleven() {
        String token = login("deck_ten");
        List<Map<String, Object>> slots = validStarters();
        slots.remove(10);
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "STARTER_COUNT");
    }

    @Test
    void gkRequiredAmongStarters() {
        String token = login("deck_nogk");
        // P002..P012 = DF/MF/FW 11명, GK 없음
        List<Map<String, Object>> slots = new ArrayList<>();
        for (int i = 2; i <= 12; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 2));
        }
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "GK_REQUIRED");
    }

    @Test
    void benchOverConfigMaxRejected() {
        String token = login("deck_bench");
        List<Map<String, Object>> slots = validStarters();
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1));
        slots.add(slot("P014", "bench", 2)); // bench-max=2 오버라이드 → 3명은 위반
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "BENCH_MAX");
    }

    @Test
    void duplicatePlayerRejected() {
        String token = login("deck_dup");
        List<Map<String, Object>> slots = validStarters();
        slots.add(slot("P002", "bench", 0)); // P002는 이미 선발
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "DUPLICATE_PLAYER");
    }

    @Test
    void promptTooLongRejected() {
        String token = login("deck_prompt");
        List<Map<String, Object>> slots = validStarters();
        slots.set(1, slot("P002", "starter", 1, "가".repeat(501))); // max 500
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "PROMPT_TOO_LONG");
    }

    @Test
    void blankFormationRejected() {
        String token = login("deck_form");
        ResponseEntity<Map> response = putDeck(token, "  ", validStarters());
        assertDeckInvalid(response, "FORMATION_REQUIRED");
    }

    // ── W1 검증 이월(a): 나머지 규칙 회귀 박제 ──────────────────────────

    @Test
    void invalidRoleRejected() {
        String token = login("deck_role");
        List<Map<String, Object>> slots = validStarters();
        slots.add(slot("P012", "sub", 0)); // starter|bench 외
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "ROLE_INVALID");
    }

    @Test
    void starterSlotIndexOutOfRangeRejected() {
        String token = login("deck_range");
        List<Map<String, Object>> slots = validStarters();
        slots.set(10, slot("P011", "starter", 11)); // starter는 0..10
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "SLOT_INDEX_RANGE");
    }

    @Test
    void duplicateSlotIndexRejected() {
        String token = login("deck_dupidx");
        List<Map<String, Object>> slots = validStarters();
        slots.set(10, slot("P011", "starter", 0)); // slot0은 P001이 이미 사용
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "SLOT_INDEX_DUPLICATE");
    }

    @Test
    void missingPlayerIdRejected() {
        String token = login("deck_nopid");
        List<Map<String, Object>> slots = validStarters();
        Map<String, Object> noPlayer = new java.util.HashMap<>();
        noPlayer.put("role", "bench");
        noPlayer.put("slotIndex", 0); // playerId 없음
        slots.add(noPlayer);
        assertDeckInvalid(putDeck(token, "4-4-2", slots), "PLAYER_ID_REQUIRED");
    }
}
