package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
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
 * 하프타임 교체 — AC-M4 위반 매트릭스 + 교체 경로 E2E(LLD §5.4: resumeState 생략 = 독립 시뮬,
 * 슬롯 승계). 유저 덱: 선발 P001(GK)+P002..P011, 벤치 P012,P013.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchSubsTest extends MatchTestBase {

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

    private String driveToH1Break(String nickname) {
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("H1_BREAK");
        return token + "|" + matchId;
    }

    private ResponseEntity<Map> postSubs(String token, String matchId, List<Map<String, String>> subs) {
        return authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", subs), Map.class);
    }

    @Test
    void subsVariantRunsIndependentH2SimulationWithSlotInheritance() throws Exception {
        String[] parts = driveToH1Break("m_subs").split("\\|");
        String token = parts[0];
        String matchId = parts[1];

        // P002(DF, slot1) → P012(FW 벤치) 교체
        ResponseEntity<Map> subs = postSubs(token, matchId,
                List.of(Map.of("out", "P002", "in", "P012")));
        assertThat(subs.getStatusCode()).isEqualTo(HttpStatus.OK);

        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");

        // 교체 있음 → h2 러너 요청에 resumeState 없음 (독립 시뮬, LLD §5.4)
        JsonNode h2Request = RUNNER.lastRequestForHalf(2);
        assertThat(h2Request.has("resumeState")).isFalse();

        // SelectData 슬롯 승계: home 로스터에 P012 있음, P002 없음
        JsonNode homePlayers = h2Request.path("selectData").path("home").path("players");
        List<String> ids = new java.util.ArrayList<>();
        homePlayers.forEach(p -> ids.add(p.path("playerId").asText()));
        assertThat(ids).contains("P012").doesNotContain("P002").hasSize(11);

        // 저장된 h2 번들에도 반영(홈 로스터 기준 — 봇(away) 로스터는 P002를 정상 보유)
        String h2SelectData = jdbcClient.sql(
                        "SELECT select_data_json FROM match_halves WHERE match_id = ? AND half = 2")
                .param(matchId).query(String.class).single();
        JsonNode storedHome = objectMapper.readTree(h2SelectData).path("home").path("players");
        List<String> storedHomeIds = new java.util.ArrayList<>();
        storedHome.forEach(p -> storedHomeIds.add(p.path("playerId").asText()));
        assertThat(storedHomeIds).contains("P012").doesNotContain("P002");

        String h2LastHash = jdbcClient.sql(
                        "SELECT last_hash FROM match_halves WHERE match_id = ? AND half = 2")
                .param(matchId).query(String.class).single();
        assertThat(h2LastHash).endsWith("-nosub");

        // h2 잡 컨텍스트 로스터에도 교체 반영
        String h2Context = jdbcClient.sql(
                        "SELECT context_json FROM ai_jobs WHERE match_id = ? AND half = 2 AND side = 'home'")
                .param(matchId).query(String.class).single();
        JsonNode roster = objectMapper.readTree(h2Context).path("roster");
        List<String> rosterIds = new java.util.ArrayList<>();
        roster.forEach(r -> rosterIds.add(r.path("playerId").asText()));
        assertThat(rosterIds).contains("P012").doesNotContain("P002");
    }

    @Test
    void substitutionViolationsRejected() {
        String[] parts = driveToH1Break("m_subs_bad").split("\\|");
        String token = parts[0];
        String matchId = parts[1];

        // 3명 초과 (config halftime-subs-max=3)
        assertSubsInvalid(postSubs(token, matchId, List.of(
                Map.of("out", "P002", "in", "P012"), Map.of("out", "P003", "in", "P013"),
                Map.of("out", "P004", "in", "P012"), Map.of("out", "P005", "in", "P013"))), "SUBS_MAX");

        // out이 선발이 아님
        assertSubsInvalid(postSubs(token, matchId,
                List.of(Map.of("out", "P012", "in", "P013"))), "OUT_NOT_STARTER");

        // in이 벤치가 아님
        assertSubsInvalid(postSubs(token, matchId,
                List.of(Map.of("out", "P002", "in", "P003"))), "IN_NOT_BENCH");

        // GK 아웃 → GK 0 (AC-M4)
        assertSubsInvalid(postSubs(token, matchId,
                List.of(Map.of("out", "P001", "in", "P012"))), "GK_REQUIRED");

        // 같은 선수 중복 아웃
        assertSubsInvalid(postSubs(token, matchId, List.of(
                Map.of("out", "P002", "in", "P012"), Map.of("out", "P002", "in", "P013"))), "DUPLICATE_OUT");

        // 위반들이 상태를 바꾸지 않음 + 유효 교체는 통과
        assertThat(matchState(matchId)).isEqualTo("H1_BREAK");
        assertThat(postSubs(token, matchId, List.of(Map.of("out", "P002", "in", "P012")))
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    private static void assertSubsInvalid(ResponseEntity<Map> response, String rule) {
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("SUBSTITUTION_INVALID");
        assertThat(((Map<?, ?>) response.getBody().get("detail")).get("rule")).isEqualTo(rule);
    }
}
