package online.hmb.jobs;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /internal/health — 큐 깊이·lease 중 개수 (LLD §6, 운영 확인용).
 * W0: ai_jobs 테이블은 존재하나 아직 아무도 쓰지 않으므로 항상 0 — 실질 구현은 W4(AiJobQueue)에서.
 * TODO(W4): X-Servant-Token 인터셉터로 /internal/** 보호(AC-Q3). W0에는 poll/complete 엔드포인트가
 * 아직 없어 인터셉터를 붙일 대상이 이 헬스체크뿐이므로 보류.
 */
@RestController
public class InternalHealthController {

    private final JdbcClient jdbcClient;

    public InternalHealthController(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    @GetMapping("/internal/health")
    public HealthResponse health() {
        long queued = jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE status = 'queued'")
                .query(Long.class)
                .single();
        long leased = jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE status = 'leased'")
                .query(Long.class)
                .single();
        return new HealthResponse(queued, leased);
    }

    public record HealthResponse(long queueDepth, long leasedCount) {
    }
}
