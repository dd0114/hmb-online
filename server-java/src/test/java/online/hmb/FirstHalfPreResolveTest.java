package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.jobs.AiJobQueue;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * h1 즉시 해소 (#193 라운드2) — 킥오프 전 <b>프롬프트를 제출한 그 순간</b> 전반 인풋을 해소한다.
 *
 * <p>왜: 지금까지 킥오프 잡은 킥오프 요청에서야 만들어져 AI 생성(수 초~수십 초)이 통째로 유저 대기로
 * 보였다. hero 원 스펙은 "프롬프트를 제출하면 취합"이다 — 제출~킥오프 사이(유저가 계속 지시를 쓰는
 * 시간)에 생성을 숨긴다. h2 선행 생성(#193 W2b-B2)의 대칭 적용이고, {@code supersede} 가 재편집
 * 안전(=유효 잡 1개)을 이미 보장한다.
 *
 * <p>박제하는 불변식: ① pre 제출 시 BRIEFING 에서 h1 잡이 생긴다 ② 여러 번 고쳐도 유효 잡은 1개고
 * 최신 지시가 이긴다 ③ <b>A(베이스) 미완이면 해소하지 않는다</b>(편집마다 풀생성이 낭비되므로 —
 * 킥오프의 기존 폴백이 그대로 소유) ④ BRIEFING 에서는 잡이 done 이어도 시뮬하지 않는다
 * ⑤ 킥오프 시 이미 done 이면 서번트 왕복 0으로 즉시 전반 ⑥ 봇 사이드는 프롬프트와 무관하다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class FirstHalfPreResolveTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry); // 시계는 주제가 아니다 — 전반 시뮬 직후 곧바로 감독시간
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        // 이 클래스의 주제는 대변경 라우팅(#193 라운드2)이 아니다 — 델타/분기만 보게 라우팅은 끈다.
        TestDbSupport.disableOverhaulRouting(registry);
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
    private AiJobQueue jobQueue;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** A(덱 베이스) 캐시가 채워진 브리핑 매치 — 이 상태의 pre 제출이 즉시 해소 대상이다. */
    private String matchWithWarmBase(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(fakeServants.drain()).isEqualTo(2); // 유저 A + 봇 A
        return matchId;
    }

    private void submitPre(String token, String matchId, String text) {
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", text), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    /** (match, half=1, side) 의 <b>유효</b> 잡 행 수 — 불변식상 해소 뒤에는 항상 1이다. */
    private long h1EffectiveRows(String matchId, String side) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = ? AND effective = 1
                        """)
                .params(matchId, side).query(Long.class).single();
    }

    /** (match, half=1) 전체 행 수(무효화돼 남은 캐시 포함) — 잡이 증식하는지 본다. */
    private long h1AllRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = 1")
                .param(matchId).query(Long.class).single();
    }

    private long h1Queued(String matchId) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = 1 AND status = 'queued'
                        """)
                .param(matchId).query(Long.class).single();
    }

    /** 유효 h1 잡 컨텍스트(전반이 실제로 무엇으로 돌지를 결정하는 그 행). */
    private JsonNode h1Context(String matchId, String side) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = ? AND effective = 1
                        """)
                .params(matchId, side).query(String.class).single();
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private boolean halfSimulated(String matchId, int half) {
        return jdbcClient.sql("SELECT COUNT(*) FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(Long.class).single() > 0;
    }

    private void kickoff(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
    }

    // ── ①: pre 제출 = 그 자리에서 h1 해소 ────────────────────────────────

    @Test
    void prePromptDuringBriefingResolvesTheFirstHalfJobRightAway() {
        String token = setupUserWithDeck("pre_resolve");
        String matchId = matchWithWarmBase(token);

        submitPre(token, matchId, "전원 압박, 라인 올려");

        // 킥오프를 부르지 않았는데 유저 사이드 B 패치가 이미 큐에 있다(= 생성이 제출 직후 시작된다).
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
        assertThat(h1EffectiveRows(matchId, "home")).isEqualTo(1L);
        JsonNode context = h1Context(matchId, "home");
        assertThat(context.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(context.path("base").isObject()).isTrue();
        assertThat(context.path("promptDelta").path("team").path("new").asText())
                .isEqualTo("전원 압박, 라인 올려");
        assertThat(h1Queued(matchId)).isEqualTo(1L); // 유저만 — 봇은 프롬프트 무관
    }

    /** ⑥ 봇 사이드는 프롬프트와 무관 — 재사용(materialize, 콜0) 그대로다. */
    @Test
    void botSideStaysAReuseRegardlessOfThePrompt() {
        String token = setupUserWithDeck("pre_bot");
        String matchId = matchWithWarmBase(token);

        submitPre(token, matchId, "측면 공략");

        JsonNode botContext = h1Context(matchId, "away");
        assertThat(botContext.path("kind").asText()).isEqualTo("materialized");
        assertThat(h1EffectiveRows(matchId, "away")).isEqualTo(1L);
    }

    // ── ②: 여러 번 고쳐도 유효 잡 1개, 최신 지시가 이긴다 ────────────────

    @Test
    void repeatedEditsKeepExactlyOneEffectiveJobWithTheLatestInstruction() {
        String token = setupUserWithDeck("pre_edit");
        String matchId = matchWithWarmBase(token);

        submitPre(token, matchId, "1차: 라인 올리고 강압박");
        submitPre(token, matchId, "2차: 라인 내리고 역습");

        assertThat(h1EffectiveRows(matchId, "home")).isEqualTo(1L);
        assertThat(h1Context(matchId, "home").path("promptDelta").path("team").path("new").asText())
                .isEqualTo("2차: 라인 내리고 역습");
        // 아직 워커가 물지 않은(attempts=0) 1차 잡은 supersede 가 <b>지운다</b> — 즉 배포 전 편집은
        // AI 콜을 늘리지 않고 큐의 잡을 갈아끼운다. 남는 행은 home 1 + away materialize 1.
        assertThat(h1AllRows(matchId)).isEqualTo(2L);

        // 킥오프해도 최신 지시로만 돈다.
        kickoff(token, matchId);
        assertThat(h1Context(matchId, "home").path("promptDelta").path("team").path("new").asText())
                .isEqualTo("2차: 라인 내리고 역습");
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    /**
     * 편집이 <b>워커가 잡을 문 뒤</b>에 오면 1차 잡은 살아남는다(complete 404 방지) — 그래서 콜 수는
     * 편집 횟수에 비례한다. 그래도 <b>결과는 최신 지시가 이긴다</b>: 늦게 도착한 1차 결과는 유효 잡이
     * 아니라 전반 인풋으로 선택되지 않는다(h2 의 #193 검증 B-2 규율을 h1 이 새로 노출한 표면).
     */
    @Test
    void lateCompletionOfASupersededFirstHalfJobDoesNotOverrideTheLatestInstruction() {
        String token = setupUserWithDeck("pre_stale");
        String matchId = matchWithWarmBase(token);

        submitPre(token, matchId, "1차: 라인 올리고 강압박");
        AiJobQueue.JobRow slow = jobQueue.lease("slow-worker").orElseThrow(); // 워커가 물었다
        assertThat(slow.half()).isEqualTo(1);
        assertThat(slow.side()).isEqualTo("home");

        submitPre(token, matchId, "2차: 라인 내리고 역습"); // 문 뒤의 편집 → 새 잡(= 추가 콜 1)
        List<String> queued = jdbcClient.sql("""
                        SELECT id FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = 'home'
                          AND status = 'queued' AND effective = 1
                        """)
                .param(matchId).query(String.class).list();
        assertThat(queued).hasSize(1);
        assertThat(queued.get(0)).isNotEqualTo(slow.id());

        kickoff(token, matchId);
        assertThat(matchState(matchId)).isEqualTo("GEN1"); // 유효 잡이 아직이라 기다린다

        // 느린 1차가 이제 도착한다 — 보고는 받아주되(라이브락 방지) 전반 입력으로 쓰이지 않는다.
        jobQueue.complete(slow.id(), true, staleResult(slow.contextJson()), USAGE_JSON, null);
        assertThat(matchState(matchId)).isEqualTo("GEN1");
        assertThat(halfSimulated(matchId, 1)).isFalse();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        assertThat(jdbcClient.sql("SELECT home_input_json FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single()).doesNotContain(STALE_MARK);
    }

    /** 낡은 잡 결과의 지문 — 전반 인풋에 이게 있으면 낡은 결과가 이긴 것이다. */
    private static final String STALE_MARK = "STALE-SUPERSEDED-H1";
    private static final String USAGE_JSON =
            "{\"inputTokens\":0,\"outputTokens\":0,\"cacheReadTokens\":0,\"cacheCreateTokens\":0,\"costUSD\":0}";

    private String staleResult(String contextJson) {
        try {
            JsonNode input = objectMapper.readTree(fakeServants.stubTacticalInput(contextJson));
            ((com.fasterxml.jackson.databind.node.ObjectNode) input.path("meta"))
                    .put("promptHash", STALE_MARK);
            return objectMapper.writeValueAsString(input);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ── ③: A 미완이면 즉시 해소를 하지 않는다(편집마다 풀생성 낭비 방지) ──

    @Test
    void preResolveIsSkippedWhileTheBaseIsStillGenerating() {
        String token = setupUserWithDeck("pre_cold");
        String matchId = createMatch(token, "BOT_BAL"); // A 드레인 안 함 = 미완

        submitPre(token, matchId, "1차 지시");
        submitPre(token, matchId, "2차 지시");
        submitPre(token, matchId, "3차 지시");

        // 폴백(풀 생성)을 제출 시점에 태우면 편집 횟수만큼 풀생성이 쌓인다 — 아예 만들지 않는다.
        assertThat(h1AllRows(matchId)).isZero();
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");

        // 킥오프의 기존 경로가 그대로 소유한다(폴백 불변 — 양측 풀 생성).
        kickoff(token, matchId);
        assertThat(h1AllRows(matchId)).isEqualTo(2L);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    // ── ④/⑤: BRIEFING 에선 시뮬 안 함 → 킥오프 시 done 이면 대기 0 ────────

    @Test
    void readyFirstHalfJobDoesNotSimulateUntilKickoffThenGoesStraightThrough() {
        String token = setupUserWithDeck("pre_nowait");
        String matchId = matchWithWarmBase(token);
        submitPre(token, matchId, "라인 올리고 강압박");

        // 브리핑 중 생성 완료 — 그래도 전반은 돌지 않는다(킥오프는 유저의 결정이다).
        assertThat(fakeServants.drain()).isEqualTo(1);
        assertThat(h1Queued(matchId)).isZero();
        assertThat(halfSimulated(matchId, 1)).isFalse();
        assertThat(matchState(matchId)).isEqualTo("BRIEFING");
        long rowsBeforeKickoff = h1AllRows(matchId);

        // 킥오프 = 그 자리에서 전반 시뮬(서번트 왕복 0). drain 을 부르지 않는다는 게 이 테스트의 요지다.
        kickoff(token, matchId);
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        assertThat(halfSimulated(matchId, 1)).isTrue();
        // 킥오프의 enqueueHalf 는 같은 컨텍스트 → promptHash 멱등 = 중복 잡 0.
        assertThat(h1AllRows(matchId)).isEqualTo(rowsBeforeKickoff);
        assertThat(h1Queued(matchId)).isZero();
    }

    /** 하프타임 경로 회귀 — h1 즉시 해소가 붙어도 후반 흐름(선행 생성·교체)은 그대로다. */
    @Test
    void secondHalfFlowStillWorksAfterAPreResolvedFirstHalf() {
        String token = setupUserWithDeck("pre_h2");
        String matchId = matchWithWarmBase(token);
        submitPre(token, matchId, "하이라인·와이드");
        fakeServants.drain();
        kickoff(token, matchId);
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", "로우블록으로 전환"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }
}
