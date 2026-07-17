package online.hmb.match;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import online.hmb.common.Hashes;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * AI 잡 컨텍스트 빌더 (LLD §5.2 — LLD-ts-servants §3과 동일 계약):
 * {kind:'team-input', matchId, side, half, seed(side별 파생), formation,
 *  roster:[11 {playerId,name,position,attributes,slotIndex}], teamPrompt,
 *  playerPrompts:{playerId:text}, prevSummary?}
 *
 * 프롬프트 병합 규칙(LLD §5.2):
 * - 유저팀(home): teamPrompt = match_prompts(team) — h2는 halftime 우선, 없으면 pre.
 *   playerPrompts = 덱 스냅샷 promptText(기본값) ← pre(player) 덮어씀 ← h2면 halftime(player) 덮어씀.
 * - 봇팀(away): teamPrompt = bots.persona, playerPrompts = deck_json 선수 promptText.
 *   h2도 동일 페르소나(+prevSummary).
 */
@Component
public class PromptContextBuilder {

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public PromptContextBuilder(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    /** 로스터 항목 — 컨텍스트/SelectData 공용 원료. */
    public record RosterEntry(String playerId, String name, String position,
                              Map<String, Object> attributes, int slotIndex) {
    }

    /**
     * deck JSON(스냅샷 또는 bots.deck_json)의 starters + (h2면) 교체 반영 → 로스터 11명.
     * 교체는 슬롯 승계: out의 slotIndex를 in이 이어받는다(LLD §5.4).
     */
    public List<RosterEntry> buildRoster(JsonNode deckJson, List<MatchService.Substitution> subs) {
        Map<String, String> outToIn = new LinkedHashMap<>();
        for (MatchService.Substitution sub : subs) {
            outToIn.put(sub.out(), sub.in());
        }
        List<RosterEntry> roster = new ArrayList<>();
        for (JsonNode starter : deckJson.path("starters")) {
            String playerId = starter.path("playerId").asText();
            int slotIndex = starter.path("slotIndex").asInt();
            String effective = outToIn.getOrDefault(playerId, playerId);
            roster.add(playerRow(effective, slotIndex));
        }
        return roster;
    }

    private RosterEntry playerRow(String playerId, int slotIndex) {
        return jdbcClient.sql("SELECT id, name, position, attributes_json FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> new RosterEntry(rs.getString("id"), rs.getString("name"),
                        rs.getString("position"), parseAttributes(rs.getString("attributes_json")), slotIndex))
                .optional()
                .orElseThrow(() -> new IllegalStateException("카탈로그에 없는 선수: " + playerId));
    }

    /** 유저팀(home) 컨텍스트. */
    public Map<String, Object> buildUserContext(MatchService.MatchRow match, int half,
                                                 JsonNode snapshot,
                                                 List<MatchService.Substitution> subs,
                                                 Map<String, Object> prevSummary) {
        // 팀 프롬프트: h2면 halftime 우선 → pre → ""
        String teamPrompt = teamPromptOf(match.id(), half);

        // 선수 프롬프트: 덱 스냅샷(기본) ← pre ← (h2) halftime
        Map<String, String> playerPrompts = new TreeMap<>();
        for (JsonNode entry : snapshot.path("starters")) {
            if (entry.hasNonNull("promptText")) {
                playerPrompts.put(entry.path("playerId").asText(), entry.path("promptText").asText());
            }
        }
        for (JsonNode entry : snapshot.path("bench")) {
            if (entry.hasNonNull("promptText")) {
                playerPrompts.put(entry.path("playerId").asText(), entry.path("promptText").asText());
            }
        }
        playerPrompts.putAll(phasePlayerPrompts(match.id(), "pre"));
        if (half == 2) {
            playerPrompts.putAll(phasePlayerPrompts(match.id(), "halftime"));
        }

        List<RosterEntry> roster = buildRoster(snapshot, half == 2 ? subs : List.of());
        // 로스터에 없는 선수의 프롬프트는 제거(교체 아웃 등)
        playerPrompts.keySet().retainAll(roster.stream().map(RosterEntry::playerId).toList());

        return context(match, "home", half, snapshot.path("formation").asText(),
                roster, teamPrompt, playerPrompts, prevSummary);
    }

    /** 봇팀(away) 컨텍스트. */
    public Map<String, Object> buildBotContext(MatchService.MatchRow match, int half,
                                                BotService.BotRow bot,
                                                Map<String, Object> prevSummary) {
        JsonNode deck = readJson(bot.deckJson());
        Map<String, String> playerPrompts = new TreeMap<>();
        for (JsonNode starter : deck.path("starters")) {
            if (starter.hasNonNull("promptText")) {
                playerPrompts.put(starter.path("playerId").asText(), starter.path("promptText").asText());
            }
        }
        List<RosterEntry> roster = buildRoster(deck, List.of()); // 봇은 교체 없음(PoC)
        return context(match, "away", half, deck.path("formation").asText(),
                roster, bot.persona(), playerPrompts, prevSummary);
    }

    private Map<String, Object> context(MatchService.MatchRow match, String side, int half,
                                        String formation, List<RosterEntry> roster,
                                        String teamPrompt, Map<String, String> playerPrompts,
                                        Map<String, Object> prevSummary) {
        Map<String, Object> context = new LinkedHashMap<>();
        context.put("kind", "team-input");
        context.put("matchId", match.id());
        context.put("side", side);
        context.put("half", half);
        context.put("seed", Hashes.jobSeed(match.seed(), half, side)); // side별 파생 (LLD §5.2)
        context.put("formation", formation);
        context.put("roster", roster.stream().map(r -> {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("playerId", r.playerId());
            entry.put("name", r.name());
            entry.put("position", r.position());
            entry.put("attributes", r.attributes());
            entry.put("slotIndex", r.slotIndex());
            return entry;
        }).toList());
        context.put("teamPrompt", teamPrompt);
        context.put("playerPrompts", playerPrompts);
        if (prevSummary != null) {
            context.put("prevSummary", prevSummary);
        }
        return context;
    }

    private String teamPromptOf(String matchId, int half) {
        if (half == 2) {
            String halftime = phaseTeamPrompt(matchId, "halftime");
            if (halftime != null) {
                return halftime;
            }
        }
        String pre = phaseTeamPrompt(matchId, "pre");
        return pre != null ? pre : "";
    }

    private String phaseTeamPrompt(String matchId, String phase) {
        return jdbcClient.sql("""
                        SELECT text FROM match_prompts
                        WHERE match_id = ? AND phase = ? AND scope = 'team' AND player_id IS NULL
                        """)
                .params(matchId, phase)
                .query(String.class)
                .optional()
                .orElse(null);
    }

    private Map<String, String> phasePlayerPrompts(String matchId, String phase) {
        Map<String, String> prompts = new LinkedHashMap<>();
        jdbcClient.sql("""
                        SELECT player_id, text FROM match_prompts
                        WHERE match_id = ? AND phase = ? AND scope = 'player' AND player_id IS NOT NULL
                        """)
                .params(matchId, phase)
                .query((rs, n) -> Map.entry(rs.getString("player_id"), rs.getString("text")))
                .list()
                .forEach(e -> prompts.put(e.getKey(), e.getValue()));
        return prompts;
    }

    /**
     * prevSummary (h2 컨텍스트, LLD §5.2): h1 MatchLog에서 산출.
     * shots = type=='shot' 이벤트 수(엔진은 모든 시도에 shot을 남기고 결과로 goal/save가 따라온다).
     * possessionHint = pass 이벤트 점유율로 home|away|balanced (55%/45% 컷).
     */
    public Map<String, Object> prevSummaryFrom(JsonNode h1MatchLog) {
        int scoreHome = h1MatchLog.path("finalScore").path("home").asInt();
        int scoreAway = h1MatchLog.path("finalScore").path("away").asInt();
        long shots = 0;
        long homePasses = 0;
        long awayPasses = 0;
        for (JsonNode event : h1MatchLog.path("events")) {
            String type = event.path("type").asText();
            if ("shot".equals(type)) {
                shots++;
            }
            if ("pass".equals(type)) {
                if ("home".equals(event.path("team").asText())) {
                    homePasses++;
                } else if ("away".equals(event.path("team").asText())) {
                    awayPasses++;
                }
            }
        }
        String possessionHint = "balanced";
        long totalPasses = homePasses + awayPasses;
        if (totalPasses > 0) {
            double homeShare = (double) homePasses / totalPasses;
            if (homeShare > 0.55) {
                possessionHint = "home";
            } else if (homeShare < 0.45) {
                possessionHint = "away";
            }
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("scoreHome", scoreHome);
        summary.put("scoreAway", scoreAway);
        summary.put("shots", shots);
        summary.put("possessionHint", possessionHint);
        return summary;
    }

    public JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 파싱 실패: " + e.getMessage(), e);
        }
    }

    private Map<String, Object> parseAttributes(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
            });
        } catch (Exception e) {
            throw new IllegalStateException("attributes_json 파싱 실패: " + e.getMessage(), e);
        }
    }
}
