package online.hmb.jobs;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.Hashes;
import online.hmb.common.TxRunner;
import online.hmb.match.MatchOrchestrator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Lazy;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * AI 잡 큐 (ADR-1: Java 소유, ERD ai_jobs). id = promptHash(sha256(canonicalJson(context))[:32])
 * = 멱등 키 — 같은 컨텍스트 재요청은 같은 행(L1 캐시 의미론, AC-Q2).
 *
 * W3 범위: enqueue + complete(성공/실패 상태 전이) + lease 만료/타임아웃 스윕(AC-Q1/M7).
 * long-poll HTTP(/internal/ai-jobs/poll)는 W4 — 그때 이 서비스의 lease()를 그대로 쓴다.
 */
@Service
public class AiJobQueue {

    private static final Logger log = LoggerFactory.getLogger(AiJobQueue.class);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final MatchOrchestrator orchestrator;
    private final int leaseSec;
    private final int maxAttempts;

    public AiJobQueue(JdbcClient jdbcClient,
                      TxRunner txRunner,
                      @Lazy MatchOrchestrator orchestrator, // complete → onJobDone 콜백(순환 절단)
                      @Value("${hmb.match.lease-sec}") int leaseSec,
                      @Value("${hmb.match.max-attempts}") int maxAttempts) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.orchestrator = orchestrator;
        this.leaseSec = leaseSec;
        this.maxAttempts = maxAttempts;
    }

    public record JobRow(String id, String matchId, String side, Integer half, String status,
                         String contextJson, String resultJson, int attempts) {
    }

    /**
     * enqueue — INSERT OR IGNORE(id=promptHash 멱등). 이미 done인 행이면 재사용(AC-Q2).
     * @return 잡 id
     */
    public String enqueue(String matchId, String side, int half, Map<String, Object> context) {
        String id = Hashes.jobId(context);
        String now = Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO ai_jobs(id, match_id, side, half, status, context_json,
                                                      attempts, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'queued', ?, 0, ?, ?)
                        """)
                .params(id, matchId, side, half, Hashes.canonicalJson(context), now, now)
                .update();
        return id;
    }

    public Optional<JobRow> find(String jobId) {
        return jdbcClient.sql("""
                        SELECT id, match_id, side, half, status, context_json, result_json, attempts
                        FROM ai_jobs WHERE id = ?
                        """)
                .param(jobId)
                .query((rs, n) -> new JobRow(rs.getString("id"), rs.getString("match_id"),
                        rs.getString("side"), (Integer) rs.getObject("half"), rs.getString("status"),
                        rs.getString("context_json"), rs.getString("result_json"), rs.getInt("attempts")))
                .optional();
    }

    public List<JobRow> queuedJobs() {
        return jdbcClient.sql("""
                        SELECT id, match_id, side, half, status, context_json, result_json, attempts
                        FROM ai_jobs WHERE status = 'queued' ORDER BY created_at
                        """)
                .query((rs, n) -> new JobRow(rs.getString("id"), rs.getString("match_id"),
                        rs.getString("side"), (Integer) rs.getObject("half"), rs.getString("status"),
                        rs.getString("context_json"), rs.getString("result_json"), rs.getInt("attempts")))
                .list();
    }

    /**
     * 잡 1개 lease(가시성 타임아웃) — status=leased, lease_until=now+lease-sec, attempts+1 (LLD §6).
     * W4 long-poll이 이 메서드를 사용. 반환 없으면 큐 비어 있음.
     */
    public Optional<JobRow> lease(String workerId) {
        return txRunner.run(() -> {
            Optional<String> id = jdbcClient.sql(
                            "SELECT id FROM ai_jobs WHERE status = 'queued' ORDER BY created_at LIMIT 1")
                    .query(String.class)
                    .optional();
            if (id.isEmpty()) {
                return Optional.empty();
            }
            String leaseUntil = Instant.now().plusSeconds(leaseSec).toString();
            int updated = jdbcClient.sql("""
                            UPDATE ai_jobs SET status = 'leased', lease_until = ?, worker_id = ?,
                                   attempts = attempts + 1, updated_at = ?
                            WHERE id = ? AND status = 'queued'
                            """)
                    .params(leaseUntil, workerId, Instant.now().toString(), id.get())
                    .update();
            return updated == 1 ? find(id.get()) : Optional.empty();
        });
    }

    /**
     * 완료 보고 (LLD §6). ok=true → done + Orchestrator.onJobDone.
     * ok=false → attempts<max면 queued 복귀, 아니면 failed + 매치 FAILED 전파.
     */
    public void complete(String jobId, boolean ok, String resultJson, String usageJson, String error) {
        JobRow job = find(jobId)
                .orElseThrow(() -> new IllegalStateException("잡을 찾을 수 없습니다: " + jobId));

        if (ok) {
            int updated = jdbcClient.sql("""
                            UPDATE ai_jobs SET status = 'done', result_json = ?, usage_json = ?,
                                   error = NULL, updated_at = ?
                            WHERE id = ? AND status IN ('queued', 'leased')
                            """)
                    .params(resultJson, usageJson, Instant.now().toString(), jobId)
                    .update();
            if (updated == 1) {
                orchestrator.onJobDone(jobId);
            }
            return;
        }

        if (job.attempts() < maxAttempts) {
            jdbcClient.sql("""
                            UPDATE ai_jobs SET status = 'queued', error = ?, lease_until = NULL,
                                   worker_id = NULL, updated_at = ?
                            WHERE id = ? AND status IN ('queued', 'leased')
                            """)
                    .params(error, Instant.now().toString(), jobId)
                    .update();
            log.warn("job {} failed (attempts={}/{}) — requeued: {}", jobId, job.attempts(), maxAttempts, error);
        } else {
            jdbcClient.sql("""
                            UPDATE ai_jobs SET status = 'failed', error = ?, updated_at = ?
                            WHERE id = ? AND status IN ('queued', 'leased')
                            """)
                    .params(error, Instant.now().toString(), jobId)
                    .update();
            if (job.matchId() != null) {
                orchestrator.failMatch(job.matchId(), "ai job failed: " + error);
            }
            log.warn("job {} failed permanently (attempts={}) — match {} FAILED", jobId, job.attempts(),
                    job.matchId());
        }
    }

    /** lease 만료 잡 재배포 (AC-Q1). @return 재큐잉 수 */
    public int requeueExpiredLeases() {
        return jdbcClient.sql("""
                        UPDATE ai_jobs SET status = 'queued', lease_until = NULL, worker_id = NULL,
                               updated_at = ?
                        WHERE status = 'leased' AND lease_until < ?
                        """)
                .params(Instant.now().toString(), Instant.now().toString())
                .update();
    }

    /** 해당 half의 미완(done 아님) 잡이 있고 cutoff보다 오래된 GEN* 매치 id들. */
    public List<String> timedOutGenMatches(String cutoffIso) {
        return jdbcClient.sql("""
                        SELECT DISTINCT m.id FROM matches m
                        JOIN ai_jobs j ON j.match_id = m.id
                             AND j.half = CASE m.state WHEN 'GEN1' THEN 1 ELSE 2 END
                        WHERE m.state IN ('GEN1', 'GEN2')
                          AND j.status != 'done'
                          AND j.created_at < ?
                        """)
                .param(cutoffIso)
                .query(String.class)
                .list();
    }
}
