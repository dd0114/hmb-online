package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 팀 스냅샷 프리셋(3슬롯) — LLD-p2-server §2, AC-B1~B2.
 *
 * <p>스냅샷 = formation·starters(슬롯 매핑)·bench·선수별 프롬프트·수동 팀 전술(teamTactics). 저장의
 * SoT 는 team_presets(3슬롯). 검증은 <b>덱 검증 재사용</b>(보유·선발 11·GK≥1·중복·프롬프트 길이 —
 * {@link DeckService#validate})에 teamTactics 범위(0..1)를 더한다. apply 는 스냅샷을 현재 편집 상태
 * (decks/deck_slots)로 반영한다(브리핑·덱 편집기의 작업 상태 재사용). teamTactics 는 decks 에 컬럼이
 * 없어 apply 로는 반영되지 않고 — 스냅샷/매치 스냅샷에만 존재하며 AI 컨텍스트로 전달된다(§4).
 */
@Service
public class TeamPresetService {

    private static final List<Integer> SLOTS = List.of(1, 2, 3);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final DeckService deckService;
    private final ObjectMapper objectMapper;

    public TeamPresetService(JdbcClient jdbcClient,
                             TxRunner txRunner,
                             DeckService deckService,
                             ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.deckService = deckService;
        this.objectMapper = objectMapper;
    }

    // ── DTO ──────────────────────────────────────────────────────────────

    /** GET 응답 슬롯 — 빈 슬롯은 name/snapshot/updatedAt=null. snapshot 은 저장된 스냅샷 JSON 그대로. */
    public record PresetSlot(int slot, String name, JsonNode snapshot, String updatedAt) {
    }

    // ── 조회 (3슬롯, 빈 슬롯 포함) ─────────────────────────────────────────

    public List<PresetSlot> listSlots(String userId) {
        Map<Integer, Row> bySlot = new java.util.HashMap<>();
        jdbcClient.sql("SELECT slot_no, name, snapshot_json, updated_at FROM team_presets WHERE user_id = ?")
                .param(userId)
                .query((rs, n) -> new Row(rs.getInt("slot_no"), rs.getString("name"),
                        rs.getString("snapshot_json"), rs.getString("updated_at")))
                .list()
                .forEach(r -> bySlot.put(r.slotNo(), r));

        List<PresetSlot> out = new ArrayList<>(3);
        for (int slot : SLOTS) {
            Row row = bySlot.get(slot);
            if (row == null) {
                out.add(new PresetSlot(slot, null, null, null));
            } else {
                out.add(new PresetSlot(slot, row.name(), readJson(row.snapshotJson()), row.updatedAt()));
            }
        }
        return out;
    }

    // ── 저장 (전체 교체) ──────────────────────────────────────────────────

    /** PUT /api/presets/team/{slot} — 스냅샷 저장(전체 교체). 검증 후 upsert. */
    public PresetSlot save(String userId, int slot, JsonNode body) {
        requireSlot(slot);
        if (body == null || body.isNull() || !body.isObject()) {
            throw presetInvalid("요청 바디가 비어 있습니다", Map.of("rule", "BODY_REQUIRED"));
        }

        String formation = body.path("formation").asText(null);
        if (formation == null || formation.isBlank()) {
            throw presetInvalid("formation이 비어 있습니다", Map.of("rule", "FORMATION_REQUIRED"));
        }

        // 덱 검증 재사용: starters(role=starter) + bench(role=bench) → DeckUpdateRequest
        List<DeckService.SlotDto> slots = new ArrayList<>();
        collectSlots(body.path("starters"), DeckService.ROLE_STARTER, slots);
        collectSlots(body.path("bench"), DeckService.ROLE_BENCH, slots);
        try {
            deckService.validate(userId, new DeckService.DeckUpdateRequest(formation, slots));
        } catch (ApiException e) {
            // DeckService 는 DECK_INVALID 를 던진다 — 스냅샷 문맥에서도 동일 code 로 노출(웹 재사용).
            throw e;
        }

        // teamTactics 범위(0..1) — 있으면 4축 전부 0..1
        TeamTactics.validate(body.get("teamTactics"));

        String name = body.path("name").asText("프리셋");
        String snapshotJson = normalizeSnapshot(formation, body).toString();
        String now = Instant.now().toString();

        txRunner.run(() -> {
            int updated = jdbcClient.sql("""
                            UPDATE team_presets SET name = ?, snapshot_json = ?, updated_at = ?
                            WHERE user_id = ? AND slot_no = ?
                            """)
                    .params(name, snapshotJson, now, userId, slot)
                    .update();
            if (updated == 0) {
                jdbcClient.sql("""
                                INSERT INTO team_presets(id, user_id, slot_no, name, snapshot_json, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                """)
                        .params(Ulid.next(), userId, slot, name, snapshotJson, now)
                        .update();
            }
        });

        return new PresetSlot(slot, name, readJson(snapshotJson), now);
    }

    // ── 적용 (스냅샷 → 현재 편집 상태 deck/deck_slots) ─────────────────────

    /** POST /api/presets/team/{slot}/apply — 스냅샷을 활성 덱으로 반영(덱 저장 재검증 포함). */
    public DeckService.DeckResponse apply(String userId, int slot) {
        requireSlot(slot);
        Optional<String> snapshotJson = jdbcClient.sql(
                        "SELECT snapshot_json FROM team_presets WHERE user_id = ? AND slot_no = ?")
                .params(userId, slot)
                .query(String.class)
                .optional();
        if (snapshotJson.isEmpty()) {
            throw ApiException.notFound("비어 있는 프리셋 슬롯입니다: " + slot);
        }

        JsonNode snapshot = readJson(snapshotJson.get());
        String formation = snapshot.path("formation").asText();
        List<DeckService.SlotDto> slots = new ArrayList<>();
        collectSlots(snapshot.path("starters"), DeckService.ROLE_STARTER, slots);
        collectSlots(snapshot.path("bench"), DeckService.ROLE_BENCH, slots);

        // deckService.replaceDeck 이 검증(보유·11명·GK≥1 등) + 저장을 재수행 — 스냅샷 저장 이후
        // 보유 풀이 바뀌었으면(선수 이탈 등) 여기서 DECK_INVALID 로 걸린다(의도된 안전장치).
        return deckService.replaceDeck(userId, new DeckService.DeckUpdateRequest(formation, slots));
    }

    // ── 내부 헬퍼 ────────────────────────────────────────────────────────

    private void requireSlot(int slot) {
        if (!SLOTS.contains(slot)) {
            throw ApiException.validation("slot은 1|2|3만 허용됩니다: " + slot);
        }
    }

    /** starters/bench 배열의 각 항목 → SlotDto(role 고정). slotIndex 누락은 null 로 두어 덱 검증이 잡게 함. */
    private void collectSlots(JsonNode array, String role, List<DeckService.SlotDto> out) {
        if (array == null || !array.isArray()) {
            return;
        }
        for (JsonNode entry : array) {
            String playerId = entry.path("playerId").asText(null);
            Integer slotIndex = entry.hasNonNull("slotIndex") ? entry.get("slotIndex").asInt() : null;
            String promptText = entry.hasNonNull("promptText") ? entry.get("promptText").asText() : null;
            out.add(new DeckService.SlotDto(playerId, role, slotIndex, promptText));
        }
    }

    /**
     * 저장용 정규화 스냅샷: {formation, starters, bench, teamTactics?, teamPrompt?}. name 은 컬럼으로
     * 분리하고 스냅샷 JSON 에는 넣지 않는다. starters/bench 항목은 {playerId, slotIndex, promptText?}.
     */
    private ObjectNode normalizeSnapshot(String formation, JsonNode body) {
        ObjectNode snap = objectMapper.createObjectNode();
        snap.put("formation", formation);
        snap.set("starters", normalizeEntries(body.path("starters")));
        snap.set("bench", normalizeEntries(body.path("bench")));
        JsonNode teamTactics = body.get("teamTactics");
        if (teamTactics != null && teamTactics.isObject()) {
            snap.set("teamTactics", teamTactics);
        }
        JsonNode teamPrompt = body.get("teamPrompt");
        if (teamPrompt != null && teamPrompt.isTextual()) {
            snap.set("teamPrompt", teamPrompt);
        }
        return snap;
    }

    private ArrayNode normalizeEntries(JsonNode array) {
        ArrayNode out = objectMapper.createArrayNode();
        if (array == null || !array.isArray()) {
            return out;
        }
        for (JsonNode entry : array) {
            ObjectNode e = objectMapper.createObjectNode();
            e.put("playerId", entry.path("playerId").asText());
            e.put("slotIndex", entry.path("slotIndex").asInt());
            if (entry.hasNonNull("promptText")) {
                e.put("promptText", entry.get("promptText").asText());
            }
            out.add(e);
        }
        return out;
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("snapshot_json 파싱 실패: " + e.getMessage(), e);
        }
    }

    private static ApiException presetInvalid(String message, Map<String, Object> detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "DECK_INVALID", message, detail);
    }

    private record Row(int slotNo, String name, String snapshotJson, String updatedAt) {
    }
}
