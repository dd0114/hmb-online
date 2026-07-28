package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.List;
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
 * 롤백 스위치 {@code hmb.match.delta.reuse-on-no-change=false} (#253).
 *
 * <p><b>왜 스위치가 있나</b>(독립검증 major-1): 켜져 있으면 "유효 지시가 베이스와 같다"를 콜0(재사용)로
 * 처리하는데, 재사용이 쓰는 A 컨텍스트는 덱만 안다 — {@code opponentRoster}·{@code conditions}·
 * {@code relations}·{@code teamMorale} 이 없다(A 는 매치보다 먼저 만들어지므로 원리상 가질 수 없다).
 * 지연·비용을 얻고 상대 인지를 내주는 트레이드오프라, <b>코드가 아니라 config 로</b> 되돌릴 수 있어야 한다.
 *
 * <p>끄면 #253 이전 라우팅으로 돌아간다: 매치 시점 지시가 있으면 내용이 베이스와 같아도 B 패치를 태우고,
 * 그 패치 컨텍스트에는 상대 로스터 등 매치 시점 정보가 실린다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class ReuseOnNoChangeDisabledTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        registry.add("hmb.match.delta.reuse-on-no-change", () -> "false"); // 이 클래스의 주제
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private ObjectMapper objectMapper;

    private void putDeckWithTeamPrompt(String token, String teamPrompt) {
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        assertThat(authPut("/api/deck", token,
                Map.of("formation", "4-4-2", "teamPrompt", teamPrompt, "slots", slots), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    @Test
    void switchedOffTheSameSentenceGoesBackToThePatchPath() {
        String token = login("reuse_off");
        putDeckWithTeamPrompt(token, "측면 활용해라");
        fakeServants.drain();
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain();

        // 덱 문장을 그대로 다시 제출 — 스위치가 켜져 있으면 콜0(DeckTeamPromptTest), 꺼져 있으면 패치.
        authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "측면 활용해라"), Map.class);
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        String contextJson = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = 'home' AND effective = 1
                        """)
                .param(matchId).query(String.class).single();
        JsonNode context;
        try {
            context = objectMapper.readTree(contextJson);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }

        assertThat(context.path("kind").asText()).isEqualTo("team-input-patch");
        // 스위치를 끄고 얻는 것 = 이 매치 시점 컨텍스트다(재사용 경로엔 없다). 그게 이 노브의 존재 이유다.
        assertThat(context.has("opponentRoster")).isTrue();
        assertThat(context.has("teamMorale")).isTrue();
    }
}
