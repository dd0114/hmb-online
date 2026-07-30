package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.match.BaseContextKey;
import online.hmb.match.BaseContextKey.RosterKey;
import org.junit.jupiter.api.Test;

/**
 * A(베이스) 캐시 키 재료 <b>바이트 동일 재현</b> 대조 (#95).
 *
 * <p>골든 = TS {@code packages/shared/src/tactical-patch.ts} 의 {@code baseContextKeyMaterial} 산출물
 * (scratchpad/genfix.mts 로 캡처). Java {@link BaseContextKey#material} 가 이 문자열과 바이트 동일이어야
 * 크로스매치·양팀 캐시 키가 TS 계약과 맞물린다(불일치=캐시 미스 → 목적 상실). 정렬(상위/중첩 키 알파벳,
 * roster slotIndex 오름차순), number 표기(정수·0..1 소수), 한글 UTF-8 무이스케이프, 컴팩트 직렬화를 검증.
 */
class BaseContextKeyReproTest {

    // scratchpad/genfix.mts 출력(고정). 아래 Java 입력과 동일 재료.
    private static final String GOLDEN =
            "{\"formation\":\"4-3-3\",\"manualTactics\":{\"line\":0.7,\"press\":0.5,\"tempo\":0.9,\"width\":0.4},"
            + "\"playerPrompts\":{\"p1\":\"\",\"p2\":\"왼쪽 측면 공략\"},"
            + "\"roster\":[{\"attributes\":{\"pace\":90,\"shooting\":60},\"playerId\":\"p1\",\"slotIndex\":0},"
            + "{\"attributes\":{\"defending\":55,\"pace\":65},\"playerId\":\"p2\",\"slotIndex\":1},"
            + "{\"attributes\":{\"pace\":70,\"shooting\":80,\"zeta\":10},\"playerId\":\"p3\",\"slotIndex\":2}],"
            + "\"teamPrompt\":\"공격적으로 압박\",\"v\":2}";

    private static Map<String, Object> attrs(Object... kv) {
        Map<String, Object> m = new LinkedHashMap<>();
        for (int i = 0; i < kv.length; i += 2) {
            m.put((String) kv[i], kv[i + 1]);
        }
        return m;
    }

    @Test
    void reproducesTsMaterialByteForByte() {
        // 일부러 slotIndex 역순 + attributes 키 역순으로 넣어 Java 정규화가 TS 와 같아지는지 확인.
        List<RosterKey> roster = List.of(
                new RosterKey("p3", 2, attrs("zeta", 10, "shooting", 80, "pace", 70)),
                new RosterKey("p1", 0, attrs("shooting", 60, "pace", 90)),
                new RosterKey("p2", 1, attrs("pace", 65, "defending", 55)));
        Map<String, String> playerPrompts = new LinkedHashMap<>();
        playerPrompts.put("p2", "왼쪽 측면 공략");
        playerPrompts.put("p1", "");
        Map<String, Object> manualTactics = attrs("width", 0.4, "line", 0.7, "tempo", 0.9, "press", 0.5);

        String material = BaseContextKey.material("4-3-3", roster, "공격적으로 압박", playerPrompts, manualTactics);

        assertThat(material).isEqualTo(GOLDEN);
        // 키(캐시 id)는 material 의 sha256[:32].
        assertThat(BaseContextKey.baseId(material)).hasSize(32).matches("[0-9a-f]{32}");
    }

    @Test
    void manualTacticsNullSerializesAsNull() {
        String material = BaseContextKey.material("4-4-2", List.of(), "", Map.of(), null);
        assertThat(material).contains("\"manualTactics\":null");
    }
}
