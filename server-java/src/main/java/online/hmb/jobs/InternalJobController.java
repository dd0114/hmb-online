package online.hmb.jobs;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 서번트 전용 AI 잡 큐 프로토콜 (LLD §6, W4). /internal/** 는 ServantTokenInterceptor가 보호.
 *
 * - POST /internal/ai-jobs/poll  : long-poll lease (200 잡 / 204 대기 후 빈 큐).
 * - POST /internal/ai-jobs/{id}/complete : 완료 보고 (done / requeue / failed). leased 아니면 409.
 *
 * long-poll은 virtual thread(spring.threads.virtual.enabled) 위에서 블로킹으로 대기한다.
 */
@RestController
public class InternalJobController {

    private static final Logger log = LoggerFactory.getLogger(InternalJobController.class);
    private static final int MAX_WAIT_MS = 25000;

    private final AiJobQueue jobQueue;
    private final ObjectMapper objectMapper;
    private final long pollIntervalMs;

    public InternalJobController(AiJobQueue jobQueue,
                                 ObjectMapper objectMapper,
                                 @Value("${hmb.match.poll-interval-ms}") long pollIntervalMs) {
        this.jobQueue = jobQueue;
        this.objectMapper = objectMapper;
        this.pollIntervalMs = pollIntervalMs;
    }

    // ── 요청/응답 DTO ────────────────────────────────────────────────────

    public record PollRequest(String workerId, Integer waitMs) {
    }

    /**
     * poll/complete 응답 (openapi AiJob). context/result는 저장된 JSON을 verbatim 파싱한 트리 —
     * 서번트/TS 실행기가 이 context로 TacticalInput을 만든다(필드 유실 없이 그대로 전달).
     */
    public record AiJobResponse(String id, String status, String matchId, String side, Integer half,
                                JsonNode context, JsonNode result, Integer attempts) {
    }

    // ── POST /internal/ai-jobs/poll ──────────────────────────────────────

    @PostMapping("/internal/ai-jobs/poll")
    public ResponseEntity<AiJobResponse> poll(@RequestBody PollRequest request) throws InterruptedException {
        if (request == null || request.workerId() == null || request.workerId().isBlank()) {
            throw ApiException.validation("workerId가 필요합니다");
        }
        int waitMs = request.waitMs() == null ? MAX_WAIT_MS : Math.max(0, Math.min(MAX_WAIT_MS, request.waitMs()));
        long deadlineNanos = System.nanoTime() + waitMs * 1_000_000L;

        while (true) {
            Optional<AiJobQueue.JobRow> leased = jobQueue.lease(request.workerId());
            if (leased.isPresent()) {
                return ResponseEntity.ok(toResponse(leased.get()));
            }
            long remainingMs = (deadlineNanos - System.nanoTime()) / 1_000_000L;
            if (remainingMs <= 0) {
                return ResponseEntity.noContent().build(); // 204 — waitMs 동안 큐가 비어 있었음
            }
            Thread.sleep(Math.min(pollIntervalMs, remainingMs));
        }
    }

    // ── POST /internal/ai-jobs/{id}/complete ─────────────────────────────

    @PostMapping("/internal/ai-jobs/{id}/complete")
    public AiJobResponse complete(@PathVariable("id") String id, @RequestBody JsonNode body) {
        AiJobQueue.JobRow job = jobQueue.find(id)
                .orElseThrow(() -> ApiException.notFound("잡을 찾을 수 없습니다: " + id));
        // leased 상태에서만 완료 보고 허용(중복/유령 complete 차단). openapi ErrorCode 열거는 F4 외
        // 프리즈 상태이므로 신규 JOB_NOT_LEASED 대신 기존 INVALID_STATE를 재사용한다(의미상 최근접).
        if (!"leased".equals(job.status())) {
            throw new ApiException(HttpStatus.CONFLICT, "INVALID_STATE",
                    "잡이 leased 상태가 아닙니다: " + job.status(),
                    Map.of("jobId", id, "status", job.status()));
        }

        boolean ok = body != null && body.path("ok").asBoolean(false);
        // output/usage는 받은 JSON을 그대로 저장(재직렬화로 필드 유실 없음 — TS zod가 이 원문을 파싱).
        String resultJson = body != null && body.hasNonNull("output") ? body.get("output").toString() : null;
        String usageJson = body != null && body.hasNonNull("usage") ? body.get("usage").toString() : null;
        String error = body != null && body.hasNonNull("error") ? body.get("error").asText() : null;

        if (ok && resultJson == null) {
            throw ApiException.validation("ok=true면 output이 필요합니다");
        }

        jobQueue.complete(id, ok, resultJson, usageJson, error);
        return toResponse(jobQueue.find(id).orElseThrow(
                () -> ApiException.notFound("잡을 찾을 수 없습니다: " + id)));
    }

    // ── 내부 ─────────────────────────────────────────────────────────────

    private AiJobResponse toResponse(AiJobQueue.JobRow job) {
        return new AiJobResponse(job.id(), job.status(), job.matchId(), job.side(), job.half(),
                parse(job.contextJson()), parse(job.resultJson()), job.attempts());
    }

    private JsonNode parse(String json) {
        if (json == null) {
            return null;
        }
        try {
            return objectMapper.readTree(json);
        } catch (Exception e) {
            log.warn("ai_jobs JSON 파싱 실패(원문 유지 불가): {}", e.getMessage());
            throw new IllegalStateException("ai_jobs JSON 파싱 실패", e);
        }
    }
}
