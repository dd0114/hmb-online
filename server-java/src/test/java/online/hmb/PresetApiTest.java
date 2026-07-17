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

/** 프리셋 CRUD 왕복 + AC-S4(프리셋 삭제해도 덱에 복사된 프롬프트 본문 유지). */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class PresetApiTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Test
    void crudRoundTrip() {
        String token = login("preset_crud");

        ResponseEntity<Map> created = authPost("/api/presets", token,
                Map.of("name", "수비 지침", "promptText", "라인 내리고 클리어 우선"), Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String presetId = (String) created.getBody().get("id");
        assertThat(presetId).isNotBlank();
        assertThat(created.getBody().get("promptText")).isEqualTo("라인 내리고 클리어 우선");

        ResponseEntity<List> list = authGet("/api/presets", token, List.class);
        assertThat(list.getBody()).hasSize(1);
        assertThat(((Map<?, ?>) list.getBody().get(0)).get("name")).isEqualTo("수비 지침");

        ResponseEntity<Void> deleted = authDelete("/api/presets/" + presetId, token, Void.class);
        assertThat(deleted.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);

        assertThat(authGet("/api/presets", token, List.class).getBody()).isEmpty();

        ResponseEntity<Map> deleteAgain = authDelete("/api/presets/" + presetId, token, Map.class);
        assertThat(deleteAgain.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    @Test
    void duplicateNameRejected() {
        String token = login("preset_dup");
        authPost("/api/presets", token, Map.of("name", "A", "promptText", "x"), Map.class);
        ResponseEntity<Map> second = authPost("/api/presets", token,
                Map.of("name", "A", "promptText", "y"), Map.class);
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(second.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }

    @Test
    void blankFieldsRejected() {
        String token = login("preset_blank");
        assertThat(authPost("/api/presets", token, Map.of("name", " ", "promptText", "x"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(authPost("/api/presets", token, Map.of("name", "B", "promptText", ""), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    /**
     * AC-S4: 프리셋 본문을 덱 슬롯에 복사 저장 → 프리셋 삭제 → 덱의 본문은 그대로.
     * (복사 저장 구조라 자동으로 성립하지만, 회귀 방지를 위해 계약으로 박제)
     */
    @Test
    void deletingPresetKeepsCopiedDeckPrompt() {
        String token = login("preset_ac_s4");

        ResponseEntity<Map> created = authPost("/api/presets", token,
                Map.of("name", "침투 지침", "promptText", "뒷공간 침투 최우선"), Map.class);
        String presetId = (String) created.getBody().get("id");
        String promptText = (String) created.getBody().get("promptText");

        // 웹이 하듯 프리셋 본문을 복사해 덱에 저장 (선발 11 = P001..P011)
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1,
                    i == 5 ? promptText : "기본"));
        }
        ResponseEntity<Map> put = authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);

        // 프리셋 삭제
        assertThat(authDelete("/api/presets/" + presetId, token, Void.class).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        // 덱의 복사된 본문은 유지
        ResponseEntity<Map> deck = authGet("/api/deck", token, Map.class);
        List<Map<String, Object>> savedSlots = (List<Map<String, Object>>) deck.getBody().get("slots");
        Map<String, Object> p005 = savedSlots.stream()
                .filter(s -> "P005".equals(s.get("playerId"))).findFirst().orElseThrow();
        assertThat(p005.get("promptText")).isEqualTo("뒷공간 침투 최우선");
    }
}
