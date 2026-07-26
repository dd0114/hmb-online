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
 * 롤백 스위치 {@code hmb.match.delta.enabled=false} (#193 라운드2).
 *
 * <p>끄면 <b>델타 기능 전체</b>가 사라진다 — 잡 컨텍스트에 {@code promptDelta} 를 싣지 않고(=실행기가
 * 풀 컨텍스트 패치 프롬프트로 폴백), 그 위에 얹힌 <b>대변경 라우팅도 돌지 않는다</b>(라우팅의 입력이
 * 델타이므로). 즉 델타 도입 이전의 "베이스 위 풀 패치" 동작으로 되돌아간다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchDeltaDisabledTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.delta.enabled", () -> "false"); // 이 클래스의 주제
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

    /** 팀 지시를 통째로 갈아엎어도(=켜져 있으면 대변경) 풀 패치 그대로다. */
    @Test
    void kickoffKeepsTheFullPatchWithoutDeltaOrRouting() {
        String token = setupUserWithDeck("delta_off");
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain(); // A 준비

        // 라인·콤팩트·측면 3축 = 켜져 있으면 대변경(임계 3) — 꺼져 있으니 패치 그대로여야 한다.
        submitTeamPrompt(token, matchId, "pre", "이제 수비적으로 전환한다. 라인을 내리고 콤팩트하게, 역습 시에만 측면 빠르게.");

        JsonNode ctx = jobContext(matchId, 1, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input-patch"); // 라우팅 안 함
        assertThat(ctx.path("base").isObject()).isTrue();                     // 베이스 위 패치
        assertThat(ctx.has("promptDelta")).isFalse();                         // 델타 미첨부
        assertThat(ctx.has("effortHint")).isFalse();
        // 풀 컨텍스트(기존 필드)는 그대로 — 실행기가 이걸로 패치를 만든다.
        assertThat(ctx.path("teamPrompt").asText())
                .isEqualTo("이제 수비적으로 전환한다. 라인을 내리고 콤팩트하게, 역습 시에만 측면 빠르게.");

        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 하프타임 대변경(압박·라인·오버랩 3축 = 라운드2 K1 실문장)도 마찬가지 — 패치 유지.
        submitTeamPrompt(token, matchId, "halftime",
                "완전히 바꾼다. 초공격 전방압박, 라인 최대로 올리고 전원 압박. 풀백 오버랩 적극.");
        JsonNode h2 = jobContext(matchId, 2, "home");
        assertThat(h2.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(h2.has("promptDelta")).isFalse();
        assertThat(h2.has("effortHint")).isFalse();
    }
}
