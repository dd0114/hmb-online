package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import org.springframework.stereotype.Component;

/**
 * 덱 → 스냅샷 JSON 직렬화 <b>한 곳</b>.
 *
 * <p>매치 스냅샷(`matches.user_deck_json`)과 덱 저장 선실행(#215 W2)이 <b>같은 바이트</b>를 만들어야
 * A(베이스) 캐시 키가 일치한다 — 두 곳이 각자 만들면 한 글자 차이로 캐시가 통째로 죽는다(라이브에서
 * 실제로 겪은 실패 유형: 전술 필드 유무 하나로 100% 미스, #215 W1 addendum). 그래서 직렬화를
 * 여기로 모으고 MatchService·DeckPrewarmService 가 <b>이것만</b> 쓴다.
 */
@Component
public class DeckSnapshot {

    private final ObjectMapper objectMapper;

    public DeckSnapshot(ObjectMapper objectMapper) {
        this.objectMapper = objectMapper;
    }

    /**
     * @param teamTactics P2-D4 수동 팀 전술 — 있을 때만 스냅샷에 포함한다(AI 컨텍스트로 전달, §4).
     *     A(베이스)는 전술을 모르므로 선실행 경로는 {@code null} 로 부른다.
     */
    public String json(DeckService.DeckResponse deck, JsonNode teamTactics) {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("formation", deck.formation());
        // 덱 팀 지시(#253) — 없으면 <b>필드를 생략</b>한다. 그래야 팀 문장이 없는 기존 덱의 스냅샷
        // 바이트가 이 필드 도입 전과 동일하고, 그 위에서 파생되는 A(베이스) 캐시 키도 그대로다
        // (라이브에 쌓인 캐시가 배포만으로 통째 죽지 않는다). "" 를 넣으면 그게 깨진다.
        if (deck.teamPrompt() != null && !deck.teamPrompt().isBlank()) {
            snapshot.put("teamPrompt", deck.teamPrompt());
        }
        ArrayNode starters = snapshot.putArray("starters");
        ArrayNode bench = snapshot.putArray("bench");
        for (DeckService.SlotDto slot : deck.slots()) {
            ObjectNode entry = objectMapper.createObjectNode();
            entry.put("playerId", slot.playerId());
            entry.put("slotIndex", slot.slotIndex());
            if (slot.promptText() != null) {
                entry.put("promptText", slot.promptText());
            }
            (DeckService.ROLE_STARTER.equals(slot.role()) ? starters : bench).add(entry);
        }
        if (teamTactics != null && teamTactics.isObject()) {
            snapshot.set("teamTactics", teamTactics);
        }
        return snapshot.toString();
    }
}
