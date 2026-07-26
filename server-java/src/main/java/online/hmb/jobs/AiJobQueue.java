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
     * complete 수용 조건 (#193 D2) — <b>leased</b> 이거나, <b>한 번 이상 배포됐던 queued</b>(attempts&gt;0).
     *
     * <p>실제 AI 잡이 lease-sec 을 넘기면 {@link JobLeaseSweeper} 가 잡을 queued 로 되돌린다. 그 뒤
     * 도착한 결과를 "leased 아님"으로 거부하면 <b>정상 결과가 폐기</b>되고 같은 잡이 무한 재실행되어
     * ai-job-timeout 에 매치가 FAILED 된다(라이브락). 결과 자체는 유효하므로 수용한다 —
     * 늦게 온 것이지 틀린 것이 아니다. (근본 예방은 lease-sec &ge; ai-job-timeout-sec, application.yml.)
     *
     * <p>attempts=0 인 queued(한 번도 lease 되지 않은 유령 complete)는 계속 409 로 막는다.
     */
    public static boolean completable(JobRow job) {
        return "leased".equals(job.status()) || ("queued".equals(job.status()) && job.attempts() > 0);
    }

    /** {@link #completable(JobRow)} 의 SQL 술어 — 수용 UPDATE 의 CAS(정확히 1회)에 그대로 쓴다. */
    private static final String COMPLETABLE_CAS =
            "(status = 'leased' OR (status = 'queued' AND attempts > 0))";

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

    /**
     * A(베이스 생성) 잡 enqueue — 크로스매치 캐시. id = sha256(baseContextKeyMaterial)[:32]
     * (BaseContextKey, 덱 스냅샷만 — matchId/side/half/seed 제외)라 <b>여러 매치·양팀이 같은 행을 공유</b>한다.
     * 그래서 큐 라우팅 메타(match_id/side/half)는 NULL 로 둔다(특정 매치·half 에 매이지 않음 → onJobDone·
     * latestDoneResult 의 per-side/half 조회에 걸리지 않는다). INSERT OR IGNORE(id 멱등) — 이미 있으면 no-op.
     *
     * @param baseId sha256(material)[:32]
     */
    public void enqueueBase(String baseId, Map<String, Object> context) {
        String now = Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO ai_jobs(id, match_id, side, half, status, context_json,
                                                      attempts, created_at, updated_at)
                        VALUES (?, NULL, NULL, NULL, 'queued', ?, 0, ?, ?)
                        """)
                .params(baseId, Hashes.canonicalJson(context), now, now)
                .update();
    }

    /**
     * A 결과(또는 h1 최종 인풋) 재사용을 per-match·per-side·per-half done 행으로 <b>물질화</b>(콜 0).
     * B(패치) 없이 A/h1 인풋을 그대로 쓸 때(추가 프롬프트/교체 없음), Java 가 seed 만 교체한 TacticalInput 을
     * 이 매치의 (side,half) done 행으로 직접 삽입해 maybeSimulate 가 집도록 한다(서번트 콜 없음).
     * id 는 (matchId,half,side) 결정 — INSERT OR IGNORE 멱등(재개/재시도 재-enqueue 안전).
     *
     * @param resultJson seed 가 이미 해당 halfSeed 로 교체된 완전한 TacticalInput
     * @return 잡 id (materialize 행의 결정론 id)
     */
    public String insertMaterialized(String matchId, String side, int half, String resultJson) {
        String id = materializedId(matchId, half, side);
        String now = Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO ai_jobs(id, match_id, side, half, status, context_json,
                                                      result_json, attempts, created_at, updated_at)
                        VALUES (?, ?, ?, ?, 'done', ?, ?, 0, ?, ?)
                        """)
                .params(id, matchId, side, half,
                        "{\"kind\":\"materialized\"}", resultJson, now, now)
                .update();
        return id;
    }

    /** materialize 행 id — (matchId, half, side) 결정론(멱등 재삽입·supersede 대상 식별). */
    public static String materializedId(String matchId, int half, String side) {
        return Hashes.sha256Hex("materialized:" + matchId + ":" + half + ":" + side).substring(0, 32);
    }

    /**
     * (match, half, side) 의 <b>유효 잡</b>을 {@code targetId} 하나로 좁힌다 — h2 선행 생성(#193 W2b-B2)
     * 때문에 <b>GEN 진입 전에 결과가 이미 존재</b>할 수 있고, 그 사이 지시(하프타임 프롬프트)·교체가
     * 바뀌면 그 결과는 무효다. 무효 행이 남으면 {@code latestDoneResult} 가 그걸 집어 <b>유저의 최신
     * 입력을 무시한 채</b> 시뮬해 버린다(교체 경로면 로스터-인풋 불일치).
     *
     * <p><b>왜 삭제가 아니라 플래그인가</b>(#193 검증 B-2). 예전엔 done 행을 지워서 무효화했는데, 그건
     * 두 구멍을 남겼다. ① 워커가 물고 있는 행(leased·재큐)은 complete 404 를 피하려고 살려뒀는데,
     * 그 <b>늦은 complete</b> 가 {@code updated_at} 을 지금으로 밀어 "가장 최근 done" 이 되어버렸다 —
     * 즉 낡은 결과가 최신 지시를 이겼다(시간은 "유저가 언제 지시했나"가 아니라 "워커가 언제 보고했나"다).
     * ② done 행을 지우면 promptHash 멱등 캐시도 같이 날아가, 지시를 A→B→A 로 되돌리면 이미 만들어 둔
     * 결과를 두고 AI 를 다시 태웠다.
     *
     * <p>그래서 이제: <b>아무도 안 들고 있고 재사용 가치도 없는 행</b>(한 번도 배포되지 않은
     * {@code queued}, attempts=0)만 지우고, 나머지(done 캐시 · 워커가 물고 있는 leased/재큐)는
     * <b>남기되 {@code effective=0}</b> 으로 무효 표시한다. 대상은 {@code effective=1} 로 (재)지정 —
     * 되돌린 지시가 예전 done 행을 그대로 복권시킨다.
     *
     * @return 지우거나 무효화한 행 수
     */
    public int supersede(String matchId, int half, String side, String targetId) {
        int removed = jdbcClient.sql("""
                        DELETE FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = ? AND id <> ?
                          AND status = 'queued' AND attempts = 0
                        """)
                .params(matchId, half, side, targetId)
                .update();
        int invalidated = jdbcClient.sql("""
                        UPDATE ai_jobs SET effective = 0
                        WHERE match_id = ? AND half = ? AND side = ? AND id <> ? AND effective = 1
                        """)
                .params(matchId, half, side, targetId)
                .update();
        jdbcClient.sql("UPDATE ai_jobs SET effective = 1 WHERE id = ? AND effective = 0")
                .param(targetId)
                .update();
        return removed + invalidated;
    }

    /**
     * 해당 half 의 미완 잡 타임아웃 시계를 지금으로 리셋한다 — {@code timedOutGenMatches} 는
     * created_at 을 "현재 pending 사이클 시작"으로 보는데(MatchService.retryCas 주석), h2 선행 생성은
     * GEN2 진입보다 한 하프 앞서 잡을 만든다. 리셋하지 않으면 GEN2 에 들어서자마자 이미 타임아웃
     * 자격을 갖춘 잡이 매치를 FAILED 시킨다(유예 0). GEN 진입 시점에만 호출한다.
     *
     * @return 리셋한 행 수
     */
    public int restartPendingTimeout(String matchId, int half) {
        String now = Instant.now().toString();
        return jdbcClient.sql("""
                        UPDATE ai_jobs SET created_at = ?, updated_at = ?
                        WHERE match_id = ? AND half = ? AND status != 'done'
                        """)
                .params(now, now, matchId, half)
                .update();
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
            // 우선순위 (#193 D3): 매치 잡(유저가 화면에서 대기) > 배경 A-프리페치(match_id NULL).
            // 단일 FIFO(ORDER BY created_at)면 매치 생성 시 들어간 프리페치가 킥오프 잡을 앞질러
            // 워커를 점유해 head-of-line 블로킹이 된다(유저 대기시간이 프리페치 시간만큼 늘어남).
            // effective=0 (supersede 된 잡)은 배포하지 않는다 — 결과가 쓰이지 않을 잡에 AI 콜을 태우지
            // 않는다(#193 검증 B-2). 지우지 않고 남기는 이유는 supersede javadoc 참조.
            Optional<String> id = jdbcClient.sql("""
                            SELECT id FROM ai_jobs WHERE status = 'queued' AND effective = 1
                            ORDER BY (match_id IS NULL), created_at LIMIT 1
                            """)
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
     *
     * <p>모든 상태 UPDATE 는 {@link #COMPLETABLE_CAS} 로 CAS — lease 만료로 재큐된 잡(queued,
     * attempts&gt;0)의 결과도 수용하되(#193 D2) 중복 complete 는 정확히 1회만 반영한다(done 이 되면
     * 술어가 더 이상 맞지 않는다).
     */
    public void complete(String jobId, boolean ok, String resultJson, String usageJson, String error) {
        JobRow job = find(jobId)
                .orElseThrow(() -> new IllegalStateException("잡을 찾을 수 없습니다: " + jobId));
        if (!"leased".equals(job.status()) && completable(job)) {
            log.info("job {} complete accepted after lease expiry (status={}, attempts={}) — #193 D2",
                    jobId, job.status(), job.attempts());
        }

        if (ok) {
            int updated = jdbcClient.sql("""
                            UPDATE ai_jobs SET status = 'done', result_json = ?, usage_json = ?,
                                   error = NULL, updated_at = ?
                            WHERE id = ? AND """ + COMPLETABLE_CAS)
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
                            WHERE id = ? AND """ + COMPLETABLE_CAS)
                    .params(error, Instant.now().toString(), jobId)
                    .update();
            log.warn("job {} failed (attempts={}/{}) — requeued: {}", jobId, job.attempts(), maxAttempts, error);
        } else {
            jdbcClient.sql("""
                            UPDATE ai_jobs SET status = 'failed', error = ?, updated_at = ?
                            WHERE id = ? AND """ + COMPLETABLE_CAS)
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

    /**
     * 해당 half의 미완(done 아님) <b>유효</b> 잡이 있고 cutoff보다 오래된 GEN* 매치 id들.
     * supersede 된 잡(effective=0)은 매치가 기다리는 대상이 아니므로 타임아웃 근거가 될 수 없다 —
     * 그걸로 FAILED 시키면 최신 지시 잡이 정상인데도 매치가 죽는다(#193 검증 B-2).
     */
    public List<String> timedOutGenMatches(String cutoffIso) {
        return jdbcClient.sql("""
                        SELECT DISTINCT m.id FROM matches m
                        JOIN ai_jobs j ON j.match_id = m.id
                             AND j.half = CASE m.state WHEN 'GEN1' THEN 1 ELSE 2 END
                        WHERE m.state IN ('GEN1', 'GEN2')
                          AND j.status != 'done'
                          AND j.effective = 1
                          AND j.created_at < ?
                        """)
                .param(cutoffIso)
                .query(String.class)
                .list();
    }
}
