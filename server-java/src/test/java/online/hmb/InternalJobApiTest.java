package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.HashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicBoolean;
import online.hmb.jobs.JobLeaseSweeper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * W4 — /internal AI 잡 큐 프로토콜 (LLD §6): poll long-poll lease + complete + X-Servant-Token 인증.
 *
 * AC-Q1(lease/재배포), AC-Q3(401 매트릭스), long-poll 조기반환, non-leased complete 409,
 * ok=false requeue→exhaust(HTTP 경유), 그리고 실 /internal HTTP 와이어로 도는 풀 E2E(가짜 서번트 스레드).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class InternalJobApiTest extends MatchTestBase {

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
    private FakeServants fakeServants;

    @Resource
    private ObjectMapper objectMapper;

    // 내부 호출은 java.net.http.HttpClient로 — HttpURLConnection(TestRestTemplate 기본)이 401 POST에서
    // 던지는 HttpRetryException("cannot retry ... in streaming mode")을 근본적으로 피한다(재인증 재전송 없음).
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    /** ai_jobs는 클래스 단위로 DB를 공유하므로(테스트 메서드 간) 각 테스트 시작 시 큐를 비운다. */
    @BeforeEach
    void clearJobQueue() {
        jdbcClient.sql("DELETE FROM ai_jobs").update();
    }

    // ── 내부 HTTP 헬퍼 ───────────────────────────────────────────────────

    private ResponseEntity<Map> pollRaw(String token, Object body) {
        return internalPost("/internal/ai-jobs/poll", token, body);
    }

    private ResponseEntity<Map> completeRaw(String token, String jobId, Object body) {
        return internalPost("/internal/ai-jobs/" + jobId + "/complete", token, body);
    }

    private ResponseEntity<Map> healthRaw(String token) {
        return exchange(reqBuilder("/internal/health", token).GET().build());
    }

    private ResponseEntity<Map> internalPost(String path, String token, Object body) {
        return exchange(reqBuilder(path, token).POST(jsonBody(body)).build());
    }

    private HttpRequest.Builder reqBuilder(String path, String token) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl(path)))
                .header("Content-Type", "application/json");
        if (token != null) {
            b.header("X-Servant-Token", token);
        }
        return b;
    }

    private HttpRequest.BodyPublisher jsonBody(Object body) {
        try {
            return HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body));
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<Map> exchange(HttpRequest request) {
        try {
            HttpResponse<String> resp = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
            Map<String, Object> parsed = (resp.body() == null || resp.body().isBlank())
                    ? null : objectMapper.readValue(resp.body(), Map.class);
            return ResponseEntity.status(resp.statusCode()).body(parsed);
        } catch (Exception e) {
            throw new IllegalStateException("internal 요청 실패", e);
        }
    }

    private String kickoffToGen1(String nickname) {
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        assertThat(matchState(matchId)).isEqualTo("GEN1");
        // 킥오프 전 A(베이스) 미완 → 이 매치의 h1 은 풀생성 폴백(home+away 2 side 잡). 이 내부-잡 프로토콜
        // 테스트는 per-match side 잡만 다루므로, 브리핑에 프리페치된 A(match_id NULL, #95) 캐시 잡을 제거해
        // 큐를 결정론적으로 유지한다(A 는 크로스매치 캐시라 이 테스트의 lease/count 대상이 아님).
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id IS NULL").update();
        return matchId;
    }

    // ── AC-Q1: poll이 잡을 lease하고, 빈 큐 두 번째 poll은 짧은 waitMs로 204 ─────────

    @Test
    void pollLeasesJobsThenEmptyQueueReturns204() {
        String matchId = kickoffToGen1("q_poll");

        ResponseEntity<Map> first = pollRaw(SERVANT_TOKEN, Map.of("workerId", "w1", "waitMs", 1000));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(first.getBody().get("status")).isEqualTo("leased");
        assertThat(first.getBody().get("context")).isNotNull(); // context_json verbatim 파싱
        String id1 = (String) first.getBody().get("id");

        ResponseEntity<Map> second = pollRaw(SERVANT_TOKEN, Map.of("workerId", "w2", "waitMs", 1000));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        String id2 = (String) second.getBody().get("id");
        assertThat(id2).isNotEqualTo(id1); // 서로 다른 잡(home/away)

        // 큐 소진 후 짧은 waitMs → 204
        long startNanos = System.nanoTime();
        ResponseEntity<Map> third = pollRaw(SERVANT_TOKEN, Map.of("workerId", "w3", "waitMs", 300));
        long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;
        assertThat(third.getStatusCode()).isEqualTo(HttpStatus.NO_CONTENT);
        assertThat(elapsedMs).isLessThan(3000); // 대략 waitMs 근처에서 반환

        // DB 확인: 두 잡 모두 leased + attempts 증가
        long leased = jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND status = 'leased'")
                .param(matchId).query(Long.class).single();
        assertThat(leased).isEqualTo(2L);
        int attempts = jdbcClient.sql("SELECT attempts FROM ai_jobs WHERE id = ?")
                .param(id1).query(Integer.class).single();
        assertThat(attempts).isEqualTo(1);
    }

    // ── AC-Q1: sweeper가 만료 lease 재배포 → 재-poll 시 attempts 증가한 채 다시 lease ──

    @Test
    void staleLeaseRequeuedBySweeperThenRepollableWithIncrementedAttempts() {
        String matchId = kickoffToGen1("q_stale");
        // away 잡 제거 → 단일 잡으로 결정론적 검증
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id = ? AND side = 'away'").param(matchId).update();

        ResponseEntity<Map> first = pollRaw(SERVANT_TOKEN, Map.of("workerId", "w1", "waitMs", 500));
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.OK);
        String jobId = (String) first.getBody().get("id");
        assertThat(((Number) first.getBody().get("attempts")).intValue()).isEqualTo(1);

        // lease_until을 과거로 → sweeper 재배포
        jdbcClient.sql("UPDATE ai_jobs SET lease_until = ? WHERE id = ?")
                .params(java.time.Instant.now().minusSeconds(3600).toString(), jobId).update();
        assertThat(sweeper.requeueExpiredLeases()).isGreaterThanOrEqualTo(1);
        assertThat(jdbcClient.sql("SELECT status FROM ai_jobs WHERE id = ?").param(jobId)
                .query(String.class).single()).isEqualTo("queued");

        ResponseEntity<Map> second = pollRaw(SERVANT_TOKEN, Map.of("workerId", "w2", "waitMs", 500));
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(second.getBody().get("id")).isEqualTo(jobId);
        assertThat(((Number) second.getBody().get("attempts")).intValue()).isEqualTo(2); // 재-lease로 증가
    }

    // ── AC-Q3: 토큰 없음/오류 → 401, poll+complete+health 전부 ───────────────

    @Test
    void servantTokenMatrix() {
        String matchId = kickoffToGen1("q_auth");
        String jobId = jdbcClient.sql("SELECT id FROM ai_jobs WHERE match_id = ? LIMIT 1")
                .param(matchId).query(String.class).single();

        // poll
        assertUnauthorized(pollRaw(null, Map.of("workerId", "w")));
        assertUnauthorized(pollRaw("wrong-token", Map.of("workerId", "w")));
        // complete
        assertUnauthorized(completeRaw(null, jobId, Map.of("ok", false, "error", "x")));
        assertUnauthorized(completeRaw("wrong-token", jobId, Map.of("ok", false, "error", "x")));
        // health
        assertUnauthorized(healthRaw(null));
        assertUnauthorized(healthRaw("wrong-token"));

        // 올바른 토큰 → health 200
        ResponseEntity<Map> ok = healthRaw(SERVANT_TOKEN);
        assertThat(ok.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ok.getBody().get("queueDepth")).isNotNull();
        assertThat(ok.getBody().get("leasedCount")).isNotNull();
    }

    private void assertUnauthorized(ResponseEntity<Map> response) {
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(response.getBody().get("code")).isEqualTo("UNAUTHORIZED");
    }

    // ── long-poll 조기 반환: 대기 중 잡이 enqueue되면 waitMs 만료 전 반환 ───────

    @Test
    void longPollReturnsEarlyWhenJobEnqueuedMidWait() throws Exception {
        // BRIEFING 매치 준비 — 1.5s 뒤 kickoff로 잡 enqueue
        String token = setupUserWithDeck("q_early");
        String matchId = createMatch(token, "BOT_BAL");
        // A 프리페치(#95)로 유저 A + 봇 A 가 이미 큐에 있음 — 롱폴 "빈 큐 대기" 검증 전에 비운다.
        // (BRIEFING 이라 아직 per-match side 잡은 없다.) A 는 크로스매치 캐시라 이 롱폴 타이밍 검증과 무관.
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id IS NULL").update();
        assertThat(pollRaw(SERVANT_TOKEN, Map.of("workerId", "w-drain", "waitMs", 300)).getStatusCode())
                .isEqualTo(HttpStatus.NO_CONTENT);

        Thread enqueuer = new Thread(() -> {
            try {
                Thread.sleep(1500);
                authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        });
        enqueuer.start();

        long startNanos = System.nanoTime();
        ResponseEntity<Map> poll = pollRaw(SERVANT_TOKEN, Map.of("workerId", "w-early", "waitMs", 10000));
        long elapsedMs = (System.nanoTime() - startNanos) / 1_000_000L;
        enqueuer.join();

        assertThat(poll.getStatusCode()).isEqualTo(HttpStatus.OK); // 잡을 받음
        assertThat(elapsedMs).isLessThan(5000);                    // waitMs(10s) 만료 전 조기반환
        assertThat(elapsedMs).isGreaterThan(1000);                 // enqueue 전엔 대기했음
    }

    // ── non-leased 잡 complete → 409 ─────────────────────────────────────

    @Test
    void completeOnNonLeasedJobReturns409() {
        String matchId = kickoffToGen1("q_409");
        // 잡은 queued(아직 lease 안 됨)
        String jobId = jdbcClient.sql("SELECT id FROM ai_jobs WHERE match_id = ? LIMIT 1")
                .param(matchId).query(String.class).single();

        ResponseEntity<Map> response = completeRaw(SERVANT_TOKEN, jobId,
                Map.of("ok", false, "error", "x"));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().get("code")).isEqualTo("INVALID_STATE");

        // 알 수 없는 id → 404
        ResponseEntity<Map> notFound = completeRaw(SERVANT_TOKEN, "no-such-job",
                Map.of("ok", false, "error", "x"));
        assertThat(notFound.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── ok=true인데 output 누락 → 400 VALIDATION_ERROR (leased 잡 대상) ───────

    @Test
    void completeOkTrueWithoutOutputReturns400() {
        String matchId = kickoffToGen1("q_400");
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id = ? AND side = 'away'").param(matchId).update();

        // 실제 lease → complete 검증이 leased 게이트(409)가 아니라 output 검증(400)에 걸리는지 확인
        String jobId = leaseOne("w-400");
        ResponseEntity<Map> response = completeRaw(SERVANT_TOKEN, jobId, Map.of("ok", true));
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(response.getBody().get("code")).isEqualTo("VALIDATION_ERROR");

        // 잡은 여전히 leased(complete 미반영) — 재시도 가능
        assertThat(jdbcClient.sql("SELECT status FROM ai_jobs WHERE id = ?").param(jobId)
                .query(String.class).single()).isEqualTo("leased");
    }

    // ── complete(ok=false) requeue → exhaust (HTTP 경유, 매치 FAILED 전파) ────

    @Test
    void completeOkFalseRequeuesThenExhaustsViaHttp() {
        String matchId = kickoffToGen1("q_exhaust");
        jdbcClient.sql("DELETE FROM ai_jobs WHERE match_id = ? AND side = 'away'").param(matchId).update();

        // cycle 1: poll(attempts→1) → complete(false): 1<3 → requeue
        String jobId = leaseOne("w-ex");
        ResponseEntity<Map> c1 = completeRaw(SERVANT_TOKEN, jobId, Map.of("ok", false, "error", "e1"));
        assertThat(c1.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(c1.getBody().get("status")).isEqualTo("queued");
        assertThat(matchState(matchId)).isEqualTo("GEN1");

        // cycle 2: poll(attempts→2) → requeue
        assertThat(leaseOne("w-ex")).isEqualTo(jobId);
        ResponseEntity<Map> c2 = completeRaw(SERVANT_TOKEN, jobId, Map.of("ok", false, "error", "e2"));
        assertThat(c2.getBody().get("status")).isEqualTo("queued");

        // cycle 3: poll(attempts→3) → complete(false): 3<3 아님 → failed + 매치 FAILED
        assertThat(leaseOne("w-ex")).isEqualTo(jobId);
        ResponseEntity<Map> c3 = completeRaw(SERVANT_TOKEN, jobId, Map.of("ok", false, "error", "permanent"));
        assertThat(c3.getBody().get("status")).isEqualTo("failed");
        assertThat(matchState(matchId)).isEqualTo("FAILED");
    }

    private String leaseOne(String worker) {
        ResponseEntity<Map> poll = pollRaw(SERVANT_TOKEN, Map.of("workerId", worker, "waitMs", 500));
        assertThat(poll.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) poll.getBody().get("id");
    }

    // ── 풀 E2E: 실 /internal HTTP 와이어로 poll→stub→complete, 러너는 가짜 픽스처 ───

    @Test
    void fullMatchFlowOverInternalHttpWire() throws Exception {
        String token = setupUserWithDeck("q_e2e");
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "점유 운영"), Map.class);

        AtomicBoolean running = new AtomicBoolean(true);
        Thread servant = new Thread(() -> runServant(running));
        servant.start();
        try {
            authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
            waitForState(token, matchId, "HALFTIME", 30000);

            authPost("/api/matches/" + matchId + "/halftime", token,
                    Map.of("substitutions", java.util.List.of()), Map.class);
            authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
            waitForState(token, matchId, "FINISHED", 30000);
        } finally {
            running.set(false);
            servant.join(5000);
        }

        ResponseEntity<Map> finished = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(finished.getBody().get("state")).isEqualTo("FINISHED");
        assertThat(finished.getBody().get("scoreHome")).isEqualTo(1); // fixture 1+0
        assertThat(finished.getBody().get("result")).isEqualTo("WIN");

        // 잡 4개(h1 home/away + h2 home/away) 모두 done + result_json verbatim 보존
        long done = jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND status = 'done'")
                .param(matchId).query(Long.class).single();
        assertThat(done).isEqualTo(4L);
        String storedResult = jdbcClient.sql(
                        "SELECT result_json FROM ai_jobs WHERE match_id = ? AND half = 1 AND side = 'home'")
                .param(matchId).query(String.class).single();
        JsonNode result = objectMapper.readTree(storedResult);
        assertThat(result.path("team").path("formation").asText()).isEqualTo("4-4-2"); // 서번트 stub 통과

        // 보상 지급
        ResponseEntity<Map> me = authGet("/api/me", token, Map.class);
        assertThat(((Number) ((Map<?, ?>) me.getBody().get("wallet")).get("points")).longValue())
                .isEqualTo(3500L);
    }

    /** 가짜 서번트 루프: poll → context로 stub TacticalInput 생성 → complete(ok=true) 반복. */
    private void runServant(AtomicBoolean running) {
        while (running.get()) {
            try {
                ResponseEntity<Map> poll = pollRaw(SERVANT_TOKEN, Map.of("workerId", "http-servant", "waitMs", 1000));
                if (poll.getStatusCode() != HttpStatus.OK || poll.getBody() == null) {
                    continue; // 204 — 다시 폴링
                }
                String jobId = (String) poll.getBody().get("id");
                Object context = poll.getBody().get("context");
                String contextJson = objectMapper.writeValueAsString(context);
                String outputJson = fakeServants.stubTacticalInput(contextJson);
                JsonNode output = objectMapper.readTree(outputJson);

                Map<String, Object> body = new HashMap<>();
                body.put("ok", true);
                body.put("output", output); // 중첩 JSON 객체로 전송 → 서버가 verbatim 저장
                body.put("usage", Map.of("inputTokens", 0, "outputTokens", 0,
                        "cacheReadTokens", 0, "cacheCreateTokens", 0, "costUSD", 0));
                completeRaw(SERVANT_TOKEN, jobId, body);
            } catch (Exception e) {
                if (running.get()) {
                    throw new IllegalStateException("servant loop 실패", e);
                }
            }
        }
    }

    private void waitForState(String token, String matchId, String target, long timeoutMs) throws Exception {
        long deadline = System.currentTimeMillis() + timeoutMs;
        while (System.currentTimeMillis() < deadline) {
            if (target.equals(matchState(matchId))) {
                return;
            }
            Thread.sleep(150);
        }
        throw new AssertionError("타임아웃: " + matchId + " 상태가 " + target + "에 도달하지 못함(현재 "
                + matchState(matchId) + ")");
    }
}
