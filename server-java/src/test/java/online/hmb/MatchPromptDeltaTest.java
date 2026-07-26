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
 * promptDelta — B(패치) 잡 컨텍스트의 지시 변경분 (#193 W2b-B2, shared {@code PromptDelta} 계약).
 *
 * <p>계약: {@code promptDelta = {team?:{old,new}, players?:{playerId:{old?,new?}}}} — <b>달라진 것만</b>
 * 싣는다. old = 베이스가 실제로 쓴 지시(킥오프면 A 잡의 덱 사전 프롬프트, 후반이면 전반에 유효했던
 * 지시), new = 그 시점 매치 프롬프트. 아무 것도 안 달라졌으면 필드 자체가 없다(후방 호환 = 실행기가
 * 기존 풀 컨텍스트 경로로 돈다). 기존 컨텍스트 필드(teamPrompt·playerPrompts·base)는 그대로 유지된다.
 *
 * <p>시계는 주제가 아니라 끈다(§7.7 롤백 경로 = 전반 시뮬 직후 곧바로 감독시간).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchPromptDeltaTest extends MatchTestBase {

    /** 덱(A 베이스)에 미리 박혀 있는 선발 P002 의 지시 — 델타의 old 가 되는 값. */
    private static final String DECK_P002 = "뒤로 처져서 커버";

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
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

    /** 선발 P002 에 덱 프롬프트가 있는 덱 — 델타의 "수정(old→new)" 케이스를 만들 수 있다. */
    private String setupUserWithPromptedDeck(String nickname) {
        String token = login(nickname);
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        slots.add(slot("P002", "starter", 1, DECK_P002));
        for (int i = 3; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "벤치 프롬프트"));
        assertThat(authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        return token;
    }

    /** A(덱 베이스) 캐시를 채운 매치 — 이 상태에서 킥오프하면 B 패치 경로로 간다. */
    private String matchWithWarmBase(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        fakeServants.drain(); // 유저 A + 봇 A done
        return matchId;
    }

    private void submitPrompt(String token, String matchId, String phase, String scope,
                              String playerId, String text) {
        Map<String, Object> body = playerId == null
                ? Map.of("phase", phase, "scope", scope, "text", text)
                : Map.of("phase", phase, "scope", scope, "playerId", playerId, "text", text);
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token, body, Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** 해당 half·side 의 <b>유일한</b> 잡 컨텍스트(패치 경로 검증이라 단일이어야 한다). */
    private JsonNode jobContext(String matchId, int half, String side) {
        String json = jdbcClient.sql(
                        "SELECT context_json FROM ai_jobs WHERE match_id = ? AND half = ? AND side = ?")
                .params(matchId, half, side).query(String.class).single();
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 오브젝트 노드의 키 목록(Jackson 버전 무관 — properties() 로 수집). */
    private static List<String> keysOf(JsonNode node) {
        List<String> keys = new ArrayList<>();
        node.properties().forEach(e -> keys.add(e.getKey()));
        return keys;
    }

    private JsonNode kickoffPatchContext(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        JsonNode context = jobContext(matchId, 1, "home");
        assertThat(context.path("kind").asText()).isEqualTo("team-input-patch");
        return context;
    }

    // ── T-a: 킥오프 델타는 변경분만 담는다 ────────────────────────────────

    @Test
    void teamOnlyChangeYieldsTeamDeltaWithoutPlayers() {
        String token = setupUserWithPromptedDeck("delta_team");
        String matchId = matchWithWarmBase(token);
        submitPrompt(token, matchId, "pre", "team", null, "전원 압박, 라인 올려");

        JsonNode delta = kickoffPatchContext(token, matchId).path("promptDelta");

        // 팀 지시만 바뀌었다: 베이스(A)엔 팀 지시가 없었으므로 old="" → new=제출값.
        assertThat(delta.isObject()).isTrue();
        assertThat(delta.path("team").path("old").asText()).isEmpty();
        assertThat(delta.path("team").path("new").asText()).isEqualTo("전원 압박, 라인 올려");
        // 선수 지시는 덱 그대로 = 변경 없음 → players 키 자체가 없다.
        assertThat(delta.has("players")).isFalse();
    }

    @Test
    void addedAndEditedPlayerPromptsYieldOnlyThoseEntries() {
        String token = setupUserWithPromptedDeck("delta_player");
        String matchId = matchWithWarmBase(token);
        submitPrompt(token, matchId, "pre", "player", "P002", "앞으로 나가서 압박"); // 덱 지시 수정
        submitPrompt(token, matchId, "pre", "player", "P003", "오버랩 자제");       // 신규(덱 지시 없음)

        JsonNode delta = kickoffPatchContext(token, matchId).path("promptDelta");

        assertThat(delta.has("team")).isFalse(); // 팀 지시는 안 냈다
        JsonNode players = delta.path("players");
        assertThat(keysOf(players)).containsExactlyInAnyOrder("P002", "P003");
        // 수정 = old/new 둘 다
        assertThat(players.path("P002").path("old").asText()).isEqualTo(DECK_P002);
        assertThat(players.path("P002").path("new").asText()).isEqualTo("앞으로 나가서 압박");
        // 신규 = new 만(old 키 없음)
        assertThat(players.path("P003").has("old")).isFalse();
        assertThat(players.path("P003").path("new").asText()).isEqualTo("오버랩 자제");
    }

    @Test
    void unchangedPromptOmitsTheDeltaFieldEntirely() {
        String token = setupUserWithPromptedDeck("delta_none");
        String matchId = matchWithWarmBase(token);
        // 덱과 **같은 값**을 다시 제출 — 매치 프롬프트는 존재하지만(=B 경로) 실질 변경은 0.
        submitPrompt(token, matchId, "pre", "player", "P002", DECK_P002);

        JsonNode context = kickoffPatchContext(token, matchId);

        assertThat(context.has("promptDelta")).isFalse();
        // 기존 필드는 그대로 — 실행기가 풀 컨텍스트 경로로 폴백할 수 있어야 한다(후방 호환).
        assertThat(context.path("base").isObject()).isTrue();
        assertThat(context.path("playerPrompts").path("P002").asText()).isEqualTo(DECK_P002);
        assertThat(context.path("teamPrompt").asText()).isEmpty();
    }

    // ── 후반 델타: old = 전반에 유효했던 지시, new = 하프타임 지시 ──────────

    @Test
    void secondHalfDeltaComparesAgainstFirstHalfInstructions() {
        String token = setupUserWithPromptedDeck("delta_h2");
        String matchId = matchWithWarmBase(token);
        submitPrompt(token, matchId, "pre", "team", null, "하이라인·와이드");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain(); // 킥오프 B + 전반 시뮬 → (시계 꺼짐) 감독시간
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        submitPrompt(token, matchId, "halftime", "team", null, "로우블록으로 전환");
        submitPrompt(token, matchId, "halftime", "player", "P002", "왼쪽만 막아");

        JsonNode delta = jobContext(matchId, 2, "home").path("promptDelta");

        // 팀: 전반 지시(pre) → 하프타임 지시. 베이스("")가 아니라 **전반에 유효했던 값**이 old 다.
        assertThat(delta.path("team").path("old").asText()).isEqualTo("하이라인·와이드");
        assertThat(delta.path("team").path("new").asText()).isEqualTo("로우블록으로 전환");
        // 선수: 하프타임에 바꾼 P002 만. 나머지 10명은 전반과 동일하므로 델타에 없다.
        JsonNode players = delta.path("players");
        assertThat(keysOf(players)).containsExactly("P002");
        assertThat(players.path("P002").path("old").asText()).isEqualTo(DECK_P002);
        assertThat(players.path("P002").path("new").asText()).isEqualTo("왼쪽만 막아");
    }

    /** 봇 사이드는 매치시점 입력이 없어 B 자체가 없다 — 델타도 붙지 않는다(회귀 가드). */
    @Test
    void botSideNeverGetsAPatchOrDelta() {
        String token = setupUserWithPromptedDeck("delta_bot");
        String matchId = matchWithWarmBase(token);
        submitPrompt(token, matchId, "pre", "team", null, "전원 압박");
        kickoffPatchContext(token, matchId);

        JsonNode botContext = jobContext(matchId, 1, "away");
        assertThat(botContext.path("kind").asText()).isEqualTo("materialized"); // 재사용(콜0)
        assertThat(botContext.has("promptDelta")).isFalse();
    }
}
