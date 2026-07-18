package online.hmb;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.List;
import online.hmb.common.Hashes;
import online.hmb.jobs.AiJobQueue;

/**
 * 테스트용 가짜 AI실행기 (LLD §8 "test fixture — 가짜 서번트가 즉시 complete 콜백").
 * queued 잡을 순회하며 컨텍스트에서 결정론 TacticalInput을 만들어 complete한다.
 * complete → AiJobQueue → MatchOrchestrator.onJobDone → (가짜 러너) simulate → 전이까지
 * 테스트 스레드에서 동기로 진행된다.
 *
 * 생성 JSON은 packages/shared/src/tactical-input.ts zod 스키마를 **필드 단위로 그대로** 미러:
 * {seed, team{formation, defensiveLineHeight, compactness, tempo, width,
 *   pressingScheme{intensity, triggerLine}, offsideTrap}, players[11]{playerId, role, duty,
 *   basePosition{x,y}, behavior{positioningFreedom, forwardRunFreq, widthTendency, supportDepth,
 *   pressAggression, passRisk, passDirectness, dribbleTendency, shootTendency}, mentalModifier},
 * meta{promptHash}} — W4에서 이 형태가 zod 경계를 실제로 통과한다.
 * 값은 hash(seed:playerId:field[:prompt]) 파생 — ts stub 의미론(시드 결정 파라미터)을 느슨히 미러.
 */
public class FakeServants {

    private static final String USAGE_JSON =
            "{\"inputTokens\":0,\"outputTokens\":0,\"cacheReadTokens\":0,\"cacheCreateTokens\":0,\"costUSD\":0}";
    private static final List<String> BEHAVIOR_FIELDS = List.of(
            "positioningFreedom", "forwardRunFreq", "widthTendency", "supportDepth",
            "pressAggression", "passRisk", "passDirectness", "dribbleTendency", "shootTendency");

    private final AiJobQueue jobQueue;
    private final ObjectMapper objectMapper;

    public FakeServants(AiJobQueue jobQueue, ObjectMapper objectMapper) {
        this.jobQueue = jobQueue;
        this.objectMapper = objectMapper;
    }

    /** queued 잡 전부 처리(신규 enqueue가 생기면 반복). @return 처리한 잡 수 */
    public int drain() {
        int processed = 0;
        while (true) {
            List<AiJobQueue.JobRow> jobs = jobQueue.queuedJobs();
            if (jobs.isEmpty()) {
                return processed;
            }
            for (AiJobQueue.JobRow job : jobs) {
                jobQueue.complete(job.id(), true, stubTacticalInput(job.contextJson()), USAGE_JSON, null);
                processed++;
            }
        }
    }

    /** 컨텍스트 → 결정론 TacticalInput JSON (shared zod 스키마 미러). */
    public String stubTacticalInput(String contextJson) {
        try {
            JsonNode context = objectMapper.readTree(contextJson);

            // B(패치) 잡: 실행기 계약 = complete 가 **완전한 TacticalInput** 을 반환(패치는 실행기 내부 세부).
            // Fake 는 base(A 결과)에 applyPatch(빈 패치, {seed}) = base + seed 교체 를 흉내 → 완전 인풋 반환.
            if ("team-input-patch".equals(context.path("kind").asText())) {
                JsonNode base = context.path("base");
                if (!base.isObject()) {
                    throw new IllegalStateException("team-input-patch 컨텍스트에 base(TacticalInput) 누락");
                }
                ObjectNode merged = base.deepCopy();
                merged.put("seed", context.path("seed").asText()); // halfSeed 주입(applyPatch seed 통과).
                return objectMapper.writeValueAsString(merged);
            }

            String seed = context.path("seed").asText();
            String teamPrompt = context.path("teamPrompt").asText("");

            ObjectNode input = objectMapper.createObjectNode();
            input.put("seed", seed);

            ObjectNode team = input.putObject("team");
            team.put("formation", context.path("formation").asText());
            team.put("defensiveLineHeight", ranged(seed + ":team:line:" + teamPrompt));
            team.put("compactness", ranged(seed + ":team:compact:" + teamPrompt));
            team.put("tempo", ranged(seed + ":team:tempo:" + teamPrompt));
            team.put("width", ranged(seed + ":team:width:" + teamPrompt));
            ObjectNode pressing = team.putObject("pressingScheme");
            pressing.put("intensity", ranged(seed + ":team:press:" + teamPrompt));
            pressing.put("triggerLine", ranged(seed + ":team:trigger:" + teamPrompt));
            team.put("offsideTrap", false);

            ArrayNode players = input.putArray("players");
            for (JsonNode member : context.path("roster")) {
                String playerId = member.path("playerId").asText();
                String position = member.path("position").asText();
                int slotIndex = member.path("slotIndex").asInt();
                String prompt = context.path("playerPrompts").path(playerId).asText("");

                ObjectNode player = players.addObject();
                player.put("playerId", playerId);
                player.put("role", position);
                player.put("duty", switch (position) {
                    case "FW" -> "attack";
                    case "MF" -> "support";
                    default -> "defend";
                });
                ObjectNode basePosition = player.putObject("basePosition");
                basePosition.put("x", switch (position) {
                    case "GK" -> 0.05;
                    case "DF" -> 0.25;
                    case "MF" -> 0.5;
                    default -> 0.75;
                });
                basePosition.put("y", Math.round((0.1 + 0.8 * slotIndex / 10.0) * 1000) / 1000.0);

                ObjectNode behavior = player.putObject("behavior");
                for (String field : BEHAVIOR_FIELDS) {
                    behavior.put(field, frac(seed + ":" + playerId + ":" + field + ":" + prompt));
                }
                player.put("mentalModifier", 0);
            }

            ObjectNode meta = input.putObject("meta");
            meta.put("promptHash", Hashes.sha256Hex(contextJson).substring(0, 16));

            return objectMapper.writeValueAsString(input);
        } catch (Exception e) {
            throw new IllegalStateException("stub TacticalInput 생성 실패", e);
        }
    }

    /** hash → 0..1 (소수 3자리). */
    private static double frac(String input) {
        long value = Long.parseLong(Hashes.sha256Hex(input).substring(0, 8), 16);
        return Math.round(value / (double) 0xFFFFFFFFL * 1000) / 1000.0;
    }

    /** hash → 0.3..0.7 (팀 파라미터 안전 범위). */
    private static double ranged(String input) {
        return Math.round((0.3 + 0.4 * frac(input)) * 1000) / 1000.0;
    }
}
