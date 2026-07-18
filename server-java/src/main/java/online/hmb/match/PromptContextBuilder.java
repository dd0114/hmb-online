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
    private final RelationService relationService;

    public PromptContextBuilder(JdbcClient jdbcClient, ObjectMapper objectMapper,
                                RelationService relationService) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.relationService = relationService;
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

    /** 유저팀 컨텍스트(기본 side='home' — 연습/유저 홈경기). */
    public Map<String, Object> buildUserContext(MatchService.MatchRow match, int half,
                                                 JsonNode snapshot,
                                                 List<MatchService.Substitution> subs,
                                                 Map<String, Object> prevSummary,
                                                 JsonNode opponentDeck) {
        return buildUserContext(match, half, snapshot, subs, prevSummary, opponentDeck, "home");
    }

    /**
     * 유저팀 컨텍스트. opponentDeck = 봇 덱 JSON(마킹용 opponentRoster 근거). side = 엔진 사이드
     * ('home'|'away') — 리그 어웨이 경기면 유저가 'away'(jobSeed·SelectData 배치가 이 사이드로 정렬).
     */
    public Map<String, Object> buildUserContext(MatchService.MatchRow match, int half,
                                                 JsonNode snapshot,
                                                 List<MatchService.Substitution> subs,
                                                 Map<String, Object> prevSummary,
                                                 JsonNode opponentDeck,
                                                 String side) {
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

        Map<String, Object> context = context(match, side, half, snapshot.path("formation").asText(),
                roster, teamPrompt, playerPrompts, prevSummary);
        // ── Phase2 additive AI 컨텍스트(AC-C2~C4, openapi-v2 AiJobContextPhase2Fields — 필드명 자구 준수) ──
        addPhase2Context(context, match, snapshot, roster, opponentDeck);
        return context;
    }

    /**
     * openapi-v2 {@code AiJobContextPhase2Fields} 자구대로 additive 필드 주입(zod .optional 호환):
     * manualTactics / conditions / relations / teamMorale / opponentRoster. 없는 값은 키 생략.
     */
    private void addPhase2Context(Map<String, Object> context, MatchService.MatchRow match,
                                  JsonNode snapshot, List<RosterEntry> roster, JsonNode opponentDeck) {
        List<String> rosterIds = roster.stream().map(RosterEntry::playerId).toList();

        // manualTactics: 매치 스냅샷의 teamTactics(있으면).
        JsonNode teamTactics = snapshot.get("teamTactics");
        if (teamTactics != null && teamTactics.isObject()) {
            context.put("manualTactics", objectMapper.convertValue(teamTactics, Map.class));
        }

        // conditions: {playerId: 0..1} — 로스터 선수만(match.conditions_json 파생).
        Map<String, Double> allConditions = parseConditions(match.conditionsJson());
        if (!allConditions.isEmpty()) {
            Map<String, Double> rosterConditions = new LinkedHashMap<>();
            for (String pid : rosterIds) {
                if (allConditions.containsKey(pid)) {
                    rosterConditions.put(pid, allConditions.get(pid));
                }
            }
            if (!rosterConditions.isEmpty()) {
                context.put("conditions", rosterConditions);
            }
        }

        // relations: {playerId: {trust, personality}} — 로스터 선수만.
        Map<String, Map<String, Object>> relations = relationService.relationContextFor(match.userId(), rosterIds);
        if (!relations.isEmpty()) {
            context.put("relations", relations);
        }

        // teamMorale: {morale, streak}.
        RelationService.Morale morale = relationService.moraleOf(match.userId());
        Map<String, Object> moraleMap = new LinkedHashMap<>();
        moraleMap.put("morale", morale.morale());
        moraleMap.put("streak", morale.streak());
        context.put("teamMorale", moraleMap);

        // opponentRoster: [{playerId, name, position}] — 마킹 지시 해석용(상대 이름→playerId).
        if (opponentDeck != null) {
            List<Map<String, Object>> opponentRoster = new ArrayList<>();
            for (JsonNode starter : opponentDeck.path("starters")) {
                String pid = starter.path("playerId").asText();
                Map<String, String> nameGrade = playerNamePosition(pid);
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("playerId", pid);
                entry.put("name", nameGrade.get("name"));
                entry.put("position", nameGrade.get("position"));
                opponentRoster.add(entry);
            }
            if (!opponentRoster.isEmpty()) {
                context.put("opponentRoster", opponentRoster);
            }
        }
    }

    private Map<String, Double> parseConditions(String conditionsJson) {
        Map<String, Double> map = new LinkedHashMap<>();
        if (conditionsJson == null || conditionsJson.isBlank()) {
            return map;
        }
        readJson(conditionsJson).properties().forEach(e -> map.put(e.getKey(), e.getValue().asDouble()));
        return map;
    }

    private Map<String, String> playerNamePosition(String playerId) {
        return jdbcClient.sql("SELECT name, position FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> Map.of("name", rs.getString("name"), "position", rs.getString("position")))
                .optional()
                .orElse(Map.of("name", playerId, "position", "?"));
    }

    /** 봇팀 컨텍스트(기본 side='away' — 연습/유저 홈경기). */
    public Map<String, Object> buildBotContext(MatchService.MatchRow match, int half,
                                                BotService.BotRow bot,
                                                Map<String, Object> prevSummary) {
        return buildBotContext(match, half, bot, prevSummary, "away");
    }

    /** 봇팀 컨텍스트. side = 엔진 사이드 — 리그 어웨이 경기면 봇이 'home'. */
    public Map<String, Object> buildBotContext(MatchService.MatchRow match, int half,
                                                BotService.BotRow bot,
                                                Map<String, Object> prevSummary,
                                                String side) {
        JsonNode deck = readJson(bot.deckJson());
        Map<String, String> playerPrompts = new TreeMap<>();
        for (JsonNode starter : deck.path("starters")) {
            if (starter.hasNonNull("promptText")) {
                playerPrompts.put(starter.path("playerId").asText(), starter.path("promptText").asText());
            }
        }
        List<RosterEntry> roster = buildRoster(deck, List.of()); // 봇은 교체 없음(PoC)
        return context(match, side, half, deck.path("formation").asText(),
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
