package online.hmb.jobs;

import java.time.Instant;
import java.util.List;
import online.hmb.match.MatchOrchestrator;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

/**
 * 잡 lease/타임아웃 감시 (@Scheduled 10s, LLD §6):
 * 1. lease_until 경과한 leased 잡 → queued 복귀(AC-Q1 — 워커가 죽어도 재배포).
 * 2. ai-job-timeout-sec을 넘긴 GEN* 매치(미완 잡 존재) → FAILED(fail_reason, AC-M7 재시도 대상).
 * 테스트는 sweep 메서드를 직접 호출한다(타이밍 비의존).
 */
@Component
public class JobLeaseSweeper {

    private static final Logger log = LoggerFactory.getLogger(JobLeaseSweeper.class);

    private final AiJobQueue jobQueue;
    private final MatchOrchestrator orchestrator;
    private final int aiJobTimeoutSec;

    public JobLeaseSweeper(AiJobQueue jobQueue,
                           MatchOrchestrator orchestrator,
                           @Value("${hmb.match.ai-job-timeout-sec}") int aiJobTimeoutSec) {
        this.jobQueue = jobQueue;
        this.orchestrator = orchestrator;
        this.aiJobTimeoutSec = aiJobTimeoutSec;
    }

    @Scheduled(fixedDelayString = "${hmb.match.sweep-interval-ms}")
    public void sweep() {
        int requeued = requeueExpiredLeases();
        int failed = failTimedOutMatches();
        if (requeued > 0 || failed > 0) {
            log.info("sweep: {} leases requeued, {} matches timed out", requeued, failed);
        }
    }

    public int requeueExpiredLeases() {
        return jobQueue.requeueExpiredLeases();
    }

    public int failTimedOutMatches() {
        String cutoff = Instant.now().minusSeconds(aiJobTimeoutSec).toString();
        List<String> timedOut = jobQueue.timedOutGenMatches(cutoff);
        for (String matchId : timedOut) {
            orchestrator.failMatch(matchId, "ai-job timeout (" + aiJobTimeoutSec + "s)");
        }
        return timedOut.size();
    }
}
