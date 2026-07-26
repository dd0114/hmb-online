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
 * <b>팀 지시 대변경 → 풀생성 라우팅</b> (#193 라운드2 확정).
 *
 * <p>근거(블라인드 맞대결 라운드2): 팀 지시를 <b>갈아엎는</b> 변경(K1)에서는 델타가 파급을 반쪽만
 * 구현해 3.13 인데 풀생성은 4.75 였다. 반면 <b>소변경</b>(K2 — 델타 4.63 vs 풀 3.25)·<b>돌발</b>
 * (3.83~5.00 PASS)·<b>개인지시</b>(K3 4.00)는 델타가 동급 이상이다. 그래서 라우팅은 "대변경인
 * 사이드만 풀생성, 나머지는 델타"다.
 *
 * <p>감지 신호 = <b>새 팀 지시가 건드리는 전술 축의 개수</b>({@code OverhaulDetector}, 임계
 * {@code hmb.match.delta.overhaul-axis-count} 기본 3). 지표 자체의 판정표는 OverhaulDetectorTest 가
 * 박제하고, 이 클래스는 <b>그 판정이 실제 잡 컨텍스트로 이어지는지</b>를 본다.
 *
 * <p>박제하는 불변식:
 * ① 팀 지시 대변경 → 그 사이드 잡이 {@code kind=team-input}(풀생성) + {@code effortHint}(config)
 * ② 소변경 → 기존 델타 패치 유지({@code kind=team-input-patch} + promptDelta, effortHint 없음)
 * ③ 개인 지시만 바뀌면 팀 델타가 없으므로 라우팅 대상이 아니다(델타 유지)
 * ④ h1(킥오프)·h2(하프타임) 동일 규칙
 * ⑤ 유효 잡은 계속 1개(supersede 불변식 무손상)
 * ⑥ 일반 폴백 풀생성(A 미완 등)에는 effortHint 가 붙지 않는다.
 *
 * <p>시계는 주제가 아니라 끈다(§7.7 롤백 경로 = 전반 시뮬 직후 곧바로 감독시간).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchOverhaulRoutingTest extends MatchTestBase {

    /** 덱(A 베이스)에 박혀 있는 선발 P002 지시 — 개인지시 델타(③)의 old. */
    private static final String DECK_P002 = "뒤로 처져서 커버";

    /**
     * 전반 팀 지시(=h2 델타의 old). 라운드2 하네스의 "수정 전" 지시와 같은 형태 —
     * 압박·라인·측면(폭)·슛 <b>4축</b>이라 그 자체로 대변경이다.
     */
    private static final String PRE_TEAM =
            "전방압박을 강하게 유지하되 뒤 공간이 열리면 라인을 내려라. 측면 전환 빠르게, 박스 안에서는 슛보다 확실한 각을 만들어라.";

    /**
     * K2 형 소변경 — <b>라운드2 실문장</b>. 한 축(템포)만 손댄다 → 델타 유지(그 조건에서 델타 4.63 &gt;
     * 풀생성 3.25 였다). 하프타임 팀 프롬프트 textarea 는 빈 칸에서 시작하므로(HalftimePanel — 이전 지시
     * 프리필 없음) 실제 소변경 입력은 이렇게 <b>짧은 새 문장</b>이다.
     */
    private static final String HALFTIME_SMALL_EDIT = "템포만 조금 올려라. 나머지는 유지.";

    /** K1 형 대변경 — 라인·콤팩트·측면 <b>3축</b>을 한꺼번에 갈아엎는다. */
    private static final String HALFTIME_OVERHAUL =
            "이제 수비적으로 전환한다. 라인을 내리고 콤팩트하게, 역습 시에만 측면 빠르게.";

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        // 라우팅은 **기본값 그대로** 검증한다(임계·effort 를 테스트가 정하지 않는다) — 기본이 곧 계약.
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private ObjectMapper objectMapper;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

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

    /** (match, half, side) 유효 잡 컨텍스트 — 실제로 그 하프를 결정하는 행. */
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

    private long effectiveRows(String matchId, int half, String side) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = ? AND effective = 1
                        """)
                .params(matchId, half, side).query(Long.class).single();
    }

    private void kickoff(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
    }

    /** 전반을 끝내 감독시간까지 간 매치(전반 팀 지시 = PRE_TEAM). */
    private String matchAtHalftime(String token) {
        String matchId = matchWithWarmBase(token);
        submitPrompt(token, matchId, "pre", "team", null, PRE_TEAM);
        fakeServants.drain();
        kickoff(token, matchId);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        return matchId;
    }

    // ── ①/④ h1: 팀 지시 대변경(베이스엔 팀 지시가 없다) → 풀생성 + effortHint ──

    @Test
    void firstHalfTeamInstructionRoutesToFullGenerationWithEffortHint() {
        String token = setupUserWithPromptedDeck("route_h1_full");
        String matchId = matchWithWarmBase(token);

        // 압박·라인·측면·슛 4축을 한 번에 지시한다 = 대변경(임계 3).
        submitPrompt(token, matchId, "pre", "team", null, PRE_TEAM);

        JsonNode ctx = jobContext(matchId, 1, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input"); // 델타 패치가 아니라 풀생성
        assertThat(ctx.has("base")).isFalse();                          // 베이스 위 패치가 아니다
        assertThat(ctx.has("promptDelta")).isFalse();
        assertThat(ctx.path("teamPrompt").asText()).isEqualTo(PRE_TEAM); // 매치 프롬프트 전체가 실린다
        // effortHint = config(`hmb.match.delta.overhaul-effort`) 기본 "" = 세션 기본 effort(측정 근거 4.75).
        assertThat(ctx.has("effortHint")).isTrue();
        assertThat(ctx.path("effortHint").asText()).isEmpty();

        assertThat(effectiveRows(matchId, 1, "home")).isEqualTo(1L); // ⑤ 유효 잡 1개

        // 끝까지 도는지(계약 무손상): 풀생성 결과로 전반이 정상 진행된다.
        kickoff(token, matchId);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    /**
     * <b>회귀 가드(이 웨이브의 핵심)</b> — 킥오프에서 <b>한 축만</b> 지시하면 델타 그대로다.
     *
     * <p>여기가 직전 자카드 신호가 틀렸던 지점이다: h1 의 델타 old 는 <b>항상 ""</b>(덱에 팀 지시가 없다)
     * → 유사도가 늘 0 → 팀 지시가 있는 <b>모든</b> 킥오프가 풀생성으로 갔다. 그런데 라운드2 에서 이
     * 조건(K2, old="")의 승자는 <b>델타(4.63)</b>였고 풀생성은 3.25 였다 — 오라우팅은 지연뿐 아니라
     * 품질도 잃는다. 축 개수 신호는 old 를 보지 않으므로 이 문장을 1축(템포)으로 읽고 델타에 남긴다.
     */
    @Test
    void firstHalfSingleAxisInstructionStaysOnTheDeltaPatch() {
        String token = setupUserWithPromptedDeck("route_h1_small");
        String matchId = matchWithWarmBase(token);

        submitPrompt(token, matchId, "pre", "team", null, HALFTIME_SMALL_EDIT); // 템포 1축

        JsonNode ctx = jobContext(matchId, 1, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input-patch"); // 베이스 위 델타 패치
        assertThat(ctx.path("base").isObject()).isTrue();
        assertThat(ctx.path("promptDelta").path("team").path("old").asText()).isEmpty(); // old 는 비어 있다
        assertThat(ctx.path("promptDelta").path("team").path("new").asText())
                .isEqualTo(HALFTIME_SMALL_EDIT);
        assertThat(ctx.has("effortHint")).isFalse();
        assertThat(effectiveRows(matchId, 1, "home")).isEqualTo(1L);
    }

    /** 돌발 지시(전술 축 0~1)도 델타 유지 — 라운드2 C1~C3 은 델타가 3.83~5.00 으로 PASS 했다. */
    @Test
    void surpriseInstructionsStayOnTheDeltaPatch() {
        String token = setupUserWithPromptedDeck("route_surprise");
        String matchId = matchWithWarmBase(token);

        submitPrompt(token, matchId, "pre", "team", null, "상대 10번만 막아. 나머지는 신경 쓰지 마."); // 마킹 1축
        assertThat(jobContext(matchId, 1, "home").path("kind").asText()).isEqualTo("team-input-patch");

        submitPrompt(token, matchId, "pre", "team", null, "아무것도 하지 마."); // 0축
        JsonNode ctx = jobContext(matchId, 1, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(ctx.has("effortHint")).isFalse();
        assertThat(effectiveRows(matchId, 1, "home")).isEqualTo(1L);
    }

    /** ③ 개인 지시만 바뀌면 팀 델타가 없다 → 라우팅 대상 아님(K3 = 델타가 동급 이상). */
    @Test
    void playerOnlyChangeStaysOnTheDeltaPatch() {
        String token = setupUserWithPromptedDeck("route_h1_player");
        String matchId = matchWithWarmBase(token);

        submitPrompt(token, matchId, "pre", "player", "P002", "앞으로 나가서 압박");

        JsonNode ctx = jobContext(matchId, 1, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(ctx.path("promptDelta").path("players").path("P002").path("new").asText())
                .isEqualTo("앞으로 나가서 압박");
        assertThat(ctx.has("effortHint")).isFalse(); // 일반 잡엔 안 붙는다
    }

    // ── ②/④ h2: 소변경은 델타 유지, 대변경은 풀생성 ──────────────────────

    @Test
    void halftimeSmallEditKeepsTheDeltaPatch() {
        String token = setupUserWithPromptedDeck("route_h2_small");
        String matchId = matchAtHalftime(token);

        submitPrompt(token, matchId, "halftime", "team", null, HALFTIME_SMALL_EDIT);

        JsonNode ctx = jobContext(matchId, 2, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(ctx.path("promptDelta").path("team").path("old").asText()).isEqualTo(PRE_TEAM);
        assertThat(ctx.path("promptDelta").path("team").path("new").asText()).isEqualTo(HALFTIME_SMALL_EDIT);
        assertThat(ctx.has("effortHint")).isFalse();
        assertThat(effectiveRows(matchId, 2, "home")).isEqualTo(1L);
    }

    @Test
    void halftimeOverhaulRoutesToFullGenerationWithEffortHint() {
        String token = setupUserWithPromptedDeck("route_h2_full");
        String matchId = matchAtHalftime(token);

        submitPrompt(token, matchId, "halftime", "team", null, HALFTIME_OVERHAUL);

        JsonNode ctx = jobContext(matchId, 2, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input");
        assertThat(ctx.has("promptDelta")).isFalse();
        assertThat(ctx.path("teamPrompt").asText()).isEqualTo(HALFTIME_OVERHAUL);
        assertThat(ctx.path("effortHint").asText()).isEmpty();
        assertThat(ctx.has("effortHint")).isTrue();
        assertThat(ctx.path("prevSummary").isObject()).isTrue(); // 후반 컨텍스트는 그대로 실린다
        assertThat(effectiveRows(matchId, 2, "home")).isEqualTo(1L);

        // 후반도 끝까지 돈다.
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    /** 소변경 → 대변경으로 <b>고쳐 쓰면</b> 라우팅도 따라 바뀐다(유효 잡은 계속 1개). */
    @Test
    void reEditFlipsTheRouteAndKeepsExactlyOneEffectiveJob() {
        String token = setupUserWithPromptedDeck("route_h2_flip");
        String matchId = matchAtHalftime(token);

        submitPrompt(token, matchId, "halftime", "team", null, HALFTIME_SMALL_EDIT);
        assertThat(jobContext(matchId, 2, "home").path("kind").asText()).isEqualTo("team-input-patch");

        submitPrompt(token, matchId, "halftime", "team", null, HALFTIME_OVERHAUL);
        JsonNode ctx = jobContext(matchId, 2, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input");
        assertThat(ctx.path("effortHint").asText()).isEmpty();
        assertThat(effectiveRows(matchId, 2, "home")).isEqualTo(1L);
    }

    // ── ⑥ 일반 폴백 풀생성에는 effortHint 가 붙지 않는다 ───────────────────

    @Test
    void plainFallbackFullGenerationCarriesNoEffortHint() {
        String token = setupUserWithPromptedDeck("route_fallback");
        String matchId = createMatch(token, "BOT_BAL"); // A 미완(드레인 안 함) = 폴백 경로
        submitPrompt(token, matchId, "pre", "team", null, PRE_TEAM);

        kickoff(token, matchId); // 킥오프가 양측 풀생성 폴백을 태운다
        JsonNode ctx = jobContext(matchId, 1, "home");
        assertThat(ctx.path("kind").asText()).isEqualTo("team-input");
        assertThat(ctx.has("effortHint")).isFalse(); // 라우팅으로 간 풀생성이 아니다
    }

    /** 봇 사이드는 매치시점 입력이 없다 — 라우팅과 무관하게 재사용(콜0) 그대로. */
    @Test
    void botSideIsUnaffectedByRouting() {
        String token = setupUserWithPromptedDeck("route_bot");
        String matchId = matchWithWarmBase(token);
        submitPrompt(token, matchId, "pre", "team", null, PRE_TEAM);

        JsonNode botCtx = jobContext(matchId, 1, "away");
        assertThat(botCtx.path("kind").asText()).isEqualTo("materialized");
        assertThat(botCtx.has("effortHint")).isFalse();
    }
}
