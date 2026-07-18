package online.hmb.match;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.security.SecureRandom;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.meta.DeckService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 매치플로우 상태머신 (LLD §5). 전이는 전부 CAS(`UPDATE ... WHERE state=?`) — 동시 요청 안전.
 * 상태·허용 액션 = §5.1 전이표 그대로: 그 외 조합은 409 INVALID_STATE (AC-M1).
 *
 * 덱 스냅샷(user_deck_json): {formation, starters:[{playerId,slotIndex,promptText?}]×11,
 * bench:[{playerId,slotIndex,promptText?}]} — 매치 시작 후 덱을 바꿔도 진행 중 매치는 불변.
 */
@Service
public class MatchService {

    public static final String S_BRIEFING = "BRIEFING";
    public static final String S_GEN1 = "GEN1";
    public static final String S_H1_BREAK = "H1_BREAK";
    public static final String S_GEN2 = "GEN2";
    public static final String S_FINISHED = "FINISHED";
    public static final String S_FAILED = "FAILED";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final DeckService deckService;
    private final BotService botService;
    private final ConditionService conditionService;
    private final ObjectMapper objectMapper;
    private final int halftimeSubsMax;
    private final int promptMaxChars;
    private final SecureRandom secureRandom = new SecureRandom();

    public MatchService(JdbcClient jdbcClient,
                        TxRunner txRunner,
                        DeckService deckService,
                        BotService botService,
                        ConditionService conditionService,
                        ObjectMapper objectMapper,
                        @Value("${hmb.match.halftime-subs-max}") int halftimeSubsMax,
                        @Value("${hmb.deck.player-prompt-max-chars}") int promptMaxChars) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.deckService = deckService;
        this.botService = botService;
        this.conditionService = conditionService;
        this.objectMapper = objectMapper;
        this.halftimeSubsMax = halftimeSubsMax;
        this.promptMaxChars = promptMaxChars;
    }

    // ── 행 모델 ─────────────────────────────────────────────────────────

    public record MatchRow(String id, String userId, String botId, String state, String failReason,
                           String seed, String engineVersion, String userDeckJson, String subsJson,
                           Integer scoreH1Home, Integer scoreH1Away, Integer scoreHome, Integer scoreAway,
                           String result, String createdAt, String finishedAt,
                           String conditionsJson, String mode, String leagueFixtureId) {
    }

    public MatchRow getOwned(String userId, String matchId) {
        MatchRow row = find(matchId)
                .orElseThrow(() -> ApiException.notFound("매치를 찾을 수 없습니다"));
        if (!row.userId().equals(userId)) {
            throw ApiException.notFound("매치를 찾을 수 없습니다"); // 소유권 비노출
        }
        return row;
    }

    public Optional<MatchRow> find(String matchId) {
        return jdbcClient.sql("""
                        SELECT id, user_id, bot_id, state, fail_reason, seed, engine_version,
                               user_deck_json, subs_json, score_h1_home, score_h1_away,
                               score_home, score_away, result, created_at, finished_at,
                               conditions_json, mode, league_fixture_id
                        FROM matches WHERE id = ?
                        """)
                .param(matchId)
                .query((rs, n) -> new MatchRow(
                        rs.getString("id"), rs.getString("user_id"), rs.getString("bot_id"),
                        rs.getString("state"), rs.getString("fail_reason"), rs.getString("seed"),
                        rs.getString("engine_version"), rs.getString("user_deck_json"),
                        rs.getString("subs_json"),
                        (Integer) rs.getObject("score_h1_home"), (Integer) rs.getObject("score_h1_away"),
                        (Integer) rs.getObject("score_home"), (Integer) rs.getObject("score_away"),
                        rs.getString("result"), rs.getString("created_at"), rs.getString("finished_at"),
                        rs.getString("conditions_json"), rs.getString("mode"),
                        rs.getString("league_fixture_id")))
                .optional();
    }

    /** 상태 전이 CAS. 성공 시 true. */
    public boolean casTransition(String matchId, String fromState, String toState) {
        return jdbcClient.sql("UPDATE matches SET state = ? WHERE id = ? AND state = ?")
                .params(toState, matchId, fromState)
                .update() == 1;
    }

    private static ApiException invalidState(String state, String action) {
        return new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                "현재 상태(" + state + ")에서 허용되지 않는 액션입니다: " + action,
                Map.of("state", state, "action", action));
    }

    // ── 생성 (BRIEFING 진입) ────────────────────────────────────────────

    public MatchRow createMatch(String userId, String botId) {
        return createMatch(userId, botId, null);
    }

    /**
     * teamTactics(P2-D4, 선택): 브리핑 최종 수동 전술 {line,press,tempo,width}(0..1). 있으면 매치
     * 스냅샷(user_deck_json)에 포함돼 AI 컨텍스트로 전달된다(LLD-p2-server §2·§4). 매치 시작 후
     * 덱/전술을 바꿔도 진행 중 매치는 이 스냅샷으로 격리된다.
     */
    public MatchRow createMatch(String userId, String botId, JsonNode teamTactics) {
        // 활성 덱 재검증 (AC-S2 규칙 재사용, LLD §5.1)
        DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));
        online.hmb.meta.TeamTactics.validate(teamTactics); // 있으면 0..1 범위

        BotService.BotRow bot = botId == null ? botService.pickRandom() : botService.get(botId);

        String matchId = Ulid.next();
        String seed = randomSeedHex();
        String snapshot = snapshotDeck(deck, teamTactics);
        String conditionsJson = computeConditionsJson(seed, rosterPlayerIdsOf(readJson(snapshot)));
        String now = Instant.now().toString();

        txRunner.run(() -> jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, conditions_json, mode, created_at)
                        VALUES (?, ?, ?, 'BRIEFING', ?, 'pending', ?, ?, 'practice', ?)
                        """)
                .params(matchId, userId, bot.id(), seed, snapshot, conditionsJson, now)
                .update());
        // engine_version='pending' — 실제 EngineConfig.version은 h1 시뮬 응답의
        // matchLog.configVersion으로 갱신된다(러너가 버전의 SoT).

        return getOwned(userId, matchId);
    }

    /** 매치 시드 — 감사·halfSeed 파생용 랜덤 hex(SecureRandom). 결정론은 halfSeed 파생부터 시작. */
    private String randomSeedHex() {
        byte[] bytes = new byte[16];
        secureRandom.nextBytes(bytes);
        StringBuilder sb = new StringBuilder(32);
        for (byte b : bytes) {
            sb.append(String.format("%02x", b));
        }
        return sb.toString();
    }

    private String snapshotDeck(DeckService.DeckResponse deck, JsonNode teamTactics) {
        ObjectNode snapshot = objectMapper.createObjectNode();
        snapshot.put("formation", deck.formation());
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
        // P2-D4: 수동 팀 전술을 매치 스냅샷에 포함(있을 때만) — AI 컨텍스트로 전달(§4).
        if (teamTactics != null && teamTactics.isObject()) {
            snapshot.set("teamTactics", teamTactics);
        }
        return snapshot.toString();
    }

    // ── 컨디션 (AC-C1, LLD §3) ──────────────────────────────────────────

    /** 스냅샷의 선발+벤치 playerId 집합(컨디션 롤 대상 = 후반 교체 투입 포함). */
    private List<String> rosterPlayerIdsOf(JsonNode snapshot) {
        List<String> ids = new ArrayList<>();
        snapshot.path("starters").forEach(s -> ids.add(s.path("playerId").asText()));
        snapshot.path("bench").forEach(s -> ids.add(s.path("playerId").asText()));
        return ids;
    }

    /** conditions_json = {playerId: 0.0~1.0} 시드 결정론 롤(playerId 정렬 — 재현·안정 직렬화). */
    private String computeConditionsJson(String seed, List<String> playerIds) {
        ObjectNode node = objectMapper.createObjectNode();
        new java.util.TreeSet<>(playerIds).forEach(pid -> node.put(pid, conditionService.roll(seed, pid)));
        return node.toString();
    }

    /**
     * 킥오프 시 스냅샷 재캡처(W0 이월 a, AC-B2): 브리핑 중 덱/전술 수정을 매치 스냅샷에 반영한다.
     * create 시점 캡처는 폴백이고, kickoff 직전의 현재 활성 덱 + 요청 teamTactics(없으면 기존
     * 스냅샷 teamTactics 유지)로 user_deck_json 을 재구성하고 conditions 를 새 로스터로 재롤한다.
     * BRIEFING 상태에서만 수행(그 외엔 no-op — 진행 중 매치 스냅샷 불변 계약 유지).
     */
    public void recaptureSnapshotAtKickoff(String userId, String matchId, JsonNode teamTactics) {
        MatchRow row = getOwned(userId, matchId);
        if (!row.state().equals(S_BRIEFING)) {
            return; // 킥오프 재캡처는 브리핑에서만 — 이미 진행 중이면 create/기존 스냅샷 유지
        }
        DeckService.DeckResponse deck = deckService.getActiveDeck(userId);
        deckService.validate(userId, new DeckService.DeckUpdateRequest(deck.formation(), deck.slots()));

        JsonNode effectiveTactics;
        if (teamTactics != null && !teamTactics.isNull()) {
            online.hmb.meta.TeamTactics.validate(teamTactics); // 있으면 0..1
            effectiveTactics = teamTactics;
        } else {
            // 폴백: 기존 스냅샷(create/직전 브리핑)의 teamTactics 유지
            JsonNode existing = readJson(row.userDeckJson()).get("teamTactics");
            effectiveTactics = (existing != null && existing.isObject()) ? existing : null;
        }

        String snapshot = snapshotDeck(deck, effectiveTactics);
        String conditionsJson = computeConditionsJson(row.seed(), rosterPlayerIdsOf(readJson(snapshot)));
        txRunner.run(() -> jdbcClient.sql("""
                        UPDATE matches SET user_deck_json = ?, conditions_json = ?
                        WHERE id = ? AND state = 'BRIEFING'
                        """)
                .params(snapshot, conditionsJson, matchId)
                .update());
    }

    /** conditions_json → {playerId: condition}. 없으면 빈 맵. */
    public Map<String, Double> conditionsOf(MatchRow row) {
        Map<String, Double> map = new LinkedHashMap<>();
        if (row.conditionsJson() == null || row.conditionsJson().isBlank()) {
            return map;
        }
        JsonNode node = readJson(row.conditionsJson());
        node.properties().forEach(e -> map.put(e.getKey(), e.getValue().asDouble()));
        return map;
    }

    // ── 조회 (MatchDetail / 상대 분석) ──────────────────────────────────

    public record OpponentPlayer(String name, String position, String grade, boolean hasPrompt) {
    }

    public record Opponent(String name, String analysisText, List<OpponentPlayer> deck) {
    }

    public record MatchDetail(String id, String state, String failReason, Opponent opponent,
                               Integer scoreH1Home, Integer scoreH1Away,
                               Integer scoreHome, Integer scoreAway,
                               String result, String createdAt, String finishedAt,
                               Map<String, Double> conditions, String mode, String leagueFixtureId) {
    }

    public MatchDetail toDetail(MatchRow row) {
        // Phase2 additive(MatchDetailPhase2Fields): conditions/mode/leagueFixtureId — 시계 UI·리그 뱃지용.
        String mode = row.mode() == null ? "practice" : row.mode();
        return new MatchDetail(row.id(), row.state(), row.failReason(), buildOpponent(row),
                row.scoreH1Home(), row.scoreH1Away(), row.scoreHome(), row.scoreAway(),
                row.result(), row.createdAt(), row.finishedAt(),
                conditionsOf(row), mode, row.leagueFixtureId());
    }

    private Opponent buildOpponent(MatchRow row) {
        BotService.BotRow bot = botService.get(row.botId());
        JsonNode deck = readJson(bot.deckJson());
        List<OpponentPlayer> players = new ArrayList<>();
        for (JsonNode starter : deck.path("starters")) {
            String playerId = starter.path("playerId").asText();
            Map<String, String> p = playerNameGrade(playerId);
            players.add(new OpponentPlayer(p.get("name"), p.get("position"), p.get("grade"),
                    starter.hasNonNull("promptText")));
        }
        return new Opponent(bot.name(), bot.analysisText(), players);
    }

    private Map<String, String> playerNameGrade(String playerId) {
        return jdbcClient.sql("SELECT name, position, grade FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> Map.of("name", rs.getString("name"),
                        "position", rs.getString("position"), "grade", rs.getString("grade")))
                .optional()
                .orElse(Map.of("name", playerId, "position", "?", "grade", "?"));
    }

    // ── 프롬프트 (BRIEFING: pre / H1_BREAK: halftime) ───────────────────

    public record PromptRequest(String phase, String scope, String playerId, String text) {
    }

    public MatchRow submitPrompt(String userId, String matchId, PromptRequest request) {
        MatchRow row = getOwned(userId, matchId);

        String phase = request == null ? null : request.phase();
        String scope = request == null ? null : request.scope();
        if (!"pre".equals(phase) && !"halftime".equals(phase)) {
            throw ApiException.validation("phase는 pre|halftime만 허용됩니다");
        }
        if (!"team".equals(scope) && !"player".equals(scope)) {
            throw ApiException.validation("scope는 team|player만 허용됩니다");
        }

        // 전이표: pre↔BRIEFING, halftime↔H1_BREAK — 그 외 409 (AC-M1)
        String requiredState = "pre".equals(phase) ? S_BRIEFING : S_H1_BREAK;
        if (!row.state().equals(requiredState)) {
            throw invalidState(row.state(), "prompts(" + phase + ")");
        }

        if (request.text() == null || request.text().isBlank()) {
            throw ApiException.validation("text가 비어 있습니다");
        }
        if (request.text().length() > promptMaxChars) {
            throw ApiException.validation("프롬프트가 최대 길이(" + promptMaxChars + "자)를 초과했습니다");
        }

        String playerId = null;
        if ("player".equals(scope)) {
            playerId = request.playerId();
            if (playerId == null || playerId.isBlank()) {
                throw ApiException.validation("scope=player는 playerId가 필요합니다");
            }
            // 로스터(선발+벤치 — 후반 투입 가능 인원 포함) 소속 검증
            Set<String> roster = snapshotPlayerIds(row);
            if (!roster.contains(playerId)) {
                throw ApiException.validation("매치 로스터에 없는 선수입니다: " + playerId);
            }
        }

        upsertPrompt(matchId, phase, scope, playerId, request.text());
        return row;
    }

    /**
     * UPSERT — ERD UNIQUE(match_id, phase, scope, player_id)는 player_id NULL(team 행)을
     * 중복 허용하므로(SQLite NULL 규칙) 코드 레벨 UPDATE→INSERT로 두 scope 모두 처리.
     */
    private void upsertPrompt(String matchId, String phase, String scope, String playerId, String text) {
        txRunner.run(() -> {
            int updated = playerId == null
                    ? jdbcClient.sql("""
                                    UPDATE match_prompts SET text = ? WHERE match_id = ? AND phase = ?
                                    AND scope = ? AND player_id IS NULL
                                    """)
                            .params(text, matchId, phase, scope).update()
                    : jdbcClient.sql("""
                                    UPDATE match_prompts SET text = ? WHERE match_id = ? AND phase = ?
                                    AND scope = ? AND player_id = ?
                                    """)
                            .params(text, matchId, phase, scope, playerId).update();
            if (updated == 0) {
                jdbcClient.sql("""
                                INSERT INTO match_prompts(match_id, phase, scope, player_id, text, created_at)
                                VALUES (?, ?, ?, ?, ?, ?)
                                """)
                        .params(matchId, phase, scope, playerId, text, Instant.now().toString())
                        .update();
            }
        });
    }

    // ── 킥오프 / 재개 / 재시도 (CAS만 — 잡 enqueue는 Orchestrator) ───────

    public MatchRow kickoffCas(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        if (!casTransition(matchId, S_BRIEFING, S_GEN1)) {
            throw invalidState(currentState(matchId), "kickoff");
        }
        return getOwned(userId, matchId);
    }

    public MatchRow resumeCas(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        if (!casTransition(matchId, S_H1_BREAK, S_GEN2)) {
            throw invalidState(currentState(matchId), "resume");
        }
        return getOwned(userId, matchId);
    }

    /** FAILED → 실패 지점 재큐잉 (AC-M7). 반환 = 다시 돌릴 half. */
    public int retryCas(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        int half = jdbcClient.sql("SELECT COUNT(*) FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(Long.class).single() > 0 ? 2 : 1;
        String target = half == 1 ? S_GEN1 : S_GEN2;
        boolean ok = jdbcClient.sql(
                        "UPDATE matches SET state = ?, fail_reason = NULL WHERE id = ? AND state = 'FAILED'")
                .params(target, matchId)
                .update() == 1;
        if (!ok) {
            throw invalidState(currentState(matchId), "retry");
        }
        // 실패한/미완 잡 재큐잉: done이 아닌 해당 half 잡을 queued로 리셋(수동 재시도 = attempts 초기화).
        // F1(W3 검증 발견 레이스): created_at도 now로 리셋한다. timedOutGenMatches는 GEN 타임아웃을
        // created_at 기준(=현재 pending 사이클 시작 시각)으로 판정하는데, 리셋하지 않으면 timeout으로
        // FAILED됐던 매치를 유저가 retry한 순간 잡의 created_at이 여전히 과거라 즉시 재-타임아웃 자격을
        // 얻어 다음 sweep(≤10s)이 실 서번트(초~분 지연)가 완료하기도 전에 다시 FAILED시킨다.
        // updated_at 기준으로 바꾸지 않는 이유: updated_at은 lease/재큐잉마다 갱신되므로 죽은 워커의
        // lease 만료→재배포가 반복되면 타임아웃 데드라인이 무한정 밀려 타임아웃 자체가 무력화된다.
        // created_at = "현재 pending 사이클 시작"으로 두고 retry에서만 리셋하는 게 lease churn에 면역이다.
        jdbcClient.sql("""
                        UPDATE ai_jobs SET status = 'queued', attempts = 0, error = NULL,
                               lease_until = NULL, worker_id = NULL,
                               created_at = ?, updated_at = ?
                        WHERE match_id = ? AND half = ? AND status != 'done'
                        """)
                .params(Instant.now().toString(), Instant.now().toString(), matchId, half)
                .update();
        return half;
    }

    private String currentState(String matchId) {
        return jdbcClient.sql("SELECT state FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    // ── 하프타임 교체 (AC-M4, LLD §5.4 — 저장만, 전이 없음) ─────────────

    public record Substitution(String out, String in) {
    }

    public MatchRow submitHalftime(String userId, String matchId, List<Substitution> substitutions) {
        MatchRow row = getOwned(userId, matchId);
        if (!row.state().equals(S_H1_BREAK)) {
            throw invalidState(row.state(), "halftime");
        }
        List<Substitution> subs = substitutions == null ? List.of() : substitutions;

        if (subs.size() > halftimeSubsMax) {
            throw subsInvalid("교체는 최대 " + halftimeSubsMax + "명입니다",
                    Map.of("rule", "SUBS_MAX", "count", subs.size(), "max", halftimeSubsMax));
        }

        JsonNode snapshot = readJson(row.userDeckJson());
        Map<String, Integer> starterSlots = new LinkedHashMap<>();
        for (JsonNode s : snapshot.path("starters")) {
            starterSlots.put(s.path("playerId").asText(), s.path("slotIndex").asInt());
        }
        Set<String> bench = new HashSet<>();
        for (JsonNode b : snapshot.path("bench")) {
            bench.add(b.path("playerId").asText());
        }

        Set<String> outs = new HashSet<>();
        Set<String> ins = new HashSet<>();
        for (Substitution sub : subs) {
            if (sub.out() == null || sub.in() == null) {
                throw subsInvalid("out/in이 비어 있습니다", Map.of("rule", "SUB_FIELDS_REQUIRED"));
            }
            if (!starterSlots.containsKey(sub.out())) {
                throw subsInvalid("out은 전반 선발이어야 합니다: " + sub.out(),
                        Map.of("rule", "OUT_NOT_STARTER", "playerId", sub.out()));
            }
            if (!bench.contains(sub.in())) {
                throw subsInvalid("in은 벤치 선수여야 합니다: " + sub.in(),
                        Map.of("rule", "IN_NOT_BENCH", "playerId", sub.in()));
            }
            if (!outs.add(sub.out())) {
                throw subsInvalid("같은 선수를 두 번 뺄 수 없습니다: " + sub.out(),
                        Map.of("rule", "DUPLICATE_OUT", "playerId", sub.out()));
            }
            if (!ins.add(sub.in())) {
                throw subsInvalid("같은 선수를 두 번 넣을 수 없습니다: " + sub.in(),
                        Map.of("rule", "DUPLICATE_IN", "playerId", sub.in()));
            }
        }

        // 교체 후 GK ≥ 1 (AC-M4)
        Map<String, String> positions = positionsOf(unionOf(starterSlots.keySet(), ins));
        long gkAfter = starterSlots.keySet().stream()
                .map(pid -> outs.contains(pid) ? swapIn(subs, pid) : pid)
                .filter(pid -> "GK".equals(positions.get(pid)))
                .count();
        if (gkAfter < 1) {
            throw subsInvalid("교체 후에도 GK가 최소 1명 필요합니다", Map.of("rule", "GK_REQUIRED"));
        }

        String subsJson = toJson(subs);
        txRunner.run(() -> jdbcClient.sql("UPDATE matches SET subs_json = ? WHERE id = ? AND state = 'H1_BREAK'")
                .params(subsJson, matchId)
                .update());
        return getOwned(userId, matchId);
    }

    private static String swapIn(List<Substitution> subs, String outId) {
        return subs.stream().filter(s -> s.out().equals(outId)).findFirst().map(Substitution::in).orElse(outId);
    }

    private static ApiException subsInvalid(String message, Map<String, Object> detail) {
        return new ApiException(HttpStatus.BAD_REQUEST, "SUBSTITUTION_INVALID", message, detail);
    }

    private Map<String, String> positionsOf(Set<String> playerIds) {
        Map<String, String> positions = new HashMap<>();
        if (playerIds.isEmpty()) {
            return positions;
        }
        String in = String.join(",", playerIds.stream().map(p -> "?").toList());
        jdbcClient.sql("SELECT id, position FROM players WHERE id IN (" + in + ")")
                .params(List.copyOf(playerIds))
                .query((rs, n) -> Map.entry(rs.getString("id"), rs.getString("position")))
                .list()
                .forEach(e -> positions.put(e.getKey(), e.getValue()));
        return positions;
    }

    private static Set<String> unionOf(Set<String> a, Set<String> b) {
        Set<String> union = new HashSet<>(a);
        union.addAll(b);
        return union;
    }

    // ── half 로그 / 결과 ────────────────────────────────────────────────

    /** GET halves/{n}/log — H1_BREAK(1) / FINISHED(1,2) 외 409, 데이터 없으면 404. */
    public String halfLogJson(String userId, String matchId, int half) {
        MatchRow row = getOwned(userId, matchId);
        boolean allowed = (row.state().equals(S_H1_BREAK) && half == 1)
                || row.state().equals(S_FINISHED);
        if (!allowed) {
            throw invalidState(row.state(), "halves/" + half + "/log");
        }
        return jdbcClient.sql("SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half)
                .query(String.class)
                .optional()
                .orElseThrow(() -> ApiException.notFound("해당 half 로그가 없습니다"));
    }

    public record MatchResult(String matchId, int scoreHome, int scoreAway, String result,
                               long pointsAwarded, Map<String, Object> teamStats,
                               List<Map<String, Object>> playerStats) {
    }

    public MatchResult result(String userId, String matchId) {
        MatchRow row = getOwned(userId, matchId);
        if (!row.state().equals(S_FINISHED)) {
            throw invalidState(row.state(), "result");
        }

        long pointsAwarded = jdbcClient.sql("""
                        SELECT COALESCE(SUM(delta), 0) FROM point_ledger
                        WHERE user_id = ? AND ref_id = ? AND reason LIKE 'reward_%'
                        """)
                .params(userId, matchId)
                .query(Long.class)
                .single();

        // 팀/선수 스탯 — 저장된 h1+h2 MatchLog events에서 파생 (최소 스펙, 상세는 뷰어/웹 몫)
        Map<String, Long> teamCounters = new LinkedHashMap<>();
        Map<String, Map<String, Object>> perPlayer = new LinkedHashMap<>();
        for (int half = 1; half <= 2; half++) {
            String logJson = jdbcClient.sql(
                            "SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                    .params(matchId, half)
                    .query(String.class)
                    .optional()
                    .orElse(null);
            if (logJson == null) {
                continue;
            }
            for (JsonNode event : readJson(logJson).path("events")) {
                String type = event.path("type").asText();
                String team = event.path("team").asText("");
                if (List.of("shot", "goal", "pass", "save", "foul").contains(type) && !team.isEmpty()) {
                    teamCounters.merge(team + "_" + type + "s", 1L, Long::sum);
                }
                String playerId = event.path("playerId").asText("");
                if (!playerId.isEmpty() && List.of("shot", "goal", "pass", "save").contains(type)) {
                    Map<String, Object> stats = perPlayer.computeIfAbsent(playerId, id -> {
                        Map<String, Object> m = new LinkedHashMap<>();
                        m.put("playerId", id);
                        return m;
                    });
                    stats.merge(type + "s", 1L, (a, b) -> ((Number) a).longValue() + 1);
                }
            }
        }

        return new MatchResult(matchId, row.scoreHome(), row.scoreAway(), row.result(),
                pointsAwarded, Map.copyOf(teamCounters), List.copyOf(perPlayer.values()));
    }

    // ── 스냅샷/JSON 헬퍼 ────────────────────────────────────────────────

    public Set<String> snapshotPlayerIds(MatchRow row) {
        JsonNode snapshot = readJson(row.userDeckJson());
        Set<String> ids = new HashSet<>();
        snapshot.path("starters").forEach(s -> ids.add(s.path("playerId").asText()));
        snapshot.path("bench").forEach(s -> ids.add(s.path("playerId").asText()));
        return ids;
    }

    public JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException("JSON 파싱 실패: " + e.getMessage(), e);
        }
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
