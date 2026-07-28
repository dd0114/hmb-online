package online.hmb.meta;

import java.time.Instant;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 덱 조회/전체교체 (LLD §4, AC-S2). PUT은 부분수정 없음 — 항상 전체 교체.
 * 검증 위반은 400 DECK_INVALID + detail(rule + 문제 슬롯/선수 식별).
 * 튜닝값(bench-max, player-prompt-max-chars)은 application.yml에서만(AC-S5).
 */
@Service
public class DeckService {

    public static final String ROLE_STARTER = "starter";
    public static final String ROLE_BENCH = "bench";
    private static final int STARTER_COUNT = 11;
    /** bench slot_index 스키마 범위 0..6 (ERD deck_slots 주석·openapi DeckSlot) — 튜닝값 아님.
     *  벤치 "인원 수" 상한은 별도로 hmb.deck.bench-max(config)가 결정한다. */
    private static final int BENCH_INDEX_SPACE = 7;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final int benchMax;
    private final int promptMaxChars;
    private final int teamPromptMaxChars;

    public DeckService(JdbcClient jdbcClient,
                       TxRunner txRunner,
                       @Value("${hmb.deck.bench-max}") int benchMax,
                       @Value("${hmb.deck.player-prompt-max-chars}") int promptMaxChars,
                       @Value("${hmb.deck.team-prompt-max-chars}") int teamPromptMaxChars) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.benchMax = benchMax;
        this.promptMaxChars = promptMaxChars;
        this.teamPromptMaxChars = teamPromptMaxChars;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /**
     * 활성 덱의 팀 문장(#253) — 덱이 없으면 {@code null}. 프리셋 적용처럼 "이 값을 유지할지"만
     * 알면 되는 호출측이 덱 부재를 404 로 맞지 않게 하는 조회다.
     */
    public String activeTeamPromptOrNull(String userId) {
        return findActiveDeck(userId).map(DeckRow::teamPrompt).orElse(null);
    }

    public DeckResponse getActiveDeck(String userId) {
        DeckRow deck = findActiveDeck(userId)
                .orElseThrow(() -> ApiException.notFound("활성 덱이 없습니다"));
        return toResponse(deck);
    }

    // ── 전체 교체 ────────────────────────────────────────────────────────

    public DeckResponse replaceDeck(String userId, DeckUpdateRequest request) {
        validate(userId, request);

        return txRunner.run(() -> {
            String now = Instant.now().toString();
            String deckId = findActiveDeck(userId)
                    .map(DeckRow::id)
                    .orElse(null);

            // 팀 문장(#253): 빈 문자열은 "지웠다"이므로 null 로 정규화해 저장한다 — 그래야
            // DeckSnapshot 이 필드를 생략하고, 팀 문장을 지운 덱의 A 캐시 키가 원래(문장 없음)로
            // 정확히 되돌아간다("" 로 남기면 지우기 전과 다른 키가 되어 캐시가 한 번 더 죽는다).
            String teamPrompt = blankToNull(request.teamPrompt());

            if (deckId == null) {
                deckId = Ulid.next();
                jdbcClient.sql("""
                                INSERT INTO decks(id, user_id, formation, team_prompt, is_active, updated_at)
                                VALUES (?, ?, ?, ?, 1, ?)
                                """)
                        .params(deckId, userId, request.formation(), teamPrompt, now)
                        .update();
            } else {
                jdbcClient.sql("UPDATE decks SET formation = ?, team_prompt = ?, updated_at = ? WHERE id = ?")
                        .params(request.formation(), teamPrompt, now, deckId)
                        .update();
                jdbcClient.sql("DELETE FROM deck_slots WHERE deck_id = ?")
                        .param(deckId)
                        .update();
            }

            for (SlotDto slot : request.slots()) {
                jdbcClient.sql("""
                                INSERT INTO deck_slots(deck_id, player_id, role, slot_index, prompt_text)
                                VALUES (?, ?, ?, ?, ?)
                                """)
                        .params(deckId, slot.playerId(), slot.role(), slot.slotIndex(), slot.promptText())
                        .update();
            }

            return toResponse(findActiveDeck(userId).orElseThrow());
        });
    }

    // ── 검증 ────────────────────────────────────────────────────────────

    /** AC-S2 검증 매트릭스 — PUT /api/deck 및 매치 생성 시 활성 덱 재검증(LLD §5.1)에 공용. */
    public void validate(String userId, DeckUpdateRequest request) {
        if (request == null || request.slots() == null) {
            throw deckInvalid("요청 바디가 비어 있습니다", Map.of("rule", "BODY_REQUIRED"));
        }
        if (request.formation() == null || request.formation().isBlank()) {
            throw deckInvalid("formation이 비어 있습니다", Map.of("rule", "FORMATION_REQUIRED"));
        }
        // 팀 문장(#253) — 선수 문장과 같은 자리에서 같은 규칙으로 검증한다. 상한은 config.
        if (request.teamPrompt() != null && request.teamPrompt().length() > teamPromptMaxChars) {
            throw deckInvalid("팀 프롬프트가 최대 길이(" + teamPromptMaxChars + "자)를 초과했습니다",
                    Map.of("rule", "TEAM_PROMPT_TOO_LONG",
                            "length", request.teamPrompt().length(), "max", teamPromptMaxChars));
        }

        List<SlotDto> slots = request.slots();

        // 1. 슬롯 형태(role/slotIndex 범위·중복) + 프롬프트 길이
        Set<Integer> starterIndexes = new HashSet<>();
        Set<Integer> benchIndexes = new HashSet<>();
        Set<String> seenPlayers = new HashSet<>();
        int starterCount = 0;
        int benchCount = 0;

        for (SlotDto slot : slots) {
            if (slot.playerId() == null || slot.playerId().isBlank()) {
                throw deckInvalid("playerId가 비어 있는 슬롯이 있습니다", Map.of("rule", "PLAYER_ID_REQUIRED"));
            }
            if (!ROLE_STARTER.equals(slot.role()) && !ROLE_BENCH.equals(slot.role())) {
                throw deckInvalid("role은 starter|bench만 허용됩니다",
                        Map.of("rule", "ROLE_INVALID", "playerId", slot.playerId(),
                                "role", String.valueOf(slot.role())));
            }
            if (slot.slotIndex() == null) {
                throw deckInvalid("slotIndex가 없습니다",
                        Map.of("rule", "SLOT_INDEX_REQUIRED", "playerId", slot.playerId()));
            }
            if (!seenPlayers.add(slot.playerId())) {
                throw deckInvalid("같은 선수가 덱에 두 번 들어갈 수 없습니다",
                        Map.of("rule", "DUPLICATE_PLAYER", "playerId", slot.playerId()));
            }
            if (slot.promptText() != null && slot.promptText().length() > promptMaxChars) {
                throw deckInvalid("선수 프롬프트가 최대 길이(" + promptMaxChars + "자)를 초과했습니다",
                        Map.of("rule", "PROMPT_TOO_LONG", "playerId", slot.playerId(),
                                "length", slot.promptText().length(), "max", promptMaxChars));
            }

            if (ROLE_STARTER.equals(slot.role())) {
                starterCount++;
                if (slot.slotIndex() < 0 || slot.slotIndex() >= STARTER_COUNT) {
                    throw deckInvalid("starter slotIndex는 0..10이어야 합니다",
                            Map.of("rule", "SLOT_INDEX_RANGE", "playerId", slot.playerId(),
                                    "slotIndex", slot.slotIndex()));
                }
                if (!starterIndexes.add(slot.slotIndex())) {
                    throw deckInvalid("starter slotIndex가 중복됩니다",
                            Map.of("rule", "SLOT_INDEX_DUPLICATE", "playerId", slot.playerId(),
                                    "slotIndex", slot.slotIndex()));
                }
            } else {
                benchCount++;
                if (slot.slotIndex() < 0 || slot.slotIndex() >= BENCH_INDEX_SPACE) {
                    throw deckInvalid("bench slotIndex는 0.." + (BENCH_INDEX_SPACE - 1) + "이어야 합니다",
                            Map.of("rule", "SLOT_INDEX_RANGE", "playerId", slot.playerId(),
                                    "slotIndex", slot.slotIndex()));
                }
                if (!benchIndexes.add(slot.slotIndex())) {
                    throw deckInvalid("bench slotIndex가 중복됩니다",
                            Map.of("rule", "SLOT_INDEX_DUPLICATE", "playerId", slot.playerId(),
                                    "slotIndex", slot.slotIndex()));
                }
            }
        }

        // 2. 선발 11명 정확히
        if (starterCount != STARTER_COUNT) {
            throw deckInvalid("선발이 " + STARTER_COUNT + "명이 아닙니다",
                    Map.of("rule", "STARTER_COUNT", "starterCount", starterCount, "required", STARTER_COUNT));
        }

        // 3. 벤치 상한
        if (benchCount > benchMax) {
            throw deckInvalid("벤치는 최대 " + benchMax + "명입니다",
                    Map.of("rule", "BENCH_MAX", "benchCount", benchCount, "max", benchMax));
        }

        // 4. 카탈로그 존재 + 포지션 조회 (한 번에)
        Map<String, String> positions = new HashMap<>();
        String inClause = String.join(",", seenPlayers.stream().map(p -> "?").toList());
        jdbcClient.sql("SELECT id, position FROM players WHERE id IN (" + inClause + ")")
                .params(List.copyOf(seenPlayers))
                .query((rs, rowNum) -> Map.entry(rs.getString("id"), rs.getString("position")))
                .list()
                .forEach(e -> positions.put(e.getKey(), e.getValue()));

        for (String playerId : seenPlayers) {
            if (!positions.containsKey(playerId)) {
                throw deckInvalid("카탈로그에 없는 선수입니다",
                        Map.of("rule", "UNKNOWN_PLAYER", "playerId", playerId));
            }
        }

        // 5. 보유 여부
        Set<String> owned = new HashSet<>(jdbcClient
                .sql("SELECT player_id FROM user_players WHERE user_id = ? AND player_id IN (" + inClause + ")")
                .params(concat(userId, seenPlayers))
                .query(String.class)
                .list());
        for (String playerId : seenPlayers) {
            if (!owned.contains(playerId)) {
                throw deckInvalid("보유하지 않은 선수입니다",
                        Map.of("rule", "NOT_OWNED", "playerId", playerId));
            }
        }

        // 6. 선발 중 GK ≥ 1
        boolean hasGk = slots.stream()
                .filter(s -> ROLE_STARTER.equals(s.role()))
                .anyMatch(s -> "GK".equals(positions.get(s.playerId())));
        if (!hasGk) {
            throw deckInvalid("선발에 GK가 최소 1명 필요합니다", Map.of("rule", "GK_REQUIRED"));
        }
    }

    private static List<Object> concat(String first, Set<String> rest) {
        List<Object> params = new java.util.ArrayList<>();
        params.add(first);
        params.addAll(rest);
        return params;
    }

    private static ApiException deckInvalid(String message, Map<String, Object> detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "DECK_INVALID", message, detail);
    }

    // ── 내부 조회/매핑 ───────────────────────────────────────────────────

    private Optional<DeckRow> findActiveDeck(String userId) {
        return jdbcClient.sql("""
                        SELECT id, formation, team_prompt, updated_at FROM decks
                        WHERE user_id = ? AND is_active = 1
                        """)
                .param(userId)
                .query((rs, rowNum) -> new DeckRow(rs.getString("id"), rs.getString("formation"),
                        rs.getString("team_prompt"), rs.getString("updated_at")))
                .optional();
    }

    /** 공백만 있는 문장은 없는 것과 같다 — 저장·비교 양쪽에서 한 규칙으로 정규화한다. */
    private static String blankToNull(String text) {
        return text == null || text.isBlank() ? null : text;
    }

    private DeckResponse toResponse(DeckRow deck) {
        List<SlotDto> slots = jdbcClient.sql("""
                        SELECT player_id, role, slot_index, prompt_text FROM deck_slots
                        WHERE deck_id = ?
                        ORDER BY CASE role WHEN 'starter' THEN 0 ELSE 1 END, slot_index
                        """)
                .param(deck.id())
                .query((rs, rowNum) -> new SlotDto(
                        rs.getString("player_id"),
                        rs.getString("role"),
                        rs.getInt("slot_index"),
                        rs.getString("prompt_text")))
                .list();
        return new DeckResponse(deck.id(), deck.formation(), deck.teamPrompt(), slots, deck.updatedAt());
    }

    private record DeckRow(String id, String formation, String teamPrompt, String updatedAt) {
    }

    // ── DTO (openapi.yaml Deck/DeckSlot/DeckUpdateRequest와 일치) ────────

    public record SlotDto(String playerId, String role, Integer slotIndex, String promptText) {
    }

    /**
     * @param teamPrompt 덱 사전 <b>팀</b> 지시(#253, 선택). 선수별 {@code promptText} 와 같은 성격의
     *     덱 레벨 값으로, 매치 시점 팀 지시({@code match_prompts} phase=pre|halftime)의 <b>기본값</b>이다
     *     (덱 ← pre ← halftime — {@code PromptContextBuilder.userPromptSet}).
     */
    public record DeckUpdateRequest(String formation, String teamPrompt, List<SlotDto> slots) {

        /** 라인업 <b>검증만</b> 하는 호출측용(팀 문장 무관) — 매치 생성/킥오프 재캡처·프리셋 검증. */
        public DeckUpdateRequest(String formation, List<SlotDto> slots) {
            this(formation, null, slots);
        }
    }

    public record DeckResponse(String id, String formation, String teamPrompt,
                               List<SlotDto> slots, String updatedAt) {
    }
}
