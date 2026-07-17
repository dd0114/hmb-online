package online.hmb.jobs;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /internal/health — 큐 깊이·lease 중 개수 (LLD §6, 운영 확인용).
 * W4: ServantTokenInterceptor가 /internal/** 전체(이 health 포함)를 X-Servant-Token으로 보호한다
 * (AC-Q3 — W0의 "TODO W4: 인증" 해소). 토큰 없으면 401.
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
