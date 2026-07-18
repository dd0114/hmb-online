package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.match.ConditionService;
import online.hmb.match.RelationService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * W1(에픽 #94) 통합: 컨디션(AC-C1) · AI 컨텍스트 확장(AC-C2~C4) · 관계/사기(AC-C4) 를 풀 매치
 * 플로우(로그인→덱→매치[teamTactics]→킥오프→가짜서번트→...→FINISHED)로 검증한다.
 * FakeServants/FakeEngineRunner 패턴은 MatchFlowE2ETest 와 동일(WIN 결과 = h1 1-0, h2 0-0).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class Phase2W1FlowTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;
    @Resource
    private ObjectMapper objectMapper;
    @Resource
    private ConditionService conditionService;
    @Resource
    private RelationService relationService;

    private static Map<String, Object> tactics(double line, double press, double tempo, double width) {
        Map<String, Object> t = new LinkedHashMap<>();
        t.put("line", line);
        t.put("press", press);
        t.put("tempo", tempo);
        t.put("width", width);
        return t;
    }

    private String createMatchWithTactics(String token, String botId, Map<String, Object> tactics) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("botId", botId);
        body.put("teamTactics", tactics);
        ResponseEntity<Map> res = authPost("/api/matches", token, body, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        return (String) res.getBody().get("id");
    }

    @SuppressWarnings("unchecked")
    @Test
    void conditionsStoredMatchRecomputeAndExposedInGetMatch() {
        String token = setupUserWithDeck("w1_cond");
        String matchId = createMatchWithTactics(token, "BOT_BAL", tactics(0.7, 0.6, 0.55, 0.45));

        // 저장값 == 재계산 (AC-C1 재현)
        String seed = jdbcClient.sql("SELECT seed FROM matches WHERE id = ?").param(matchId)
                .query(String.class).single();
        JsonNode stored = readMatchJson(matchId, "conditions_json");
        assertThat(stored.size()).isEqualTo(13); // 선발11 + 벤치2
        stored.properties().forEach(e -> {
            double recomputed = conditionService.roll(seed, e.getKey());
            assertThat(e.getValue().asDouble()).as("condition " + e.getKey())
                    .isCloseTo(recomputed, org.assertj.core.data.Offset.offset(1e-9));
            assertThat(e.getValue().asDouble()).isBetween(0.0, 1.0);
        });

        // GET match 응답에 conditions + mode 노출
        ResponseEntity<Map> get = authGet("/api/matches/" + matchId, token, Map.class);
        Map<String, Object> conditions = (Map<String, Object>) get.getBody().get("conditions");
        assertThat(conditions).hasSize(13).containsKey("P001");
        assertThat(get.getBody().get("mode")).isEqualTo("practice");
    }

    @SuppressWarnings("unchecked")
    @Test
    void selectDataAppliesConditionMultiplierAndContextHasPhase2Fields() throws Exception {
        String token = setupUserWithDeck("w1_ctx");
        String matchId = createMatchWithTactics(token, "BOT_BAL", tactics(0.7, 0.6, 0.55, 0.45));

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();

        // ── AI 컨텍스트 additive 필드(openapi-v2 AiJobContextPhase2Fields 자구) ──
        String contextJson = jdbcClient.sql(
                        "SELECT context_json FROM ai_jobs WHERE match_id = ? AND half = 1 AND side = 'home'")
                .param(matchId).query(String.class).single();
        JsonNode ctx = objectMapper.readTree(contextJson);
        // manualTactics (create teamTactics 반영)
        assertThat(ctx.path("manualTactics").path("line").asDouble()).isEqualTo(0.7);
        assertThat(ctx.path("manualTactics").path("width").asDouble()).isEqualTo(0.45);
        // conditions (로스터 선수)
        assertThat(ctx.path("conditions").has("P001")).isTrue();
        // relations {playerId:{trust,personality}} — 경기 전이라 기본 trust 50, 성격 CALM(v1 fixture)
        assertThat(ctx.path("relations").path("P001").path("trust").asInt()).isEqualTo(50);
        assertThat(ctx.path("relations").path("P001").path("personality").asText()).isEqualTo("CALM");
        // teamMorale
        assertThat(ctx.path("teamMorale").path("morale").asInt()).isEqualTo(50);
        assertThat(ctx.path("teamMorale").path("streak").asInt()).isEqualTo(0);
        // opponentRoster (봇 선발 11 — 마킹용)
        assertThat(ctx.path("opponentRoster").isArray()).isTrue();
        assertThat(ctx.path("opponentRoster").size()).isEqualTo(11);
        assertThat(ctx.path("opponentRoster").get(0).has("playerId")).isTrue();
        assertThat(ctx.path("opponentRoster").get(0).has("position")).isTrue();

        // ── SelectData 능치 배율(AC-C1): home P001 technical == scaleAttribute(raw, condition) ──
        String selectDataJson = jdbcClient.sql(
                        "SELECT select_data_json FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single();
        JsonNode selectData = objectMapper.readTree(selectDataJson);
        JsonNode homeP001 = null;
        for (JsonNode p : selectData.path("home").path("players")) {
            if ("P001".equals(p.path("playerId").asText())) {
                homeP001 = p;
                break;
            }
        }
        assertThat(homeP001).isNotNull();
        int rawTechnical = readMatchJson(matchId, "conditions_json") != null ? 40 : 40; // fixture P001 technical=40
        double condP001 = readMatchJson(matchId, "conditions_json").path("P001").asDouble();
        int expected = conditionService.scaleAttribute(rawTechnical, condP001);
        assertThat(homeP001.path("attributes").path("technical").asInt()).isEqualTo(expected);
        // 배율 경계: min-mul 0.85 / max-mul 1.10 → 40×[0.85,1.10] = [34,44]
        assertThat(homeP001.path("attributes").path("technical").asInt()).isBetween(34, 44);
    }

    @SuppressWarnings("unchecked")
    @Test
    void relationsAndMoraleAppliedOnFinishIdempotently() {
        String token = setupUserWithDeck("w1_rel");
        String userId = userIdOf("w1_rel");
        String matchId = createMatchWithTactics(token, "BOT_BAL", tactics(0.5, 0.5, 0.5, 0.5));

        // 경기 전 관계 초기값 (첫 로그인 init)
        ResponseEntity<Map> before = authGet("/api/relations", token, Map.class);
        assertThat(before.getBody().get("morale")).isEqualTo(50);
        assertThat(before.getBody().get("streak")).isEqualTo(0);

        driveToFinished(token, matchId);
        assertThat(matchState(matchId)).isEqualTo("FINISHED");

        // WIN(1-0): 선발 +2(선발)+3(승) = 55, 벤치 +3(승) = 53, 미출전 보유(P014) = 50(1차 결장, 페널티 없음)
        ResponseEntity<Map> after = authGet("/api/relations", token, Map.class);
        assertThat(after.getBody().get("morale")).isEqualTo(58); // 50 + 8(승)
        assertThat(after.getBody().get("streak")).isEqualTo(1);
        Map<String, Integer> trust = trustMap((List<Map<String, Object>>) after.getBody().get("players"));
        assertThat(trust.get("P001")).isEqualTo(55); // 선발
        assertThat(trust.get("P012")).isEqualTo(53); // 벤치(승 전원)
        assertThat(trust.get("P014")).isEqualTo(50); // 미출전 보유(결장 1경기 — threshold 2 미달)

        // 멱등: FINISHED 매치에 재적용해도 변화 없음 (relations_applied 플래그 CAS)
        relationService.applyMatchResult(userId, matchId, "WIN");
        ResponseEntity<Map> after2 = authGet("/api/relations", token, Map.class);
        assertThat(after2.getBody().get("morale")).isEqualTo(58);
        Map<String, Integer> trust2 = trustMap((List<Map<String, Object>>) after2.getBody().get("players"));
        assertThat(trust2.get("P001")).isEqualTo(55);
    }

    // ── 헬퍼 ──────────────────────────────────────────────────────────────

    private void driveToFinished(String token, String matchId) {
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
    }

    private static Map<String, Integer> trustMap(List<Map<String, Object>> players) {
        Map<String, Integer> m = new LinkedHashMap<>();
        for (Map<String, Object> p : players) {
            m.put((String) p.get("playerId"), (Integer) p.get("trust"));
        }
        return m;
    }

    private JsonNode readMatchJson(String matchId, String column) {
        String json = jdbcClient.sql("SELECT " + column + " FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }
}
