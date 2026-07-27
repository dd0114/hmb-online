package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import online.hmb.jobs.AiJobQueue;
import online.hmb.jobs.JobLeaseSweeper;
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
 * #193 W2b-B1 — ai_jobs lease 라이브락(D2) + 큐 우선순위 역전(D3) 계약.
 *
 * <p><b>D2</b>: 실제 AI 잡이 lease-sec 을 넘기면 스위퍼가 잡을 queued 로 되돌린다. 그 뒤 도착한
 * <i>정상 결과</i>를 409 로 거부하면 결과가 폐기되고 같은 잡이 무한 재실행되어 ai-job-timeout 에
 * 매치가 FAILED 된다(라이브락). → 한 번이라도 배포됐던 잡(attempts&gt;0)의 complete 는 수용한다.
 * 단, 한 번도 lease 되지 않은 queued(attempts=0) 의 유령 complete 는 계속 409(기존 계약 유지).
 *
 * <p><b>D3</b>: 매치 생성 시 들어가는 배경 A-프리페치(match_id NULL)가 FIFO 로 유저 킥오프 잡을
 * 앞질러 점유(head-of-line 블로킹)하면 안 된다 — 매치 잡이 먼저 lease 돼야 한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class AiJobLeaseRecoveryTest extends MatchTestBase {

    private static final String SERVANT_TOKEN = "change-me"; // application.yml hmb.servant.internal-token 기본값

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 이 테스트의 주제는 시계가 아니다 — 레거시(즉시 전개) 흐름으로 고정한다(§7.7 롤백 경로).
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private JobLeaseSweeper sweeper;

    @Resource
    private AiJobQueue jobQueue;

    @Resource
    private FakeServants fakeServants;

    @Resource
    private ObjectMapper objectMapper;

    private static final HttpClient HTTP = HttpClient.newHttpClient();

    // ── D2: lease 만료 후 도착한 정상 결과를 수용하고 시뮬까지 이어진다 ─────────

    @Test
    void completeAfterLeaseExpiryIsAcceptedAndDrivesSimulation() {
        String token = setupUserWithDeck("q_livelock");
        String matchId = kickoffToGen1(token);

        // 1) 잡 lease → 워커가 오래 걸리는 사이 lease 만료 → 스위퍼가 queued 로 되돌림
        String slowJobId = leaseOne("w-slow");
        jdbcClient.sql("UPDATE ai_jobs SET lease_until = ? WHERE id = ?")
                .params(Instant.now().minusSeconds(3600).toString(), slowJobId).update();
        assertThat(sweeper.requeueExpiredLeases()).isGreaterThanOrEqualTo(1);
        assertThat(statusOf(slowJobId)).isEqualTo("queued");
        assertThat(attemptsOf(slowJobId)).isEqualTo(1); // 한 번 배포됐던 잡

        // 2) 뒤늦게 도착한 정상 결과 → 폐기하지 않고 수용(done)
        ResponseEntity<Map> completed = completeRaw(SERVANT_TOKEN, slowJobId, okBody(slowJobId));
        assertThat(completed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(completed.getBody().get("status")).isEqualTo("done");
        assertThat(statusOf(slowJobId)).isEqualTo("done");
        assertThat(jdbcClient.sql("SELECT result_json FROM ai_jobs WHERE id = ?")
                .param(slowJobId).query(String.class).single()).isNotNull();

        // 3) onJobDone 경로 동작: 반대편까지 완료되면 만료 복구된 결과를 써서 시뮬 → HALFTIME
        String otherJobId = leaseOne("w-other");
        assertThat(otherJobId).isNotEqualTo(slowJobId);
        assertThat(completeRaw(SERVANT_TOKEN, otherJobId, okBody(otherJobId)).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    // ── D2 경계: 한 번도 lease 안 된 queued(attempts=0) complete 는 여전히 409 ──

    @Test
    void completeOnNeverLeasedJobStillReturns409() {
        String token = setupUserWithDeck("q_ghost");
        String matchId = kickoffToGen1(token);
        String jobId = jobIdOf(matchId, "home");
        assertThat(attemptsOf(jobId)).isZero();

        ResponseEntity<Map> response = completeRaw(SERVANT_TOKEN, jobId, okBody(jobId));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().get("code")).isEqualTo("INVALID_STATE");
        assertThat(statusOf(jobId)).isEqualTo("queued"); // 유령 complete 는 상태를 바꾸지 못한다
    }

    // ── D3: 배경 프리페치(match_id NULL)가 먼저 큐에 있어도 매치 잡이 먼저 lease ──

    @Test
    void matchJobIsLeasedBeforeOlderBackgroundPrefetch() {
        String token = setupUserWithDeck("q_prio");
        String matchId = createMatch(token, "BOT_BAL");
        jdbcClient.sql("DELETE FROM ai_jobs").update(); // 프리페치 포함 초기화 — 순서를 직접 만든다

        // 배경 A-프리페치가 먼저(더 오래됐고) 큐에 있는 상태
        jobQueue.enqueueBase("base-prio-job", Map.of("kind", "team-input-base", "deck", "d1"));
        jdbcClient.sql("UPDATE ai_jobs SET created_at = ? WHERE id = 'base-prio-job'")
                .param(Instant.now().minusSeconds(600).toString()).update();
        // 그 뒤에 유저 킥오프 잡이 들어온다
        String matchJobId = jobQueue.enqueue(matchId, "home", 1,
                Map.of("kind", "team-input", "matchId", matchId, "side", "home", "half", 1));

        AiJobQueue.JobRow leased = jobQueue.lease("w-prio").orElseThrow();

        assertThat(leased.id()).isEqualTo(matchJobId);   // 유저 대기 잡이 우선
        assertThat(leased.matchId()).isEqualTo(matchId);
        assertThat(statusOf("base-prio-job")).isEqualTo("queued"); // 프리페치는 뒤로

        // 매치 잡이 나간 다음에야 프리페치가 lease 된다
        assertThat(jobQueue.lease("w-prio2").orElseThrow().id()).isEqualTo("base-prio-job");
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    /** 킥오프해 GEN1 진입 + 크로스매치 A 프리페치(match_id NULL) 제거 → per-match 잡 2개만 남긴다. */
    private String kickoffToGen1(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        assertThat(matchState(matchId)).isEqualTo("GEN1");
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id IS NULL").update();
        return matchId;
    }

    private String jobIdOf(String matchId, String side) {
        return jdbcClient.sql("SELECT id FROM ai_jobs WHERE match_id = ? AND side = ? AND half = 1")
                .params(matchId, side).query(String.class).single();
    }

    private String statusOf(String jobId) {
        return jdbcClient.sql("SELECT status FROM ai_jobs WHERE id = ?")
                .param(jobId).query(String.class).single();
    }

    private int attemptsOf(String jobId) {
        return jdbcClient.sql("SELECT attempts FROM ai_jobs WHERE id = ?")
                .param(jobId).query(Integer.class).single();
    }

    /** 서번트가 보내는 정상 완료 바디(stub TacticalInput). */
    private Map<String, Object> okBody(String jobId) {
        try {
            String contextJson = jdbcClient.sql("SELECT context_json FROM ai_jobs WHERE id = ?")
                    .param(jobId).query(String.class).single();
            JsonNode output = objectMapper.readTree(fakeServants.stubTacticalInput(contextJson));
            Map<String, Object> body = new HashMap<>();
            body.put("ok", true);
            body.put("output", output);
            body.put("usage", Map.of("inputTokens", 0, "outputTokens", 0,
                    "cacheReadTokens", 0, "cacheCreateTokens", 0, "costUSD", 0));
            return body;
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String leaseOne(String worker) {
        ResponseEntity<Map> poll = pollRaw(SERVANT_TOKEN, Map.of("workerId", worker, "waitMs", 500));
        assertThat(poll.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) poll.getBody().get("id");
    }

    // ── 내부 HTTP (InternalJobApiTest 와 동일 — HttpURLConnection 401 재시도 회피) ──

    private ResponseEntity<Map> pollRaw(String token, Object body) {
        return internalPost("/internal/ai-jobs/poll", token, body);
    }

    private ResponseEntity<Map> completeRaw(String token, String jobId, Object body) {
        return internalPost("/internal/ai-jobs/" + jobId + "/complete", token, body);
    }

    private ResponseEntity<Map> internalPost(String path, String token, Object body) {
        try {
            HttpRequest request = HttpRequest.newBuilder(URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json")
                    .header("X-Servant-Token", token)
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> resp = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            @SuppressWarnings("unchecked")
            Map<String, Object> parsed = (resp.body() == null || resp.body().isBlank())
                    ? null : objectMapper.readValue(resp.body(), Map.class);
            return ResponseEntity.status(resp.statusCode()).body(parsed);
        } catch (Exception e) {
            throw new IllegalStateException("internal 요청 실패", e);
        }
    }
}
