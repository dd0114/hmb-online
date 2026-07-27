package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 라우팅 노브가 <b>진짜 config</b>인지 (#193 라운드2, 루트 §2-4 하드코딩 금지).
 *
 * <p>축 임계를 1 로 <b>낮추면</b> 한 축만 건드리는 소변경(기본 임계 3 에서는 델타로 남는다)까지 대변경으로
 * 넘어가고, 그때 실리는 {@code effortHint} 는 yml 값(여기선 "high") 그대로여야 한다. 반대로 축 개수보다
 * 큰 값(99)은 <b>라우팅만 끄는</b> 스위치다(델타는 유지). 임계·effort 가 코드에 박혀 있으면 여기서 깨진다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchOverhaulKnobsTest extends MatchTestBase {

    private static final String PRE_TEAM =
            "전방압박을 강하게 유지하되 뒤 공간이 열리면 라인을 내려라. 측면 전환 빠르게, 박스 안에서는 슛보다 확실한 각을 만들어라.";
    /** 기본 임계(3축)에서는 델타로 남는 1축 소변경 — 임계를 1 로 낮추면 대변경이 된다. */
    private static final String HALFTIME_SMALL_EDIT = "템포만 조금 올려라. 나머지는 유지.";

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.delta.overhaul-axis-count", () -> "1"); // 1축 변경도 대변경 취급
        registry.add("hmb.match.delta.overhaul-effort", () -> "high");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private ObjectMapper objectMapper;

    private JsonNode jobContext(String matchId, int half, String side) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = ? AND effective = 1
                        """)
                .params(matchId, half, side).query(String.class).single();
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private void submitTeamPrompt(String token, String matchId, String phase, String text) {
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", phase, "scope", "team", "text", text), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void loweredAxisThresholdRoutesEvenASmallEditAndUsesTheConfiguredEffortHint() {
        String token = setupUserWithDeck("knobs");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();
        submitTeamPrompt(token, matchId, "pre", PRE_TEAM);
        fakeServants.drain();
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        submitTeamPrompt(token, matchId, "halftime", HALFTIME_SMALL_EDIT);

        JsonNode ctx = jobContext(matchId, 2, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input"); // 임계 1 → 1축 소변경도 대변경 취급
        assertThat(ctx.path("effortHint").asText()).isEqualTo("high"); // yml 값 그대로
    }
}
