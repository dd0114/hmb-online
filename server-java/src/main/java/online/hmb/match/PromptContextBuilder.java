package online.hmb.match;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.Collection;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.TreeSet;
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

    // ── 유효 프롬프트 세트 / 델타 (#193 W2b-B2) ─────────────────────────────

    /**
     * 어느 시점의 <b>유효 지시 세트</b>(팀 1개 + 선수별). 잡 컨텍스트에 실리는 값과 <b>같은 함수</b>로
     * 만들어야 델타가 실제 컨텍스트와 어긋나지 않으므로, {@link #buildUserContext} 도 이걸 쓴다.
     */
    public record PromptSet(String teamPrompt, Map<String, String> playerPrompts) {
    }

    /** A(베이스) 잡이 쓴 지시 = 덱 사전 프롬프트만(매치시점 phase 미적용). */
    public static final List<String> BASE_PHASES = List.of();
    /** 전반(=킥오프) 시점 유효 지시: 덱 ← pre. */
    public static final List<String> PRE_PHASES = List.of("pre");
    /** 후반 시점 유효 지시: 덱 ← pre ← halftime. */
    public static final List<String> HALFTIME_PHASES = List.of("pre", "halftime");

    /** half → 그 half 의 매치시점 phase 목록(컨텍스트 병합 규칙 §5.2). */
    public static List<String> phasesForHalf(int half) {
        return half == 2 ? HALFTIME_PHASES : PRE_PHASES;
    }

    /**
     * 유저팀 유효 지시 세트. 팀 지시는 phase 순서대로 덮어쓰고(뒤가 이김 — h2 는 halftime 우선),
     * 선수 지시는 덱 promptText 위에 phase 별 지시를 덮어쓴 뒤 로스터로 한정한다.
     *
     * <p>{@code phases} 가 비면 {@link #userBaseJob} 이 A 잡에 실은 값과 같다(팀 지시 없음 = "").
     */
    public PromptSet userPromptSet(String matchId, JsonNode snapshot, Collection<String> rosterIds,
                                   List<String> phases) {
        String teamPrompt = "";
        for (String phase : phases) {
            String text = phaseTeamPrompt(matchId, phase);
            if (text != null) {
                teamPrompt = text;
            }
        }
        Map<String, String> playerPrompts = deckPlayerPrompts(snapshot);
        for (String phase : phases) {
            playerPrompts.putAll(phasePlayerPrompts(matchId, phase));
        }
        playerPrompts.keySet().retainAll(new LinkedHashSet<>(rosterIds));
        return new PromptSet(teamPrompt, playerPrompts);
    }

    /**
     * old→new 지시 변경분 (shared {@code PromptDelta} 계약, #193 W2b-B2).
     * 팀은 값이 다를 때만 {old,new}, 선수는 달라진 playerId 만 — old 없음=신규, new 없음=삭제.
     *
     * @return 변경이 하나도 없으면 <b>null</b>(컨텍스트에서 필드 자체를 생략한다)
     */
    public Map<String, Object> promptDelta(PromptSet oldSet, PromptSet newSet) {
        Map<String, Object> delta = new LinkedHashMap<>();
        if (!oldSet.teamPrompt().equals(newSet.teamPrompt())) {
            Map<String, String> team = new LinkedHashMap<>();
            team.put("old", oldSet.teamPrompt());
            team.put("new", newSet.teamPrompt());
            delta.put("team", team);
        }
        Map<String, Object> players = new TreeMap<>(); // playerId 정렬 = 잡 id 재현 안정
        Set<String> ids = new TreeSet<>(oldSet.playerPrompts().keySet());
        ids.addAll(newSet.playerPrompts().keySet());
        for (String playerId : ids) {
            String before = oldSet.playerPrompts().get(playerId);
            String after = newSet.playerPrompts().get(playerId);
            if (Objects.equals(before, after)) {
                continue;
            }
            Map<String, String> entry = new LinkedHashMap<>();
            if (before != null) {
                entry.put("old", before);
            }
            if (after != null) {
                entry.put("new", after);
            }
            players.put(playerId, entry);
        }
        if (!players.isEmpty()) {
            delta.put("players", players);
        }
        return delta.isEmpty() ? null : delta;
    }

    /** deck(스냅샷/봇덱)의 선발+벤치 promptText → {playerId:text}(정렬). 로스터 한정은 호출측 몫. */
    private Map<String, String> deckPlayerPrompts(JsonNode deck) {
        Map<String, String> prompts = new TreeMap<>();
        for (JsonNode entry : deck.path("starters")) {
            if (entry.hasNonNull("promptText")) {
                prompts.put(entry.path("playerId").asText(), entry.path("promptText").asText());
            }
        }
        for (JsonNode entry : deck.path("bench")) {
            if (entry.hasNonNull("promptText")) {
                prompts.put(entry.path("playerId").asText(), entry.path("promptText").asText());
            }
        }
        return prompts;
    }

    /** {@link #buildRoster} 의 playerId 만 — 카탈로그 조회 없이(11 쿼리 회피) 프롬프트 한정용. */
    public Set<String> rosterIds(JsonNode deckJson, List<MatchService.Substitution> subs) {
        Map<String, String> outToIn = new LinkedHashMap<>();
        for (MatchService.Substitution sub : subs) {
            outToIn.put(sub.out(), sub.in());
        }
        Set<String> ids = new LinkedHashSet<>();
        for (JsonNode starter : deckJson.path("starters")) {
            String playerId = starter.path("playerId").asText();
            ids.add(outToIn.getOrDefault(playerId, playerId));
        }
        return ids;
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
        // 팀 프롬프트: h2면 halftime 우선 → pre → "" / 선수 프롬프트: 덱 스냅샷 ← pre ← (h2) halftime.
        // 로스터에 없는 선수의 프롬프트는 제거(교체 아웃 등) — 전부 userPromptSet 한 곳에서(델타와 동일 함수).
        List<RosterEntry> roster = buildRoster(snapshot, half == 2 ? subs : List.of());
        PromptSet prompts = userPromptSet(match.id(), snapshot,
                roster.stream().map(RosterEntry::playerId).toList(), phasesForHalf(half));

        Map<String, Object> context = context(match, side, half, snapshot.path("formation").asText(),
                roster, prompts.teamPrompt(), prompts.playerPrompts(), prevSummary);
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

    // ── A(베이스 생성) 컨텍스트 — 크로스매치 캐시(#95 A+B) ────────────────────
    // A = 덱 스냅샷만(매치 가변요소 제외): formation + roster + 덱 teamPrompt/playerPrompts + manualTactics.
    // 매치시점 요소(pre/halftime 프롬프트·relations/morale/conditions/opponentRoster/prevSummary)는 제외 →
    // 같은 덱이면 매치·양팀 무관하게 같은 A. seed/matchId/side/half 는 캐시키에서 빠지고 컨텍스트엔 상수로 담는다.

    /** A(베이스) 잡 = 캐시 키 재료 + 그 위 team-input 컨텍스트(상수 매치필드) 한 묶음. */
    public record BaseJob(String material, String baseId, Map<String, Object> context) {
    }

    private static final String BASE_MATCH_ID = "BASE"; // A 컨텍스트의 상수 matchId(캐시키에서는 제외됨).

    /** 유저팀 A 잡(덱 스냅샷 기준). 덱-레벨 팀 프롬프트는 이 모델에 없으므로 teamPrompt="". */
    public BaseJob userBaseJob(MatchService.MatchRow match, JsonNode snapshot) {
        List<RosterEntry> roster = buildRoster(snapshot, List.of());
        Map<String, String> playerPrompts = deckBasePlayerPrompts(snapshot, roster);
        Map<String, Object> manualTactics = manualTacticsOf(snapshot);
        return baseJob(match, snapshot.path("formation").asText(), roster, "", playerPrompts, manualTactics);
    }

    /** 봇팀 A 잡(봇 덱 기준). teamPrompt = 봇 페르소나(고정). */
    public BaseJob botBaseJob(MatchService.MatchRow match, BotService.BotRow bot) {
        JsonNode deck = readJson(bot.deckJson());
        List<RosterEntry> roster = buildRoster(deck, List.of());
        Map<String, String> playerPrompts = deckBasePlayerPrompts(deck, roster);
        Map<String, Object> manualTactics = manualTacticsOf(deck);
        return baseJob(match, deck.path("formation").asText(), roster, bot.persona(), playerPrompts,
                manualTactics);
    }

    private BaseJob baseJob(MatchService.MatchRow match, String formation, List<RosterEntry> roster,
                            String teamPrompt, Map<String, String> playerPrompts,
                            Map<String, Object> manualTactics) {
        List<BaseContextKey.RosterKey> keyRoster = roster.stream()
                .map(r -> new BaseContextKey.RosterKey(r.playerId(), r.slotIndex(), r.attributes()))
                .toList();
        String material = BaseContextKey.material(formation, keyRoster, teamPrompt, playerPrompts,
                manualTactics);
        String baseId = BaseContextKey.baseId(material);

        // A 컨텍스트: team-input(실행기가 풀 생성) — 매치필드는 상수(캐시키에서 제외되므로 결과 재현엔 무해).
        // seed 는 재료 파생 상수(엔진 통과 필드 — 재사용/머지 시 Java 가 halfSeed 로 교체). half=1(prevSummary 없음).
        Map<String, Object> context = context(match /*미사용 side/seed는 아래서 덮음*/, "home", 1, formation,
                roster, teamPrompt, playerPrompts, null);
        context.put("matchId", BASE_MATCH_ID);
        context.put("seed", Hashes.deriveUint64Seed(material));
        if (manualTactics != null) {
            context.put("manualTactics", manualTactics); // A-base 슬라이더(있으면).
        }
        return new BaseJob(material, baseId, context);
    }

    /** 덱 스냅샷(또는 봇 덱)의 선수 promptText → {playerId:text}, 로스터(선발)로 한정. */
    private Map<String, String> deckBasePlayerPrompts(JsonNode deck, List<RosterEntry> roster) {
        Map<String, String> prompts = deckPlayerPrompts(deck);
        prompts.keySet().retainAll(roster.stream().map(RosterEntry::playerId).toList());
        return prompts;
    }

    /** 덱/스냅샷의 teamTactics(수동 전술) → Map, 없으면 null(캐시키 규약: manualTactics=null). */
    private Map<String, Object> manualTacticsOf(JsonNode deck) {
        JsonNode tt = deck.get("teamTactics");
        if (tt != null && tt.isObject()) {
            @SuppressWarnings("unchecked")
            Map<String, Object> map = objectMapper.convertValue(tt, Map.class);
            return map;
        }
        return null;
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
