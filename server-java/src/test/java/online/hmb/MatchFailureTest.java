package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.catchThrowable;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Map;
import online.hmb.common.SqliteErrors;
import online.hmb.jobs.AiJobQueue;
import online.hmb.jobs.JobLeaseSweeper;
import online.hmb.meta.WalletService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 실패 경로 (AC-M7, AC-Q1): lease 만료 재배포, 매치 타임아웃 → FAILED, retry 복구,
 * complete(ok=false)의 attempts 정책 + W2 이월(CHECK 위반 판별).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchFailureTest extends MatchTestBase {

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
    private AiJobQueue jobQueue;

    @Resource
    private JobLeaseSweeper sweeper;

    @Resource
    private FakeServants fakeServants;

    @Resource
    private WalletService walletService;

    // ── AC-Q1: lease 만료 → queued 재배포 ────────────────────────────────

    @Test
    void expiredLeaseIsRequeuedBySweeper() {
        String now = Instant.now().toString();
        jdbcClient.sql("""
                        INSERT INTO ai_jobs(id, status, context_json, attempts, lease_until, worker_id,
                                            created_at, updated_at)
                        VALUES ('lease-test-job', 'leased', '{}', 1, ?, 'w-dead', ?, ?)
                        """)
                .params(Instant.now().minus(1, ChronoUnit.HOURS).toString(), now, now)
                .update();

        int requeued = sweeper.requeueExpiredLeases();

        assertThat(requeued).isGreaterThanOrEqualTo(1);
        String status = jdbcClient.sql("SELECT status FROM ai_jobs WHERE id = 'lease-test-job'")
                .query(String.class).single();
        assertThat(status).isEqualTo("queued");
    }

    // ── AC-M7: GEN 타임아웃 → FAILED → retry → 재큐잉 → 정상 완주 ────────

    @Test
    void timedOutMatchFailsThenRetryRecovers() {
        String token = setupUserWithDeck("m_timeout");
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        assertThat(matchState(matchId)).isEqualTo("GEN1");

        // 잡 생성 시각을 타임아웃(240s) 너머로 백데이트
        jdbcClient.sql("UPDATE ai_jobs SET created_at = ? WHERE match_id = ?")
                .params(Instant.now().minus(1, ChronoUnit.HOURS).toString(), matchId)
                .update();

        int failed = sweeper.failTimedOutMatches();
        assertThat(failed).isGreaterThanOrEqualTo(1);
        assertThat(matchState(matchId)).isEqualTo("FAILED");
        String failReason = jdbcClient.sql("SELECT fail_reason FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(failReason).contains("timeout");

        // retry → GEN1 복귀 + 잡 재큐잉 → drain으로 정상 완주
        ResponseEntity<Map> retry = authPost("/api/matches/" + matchId + "/retry", token, Map.of(), Map.class);
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(retry.getBody().get("state")).isEqualTo("GEN1");
        assertThat(retry.getBody().get("failReason")).isNull();

        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    // ── complete(ok=false): attempts<max → queued / 초과 → failed + 매치 FAILED ──

    // ── F1(W3 검증 레이스): timeout→FAILED→retry 후 잡 완료 전 sweep이 재-FAIL시키지 않아야 ──

    @Test
    void retryAfterTimeoutSurvivesNextSweepBeforeJobsComplete() {
        String token = setupUserWithDeck("m_retry_race");
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        assertThat(matchState(matchId)).isEqualTo("GEN1");

        // 잡을 타임아웃(240s) 너머로 백데이트 → sweep이 FAILED 처리
        jdbcClient.sql("UPDATE ai_jobs SET created_at = ? WHERE match_id = ?")
                .params(Instant.now().minus(1, ChronoUnit.HOURS).toString(), matchId)
                .update();
        assertThat(sweeper.failTimedOutMatches()).isGreaterThanOrEqualTo(1);
        assertThat(matchState(matchId)).isEqualTo("FAILED");

        // 유저 retry → GEN1 복귀. F1 수정 전엔 잡 created_at이 과거 그대로라 즉시 재-타임아웃 자격.
        ResponseEntity<Map> retry = authPost("/api/matches/" + matchId + "/retry", token, Map.of(), Map.class);
        assertThat(retry.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        assertThat(matchState(matchId)).isEqualTo("GEN1");

        // 실 서번트(초~분 지연)가 완료하기 전에 sweep이 한 번 더 돈다 → 재-FAIL되면 안 됨(F1 회귀 가드)
        assertThat(sweeper.failTimedOutMatches()).isEqualTo(0);
        assertThat(matchState(matchId)).isEqualTo("GEN1");

        // 이제 잡 완료 → 정상 완주
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    @Test
    void failedCompletionRequeuesUntilMaxAttemptsThenFailsMatch() {
        String token = setupUserWithDeck("m_jobfail");
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);

        String jobId = jdbcClient.sql(
                        "SELECT id FROM ai_jobs WHERE match_id = ? AND side = 'home' AND half = 1")
                .param(matchId).query(String.class).single();

        // attempts(0) < max(3) → queued 복귀
        jobQueue.complete(jobId, false, null, null, "transient error");
        assertThat(jobStatus(jobId)).isEqualTo("queued");
        assertThat(matchState(matchId)).isEqualTo("GEN1");

        // attempts를 max로 올린 뒤 실패 → failed + 매치 FAILED 전파
        jdbcClient.sql("UPDATE ai_jobs SET attempts = 3 WHERE id = ?").param(jobId).update();
        jobQueue.complete(jobId, false, null, null, "permanent error");
        assertThat(jobStatus(jobId)).isEqualTo("failed");
        assertThat(matchState(matchId)).isEqualTo("FAILED");
        String failReason = jdbcClient.sql("SELECT fail_reason FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(failReason).contains("permanent error");
    }

    // ── W2 이월: wallets CHECK 위반 판별(동시 뽑기 경합 → 400 매핑의 근거) ──

    @Test
    void walletCheckViolationIsDetectable() {
        setupUserWithDeck("m_check");
        String userId = userIdOf("m_check");

        Throwable thrown = catchThrowable(() ->
                walletService.apply(userId, -999999, "gacha_single", "check-test-ref"));

        assertThat(thrown).isInstanceOf(DataAccessException.class);
        assertThat(SqliteErrors.isCheckViolation((DataAccessException) thrown)).isTrue();

        // 원장도 잔액도 오염되지 않아야 함(호출측 트랜잭션이 롤백을 보장하지만, 단독 호출 검증)
        long balance = jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
        assertThat(balance).isEqualTo(3000L);
    }

    private String jobStatus(String jobId) {
        return jdbcClient.sql("SELECT status FROM ai_jobs WHERE id = ?")
                .param(jobId).query(String.class).single();
    }
}
