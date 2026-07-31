package online.hmb.engine;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.LinkedHashMap;
import java.util.Map;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * ts-servants 엔진러너 HTTP 클라이언트 (LLD §5.3).
 * POST {engine-runner-url}/simulate {seed, selectData, homeInput, awayInput, half, resumeState?}
 * → {matchLog, resumeState?, lastHash}. 타임아웃·재시도는 config(LLD 기본 30s·1회 재시도).
 * 실패(재시도 소진) 시 예외 → 호출측(MatchOrchestrator)이 매치를 FAILED로 전이.
 */
@Component
public class EngineRunnerClient {

    private static final Logger log = LoggerFactory.getLogger(EngineRunnerClient.class);

    private final ObjectMapper objectMapper;
    private final String runnerUrl;
    private final Duration timeout;
    private final int retries;
    private final HttpClient httpClient;

    public EngineRunnerClient(ObjectMapper objectMapper,
                              @Value("${hmb.servant.engine-runner-url}") String runnerUrl,
                              @Value("${hmb.servant.simulate-timeout-sec}") long timeoutSec,
                              @Value("${hmb.servant.simulate-retries}") int retries) {
        this.objectMapper = objectMapper;
        this.runnerUrl = runnerUrl;
        this.timeout = Duration.ofSeconds(timeoutSec);
        this.retries = retries;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    /**
     * @param playbackMs 이 하프를 연출 페이싱으로 다 보는 데 걸리는 실시간(ms) — <b>0 이면 러너가
     *                   안 준 것</b>(구 러너)이고, 그때는 {@code hmb.match.clock.half-real-ms} 폴백을 쓴다.
     *                   서버가 이 값을 하프 창으로 쓰면 창 == 재생 길이가 되어 클라의 배속 보정이
     *                   불필요해진다(#365, hero 확정: 고정 배속만).
     */
    public record SimulateResult(JsonNode matchLog, JsonNode resumeState, String lastHash, long playbackMs) {
    }

    /**
     * @param resumeState h1의 resume 상태(승계 시) — 교체가 있으면 null(독립 시뮬, LLD §5.4).
     */
    public SimulateResult simulate(String seed, Object selectData, Object homeInput, Object awayInput,
                                   int half, JsonNode resumeState) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("seed", seed);
        body.put("selectData", selectData);
        body.put("homeInput", homeInput);
        body.put("awayInput", awayInput);
        body.put("half", half);
        if (resumeState != null && !resumeState.isNull()) {
            body.put("resumeState", resumeState);
        }

        RuntimeException last = null;
        for (int attempt = 0; attempt <= retries; attempt++) {
            try {
                return callOnce(body);
            } catch (RuntimeException e) {
                last = e;
                log.warn("simulate attempt {}/{} failed: {}", attempt + 1, retries + 1, e.toString());
            }
        }
        throw new IllegalStateException("엔진러너 simulate 실패(재시도 소진): " + last.getMessage(), last);
    }

    private SimulateResult callOnce(Map<String, Object> body) {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(runnerUrl + "/simulate"))
                    .timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body)))
                    .build();
            HttpResponse<String> response = httpClient.send(request, HttpResponse.BodyHandlers.ofString());
            if (response.statusCode() != 200) {
                throw new IllegalStateException("runner HTTP " + response.statusCode() + ": "
                        + truncate(response.body()));
            }
            JsonNode root = objectMapper.readTree(response.body());
            JsonNode matchLog = root.path("matchLog");
            if (matchLog.isMissingNode() || !matchLog.has("finalScore")) {
                // 스키마 검증은 러너 책임(TS zod) — 여기선 최소 형태만 검사 (LLD §5.3)
                throw new IllegalStateException("runner 응답에 matchLog가 없습니다");
            }
            JsonNode resume = root.has("resumeState") ? root.get("resumeState") : null;
            // additive optional — 없으면 0(= 서버가 config 폴백을 쓴다는 신호).
            long playbackMs = root.path("playbackMs").asLong(0L);
            return new SimulateResult(matchLog, resume, root.path("lastHash").asText(), playbackMs);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("runner 호출 실패: " + e.getMessage(), e);
        }
    }

    private static String truncate(String s) {
        return s == null ? "" : s.substring(0, Math.min(s.length(), 300));
    }
}
