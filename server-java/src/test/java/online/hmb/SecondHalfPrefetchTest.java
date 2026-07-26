package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.List;
import java.util.Map;
import online.hmb.jobs.JobLeaseSweeper;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import online.hmb.match.MatchOrchestrator;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * h2 선행 생성 (#193 W2b-B2) — 후반 인풋을 <b>재개 때가 아니라 전반 라이브 진입 직후</b> 해소한다.
 *
 * <p>왜: 하프타임 지시를 내면 후반 AI 생성이 감독시간(60초) 뒤에야 시작돼 유저가 그만큼 빈 화면을
 * 기다렸다. 전반 재생 창(4분) 동안 미리 태우면 재개 시점엔 이미 done → 대기 0.
 *
 * <p>불변식 3개를 박제한다: ① 전반 진입 시 h2 잡이 존재한다 ② <b>done 이어도 GEN2 진입 전에는 시뮬로
 * 넘어가지 않는다</b> ③ 전반 중 지시·교체가 바뀌면 그 시점에 다시 해소하고 <b>옛 결과는 무효</b>가 된다
 * (안 그러면 유저의 최신 입력을 무시한 채 후반이 돌아간다).
 *
 * <p>시간 의존은 만들지 않는다 — {@code phase_ends_at} 을 과거로 밀고 스위퍼를 직접 호출한다
 * (MatchClockFlowTest 와 동일 규율).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class SecondHalfPrefetchTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000"); // 배경 스위퍼 사실상 끔
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.clock.half-real-ms", () -> "240000");
        registry.add("hmb.match.clock.halftime-ms", () -> "60000");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    @Resource
    private JobLeaseSweeper jobSweeper;

    @Resource
    private MatchOrchestrator orchestrator;

    @Resource
    private ObjectMapper objectMapper;

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 킥오프 → 전반 시뮬 완료(FIRST_HALF, 라이브 재생 중). */
    private String kickoffToFirstHalf(String nickname) {
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        return token + "|" + matchId;
    }

    private void submitHalftimePrompt(String token, String matchId, String text) {
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", text), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    private void expireNow(String matchId) {
        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                .update();
    }

    /** 만료를 반복 적용해 목표 상태까지 진행(테스트 준비용). */
    private void expireInto(String matchId, String targetState) {
        for (int i = 0; i < 4 && !targetState.equals(matchState(matchId)); i++) {
            expireNow(matchId);
            clockSweeper.sweep();
        }
        assertThat(matchState(matchId)).isEqualTo(targetState);
    }

    private long jobCount(String matchId, int half, String status) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = ?
                        """)
                .params(matchId, half, status).query(Long.class).single();
    }

    private long h2JobRows(String matchId, String side) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = 2 AND side = ?")
                .params(matchId, side).query(Long.class).single();
    }

    private boolean halfSimulated(String matchId, int half) {
        return jdbcClient.sql("SELECT COUNT(*) FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(Long.class).single() > 0;
    }

    private JsonNode h2HomeContext(String matchId) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs WHERE match_id = ? AND half = 2 AND side = 'home'
                        """)
                .param(matchId).query(String.class).single();
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    // ── T-b: 전반 진입 시점에 h2 잡이 이미 있다 ───────────────────────────

    @Test
    void secondHalfJobsExistAsSoonAsTheFirstHalfGoesLive() {
        String matchId = kickoffToFirstHalf("pf_exists").split("\\|")[1];

        // 양측 h2 잡이 이미 해소돼 있다(지시 없음 → h1 인풋 승계 = done materialize, 콜 0).
        assertThat(h2JobRows(matchId, "home")).isEqualTo(1L);
        assertThat(h2JobRows(matchId, "away")).isEqualTo(1L);
        assertThat(jobCount(matchId, 2, "done")).isEqualTo(2L);
        // 그래도 후반은 아직 돌지 않았다.
        assertThat(halfSimulated(matchId, 2)).isFalse();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
    }

    // ── T-e: 선행 h2 가 done 이어도 GEN2 전에는 시뮬하지 않는다 ─────────────

    @Test
    void readySecondHalfJobsDoNotSimulateBeforeGen2() {
        String[] parts = kickoffToFirstHalf("pf_gate").split("\\|");
        String matchId = parts[1];

        // 완료 콜백이 다시 들어와도(잡 재보고·스위퍼 경로) 전반 재생 중엔 후반이 시작되지 않는다.
        List<String> h2JobIds = jdbcClient.sql(
                        "SELECT id FROM ai_jobs WHERE match_id = ? AND half = 2")
                .param(matchId).query(String.class).list();
        assertThat(h2JobIds).hasSize(2);
        h2JobIds.forEach(orchestrator::onJobDone);

        assertThat(halfSimulated(matchId, 2)).isFalse();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");

        // 감독시간에 들어와도 마찬가지 — 후반은 GEN2(재개/만료) 이후다.
        expireInto(matchId, "HALFTIME");
        h2JobIds.forEach(orchestrator::onJobDone);
        assertThat(halfSimulated(matchId, 2)).isFalse();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    // ── T-d: 전반 중 하프타임 지시 → 그 자리에서 델타 잡 재해소 ─────────────

    @Test
    void halftimePromptDuringFirstHalfReResolvesIntoADeltaJob() {
        String[] parts = kickoffToFirstHalf("pf_reresolve").split("\\|");
        String token = parts[0];
        String matchId = parts[1];
        assertThat(h2HomeContext(matchId).path("kind").asText()).isEqualTo("materialized");

        submitHalftimePrompt(token, matchId, "후반은 역습으로");

        // 유저 사이드는 패치 잡으로 갈아탄다 — 옛 재사용 행은 무효화돼 **행이 1개**다(최신 입력이 이긴다).
        assertThat(h2JobRows(matchId, "home")).isEqualTo(1L);
        JsonNode context = h2HomeContext(matchId);
        assertThat(context.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(context.path("base").isObject()).isTrue();
        assertThat(context.path("promptDelta").path("team").path("new").asText())
                .isEqualTo("후반은 역습으로");
        assertThat(jobCount(matchId, 2, "queued")).isEqualTo(1L); // 유저만 — 봇은 그대로 재사용
        // 여전히 전반 중이고 후반은 돌지 않았다.
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        assertThat(halfSimulated(matchId, 2)).isFalse();
    }

    // ── T-c: 선행 생성이 끝나 있으면 재개 즉시 후반 (추가 AI 대기 0) ─────────

    @Test
    void resumeAfterPrefetchCompletesSimulatesImmediately() {
        String[] parts = kickoffToFirstHalf("pf_nowait").split("\\|");
        String token = parts[0];
        String matchId = parts[1];

        // 유저가 전반을 보면서 후반 지시를 낸다 → AI 는 전반 재생 창 동안 돈다.
        submitHalftimePrompt(token, matchId, "라인 내리고 역습");
        assertThat(jobCount(matchId, 2, "queued")).isEqualTo(1L);
        fakeServants.drain(); // 전반 재생 중에 생성 완료
        assertThat(jobCount(matchId, 2, "queued")).isZero();
        assertThat(halfSimulated(matchId, 2)).isFalse(); // 그래도 후반은 아직

        expireInto(matchId, "HALFTIME");

        // 재개 = 그 자리에서 후반 시뮬(서번트 왕복 0). drain 을 부르지 않는다는 게 이 테스트의 요지다.
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        assertThat(halfSimulated(matchId, 2)).isTrue();
        assertThat(jobCount(matchId, 2, "queued")).isZero();
    }

    // ── 교체도 같은 규율: 옛 재사용 결과가 최신 로스터를 덮어쓰지 않는다 ──────

    @Test
    void substitutionsInvalidateThePrefetchedReuse() {
        String[] parts = kickoffToFirstHalf("pf_subs").split("\\|");
        String token = parts[0];
        String matchId = parts[1];

        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P002", "in", "P012"))), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        // 교체는 패치가 부적합 → 풀 생성. 선행 재사용 행은 사라지고 새 잡만 남는다.
        assertThat(h2JobRows(matchId, "home")).isEqualTo(1L);
        JsonNode context = h2HomeContext(matchId);
        assertThat(context.path("kind").asText()).isEqualTo("team-input");
        List<String> rosterIds = context.path("roster").findValuesAsText("playerId");
        assertThat(rosterIds).contains("P012").doesNotContain("P002");

        // 재개 시점에 아직 안 끝났으면 기다린다 — 옛 결과로 후반을 돌리지 않는다(로스터-인풋 불일치 방지).
        expireInto(matchId, "HALFTIME");
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("GEN2");
        assertThat(halfSimulated(matchId, 2)).isFalse();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }

    // ── 가드: 선행 생성이 GEN2 타임아웃·재시도와 충돌하지 않는다 ─────────────

    @Test
    void prefetchedJobKeepsFullTimeoutGraceAtGen2AndRetryIsIdempotent() {
        String[] parts = kickoffToFirstHalf("pf_timeout").split("\\|");
        String token = parts[0];
        String matchId = parts[1];
        submitHalftimePrompt(token, matchId, "후반 지시");

        // 선행 생성이라 잡 created_at 은 GEN2 진입보다 한 하프 앞선다 — 그대로면 재개 직후 이미
        // ai-job-timeout(240s) 자격이라 매치가 곧바로 FAILED 된다. 그 상황을 극단으로 재현한다.
        jdbcClient.sql("UPDATE ai_jobs SET created_at = ? WHERE match_id = ? AND half = 2")
                .params(Instant.now().minus(1, ChronoUnit.HOURS).toString(), matchId)
                .update();

        expireInto(matchId, "HALFTIME");
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("GEN2");

        // GEN 진입에서 타임아웃 시계가 다시 시작된다 → 실 서번트가 일하는 동안 스윕이 죽이지 않는다.
        assertThat(jobSweeper.failTimedOutMatches()).isZero();
        assertThat(matchState(matchId)).isEqualTo("GEN2");

        // 그래도 진짜 타임아웃되면 FAILED → retry 는 같은 해소를 멱등으로 다시 건다(행 증식 없음).
        jdbcClient.sql("UPDATE ai_jobs SET created_at = ? WHERE match_id = ? AND half = 2")
                .params(Instant.now().minus(1, ChronoUnit.HOURS).toString(), matchId)
                .update();
        assertThat(jobSweeper.failTimedOutMatches()).isGreaterThanOrEqualTo(1);
        assertThat(matchState(matchId)).isEqualTo("FAILED");

        assertThat(authPost("/api/matches/" + matchId + "/retry", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("GEN2");
        assertThat(h2JobRows(matchId, "home")).isEqualTo(1L);
        assertThat(h2JobRows(matchId, "away")).isEqualTo(1L);
        assertThat(jobSweeper.failTimedOutMatches()).isZero();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }
}
