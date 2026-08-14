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
import online.hmb.common.ApiException;
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
    /** 교환 전체(헤더+본문)의 벽시계 마감 — 생성자 주석 참조(#512). */
    private final Duration hardDeadline;
    private final int retries;
    private final HttpClient httpClient;

    public EngineRunnerClient(ObjectMapper objectMapper,
                              @Value("${hmb.servant.engine-runner-url}") String runnerUrl,
                              @Value("${hmb.servant.simulate-timeout-sec}") long timeoutSec,
                              @Value("${hmb.servant.simulate-retries}") int retries) {
        this.objectMapper = objectMapper;
        this.runnerUrl = runnerUrl;
        this.timeout = Duration.ofSeconds(timeoutSec);
        // ⚠️ **교환 전체의 벽시계 마감**(#512). `HttpRequest.timeout` 은 **응답 헤더까지**만 센다 —
        // 헤더가 온 뒤 본문이 멈추면 `send()` 는 그 자리에 영원히 매달린다(JDK 21 실측: 요청
        // 타임아웃 3s 에 120s 넘게 반환 없음). 이 호출은 **매치 시계 스위퍼 스레드가 직접 탈 수
        // 있고**(AI 인풋이 양쪽 다 재사용으로 해소되는 경로), 스위퍼는 `@Scheduled(fixedDelay)` 라
        // 한 번 매달리면 **모든 매치의 자동 진행이 재시작 전까지 멈춘다**. 그래서 헤더 타임아웃과
        // 별개로 마감을 하나 더 건다. 2배인 이유 = 헤더 몫과 본문 몫을 같은 예산으로 보되(매치
        // 로그는 수 MB 라 본문 전송이 짧지 않다) 상한은 반드시 유한하게 두려는 것.
        this.hardDeadline = this.timeout.multipliedBy(2);
        this.retries = retries;
        this.httpClient = HttpClient.newBuilder()
                .connectTimeout(Duration.ofSeconds(5))
                .build();
    }

    /**
     * 마감이 걸린 동기 호출 — {@code send()} 자리를 전부 이것으로 바꾼다(#512).
     *
     * <p>{@code sendAsync} + {@code get(마감)} 이라야 <b>본문 정지</b>까지 끊긴다. 초과 시
     * {@code cancel(true)} 로 교환 자체를 끊는다 — 안 끊으면 호출자는 풀려나도 소켓과 읽기 작업이
     * 남는다.
     */
    private HttpResponse<String> sendBounded(HttpRequest request) throws Exception {
        java.util.concurrent.CompletableFuture<HttpResponse<String>> pending =
                httpClient.sendAsync(request, HttpResponse.BodyHandlers.ofString());
        try {
            return pending.get(hardDeadline.toMillis(), java.util.concurrent.TimeUnit.MILLISECONDS);
        } catch (java.util.concurrent.TimeoutException e) {
            pending.cancel(true);
            throw new IllegalStateException("runner 응답 마감 초과(" + hardDeadline.toSeconds() + "s): "
                    + request.uri());
        } catch (InterruptedException e) {
            /*
             * ⚠️ **인터럽트는 재시도하지 않는다**(#512 R1, 독립 검증 m4). 이걸 그냥 흘리면
             * `callOnce` 의 `catch (Exception)` 이 IllegalStateException 으로 감싸고, `simulate` 의
             * 재시도 루프가 **인터럽트 플래그가 지워진 채 한 번 더** 러너를 부른다(최대 마감만큼 더).
             * 인터럽트가 오는 자리는 `sweepPool.shutdownNow()`(= 종료 중)라, 그때 새 왕복을 시작하는
             * 것은 종료를 늦출 뿐이다. 플래그를 되살리고 교환도 끊는다.
             */
            pending.cancel(true);
            Thread.currentThread().interrupt();
            throw e;
        } catch (java.util.concurrent.ExecutionException e) {
            Throwable cause = e.getCause() == null ? e : e.getCause();
            if (cause instanceof Exception ex) {
                throw ex;
            }
            throw new IllegalStateException("runner 호출 실패: " + cause, cause);
        }
    }

    /**
     * @param playbackMs 이 하프를 연출 페이싱으로 다 보는 데 걸리는 실시간(ms) — <b>0 이면 러너가
     *                   안 준 것</b>(구 러너)이고, 그때는 {@code hmb.match.clock.half-real-ms} 폴백을 쓴다.
     *                   서버가 이 값을 하프 창으로 쓰면 창 == 재생 길이가 되어 클라의 배속 보정이
     *                   불필요해진다(#365, hero 확정: 고정 배속만).
     */
    public record SimulateResult(JsonNode matchLog, JsonNode resumeState, String lastHash, long playbackMs,
                                 String effectiveConfigHash, JsonNode droppedOverrides) {
    }

    /**
     * @param resumeState h1의 resume 상태(승계 시) — 교체가 있으면 null(독립 시뮬, LLD §5.4).
     * @param configOverrides 이 <b>매치가 시작할 때</b> 박힌 계수 오버레이(#383) — null 이면 실지 않는다.
     *     <b>라이브 값을 여기서 조회하지 않는다</b>: 값은 호출부가 매치 행에서 읽어 넘긴다. 그래야
     *     전·후반이 같은 config 로 돌고, 운영이 그 사이 값을 바꿔도 진행 중 매치가 흔들리지 않는다
     *     (#241 재발 방지). 오버레이가 없으면 요청 본문에 키가 <b>아예 없어</b> 구 배포와 같은 와이어다.
     */
    public SimulateResult simulate(String seed, Object selectData, Object homeInput, Object awayInput,
                                   int half, JsonNode resumeState, JsonNode configOverrides) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("seed", seed);
        body.put("selectData", selectData);
        body.put("homeInput", homeInput);
        body.put("awayInput", awayInput);
        body.put("half", half);
        if (resumeState != null && !resumeState.isNull()) {
            body.put("resumeState", resumeState);
        }
        if (configOverrides != null && !configOverrides.isNull() && !configOverrides.isEmpty()) {
            body.put("configOverrides", configOverrides);
        }

        RuntimeException last = null;
        for (int attempt = 0; attempt <= retries; attempt++) {
            try {
                return callOnce(body);
            } catch (RuntimeException e) {
                last = e;
                log.warn("simulate attempt {}/{} failed: {}", attempt + 1, retries + 1, e.toString());
                // 인터럽트(= 종료 중)면 재시도하지 않는다 — `callOnce` 가 검사예외를 런타임으로
                // 감싸므로 종류로는 못 가른다. 플래그로 가른다(`sendBounded` 가 되살려 둔다).
                //
                // ⚠️ **이 줄은 백스톱이고, 계약이 무는 것은 이 줄이 아니다**(변이 실측): 지워도
                // 다음 시도의 `pending.get()` 이 **선 플래그 때문에 즉시** InterruptedException 을
                // 내서 결과가 같다. 진짜 성질은 `sendBounded` 의 플래그 복원이고, 그걸 지우면
                // 계약이 죽는다. 이 줄은 "왜 안 도는가"를 로그·의도로 남기는 몫이다.
                if (Thread.currentThread().isInterrupted()) {
                    throw new IllegalStateException("엔진러너 simulate 중단(인터럽트): " + e.getMessage(), e);
                }
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
            HttpResponse<String> response = sendBounded(request);
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
            // #383 additive optional — 구 러너는 안 준다(그때는 engine_version 만이 근거였다).
            String configHash = root.hasNonNull("effectiveConfigHash")
                    ? root.path("effectiveConfigHash").asText() : null;
            // #383 B3 — 박힌 오버레이 중 이 재생에서 **적용하지 못해 버린** 경로. 정상 경로에서는
            // 키 자체가 없다. 러너가 400 대신 이걸 주는 이유는 노브 삭제(엔진 열차의 정상 활동)가
            // 진행 중 매치와 이후 모든 신규 매치를 죽이면 안 되기 때문이다.
            JsonNode dropped = root.has("droppedOverrides") ? root.get("droppedOverrides") : null;
            return new SimulateResult(matchLog, resume, root.path("lastHash").asText(), playbackMs,
                    configHash, dropped);
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("runner 호출 실패: " + e.getMessage(), e);
        }
    }

    // ── #383 계수 오버레이 운영 표면 ────────────────────────────────────
    //
    // 판정을 Java 가 흉내내지 않는 이유: **유효한 경로가 무엇인지는 엔진을 손에 든 쪽만 안다.**
    // 여기서 규칙을 복제하면 엔진이 바뀔 때 두 곳의 진실이 조용히 갈라지고, 그 갈라짐은 "설정했는데
    // 아무 일도 안 일어난다"(= 죽은 노브)로 나타난다 — #321·#337·#338 이 반복해 물린 형태다.

    /** 오버레이 가능한 리프 전수 + 현재 기본값. */
    public JsonNode configKnobs() {
        try {
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(runnerUrl + "/config/knobs"))
                    .timeout(timeout)
                    .GET()
                    .build();
            HttpResponse<String> response = sendBounded(request);
            if (response.statusCode() != 200) {
                throw new IllegalStateException("runner /config/knobs HTTP " + response.statusCode());
            }
            return objectMapper.readTree(response.body());
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            throw new IllegalStateException("runner /config/knobs 호출 실패: " + e.getMessage(), e);
        }
    }

    /**
     * 오버레이 드라이런 검증. 400 이면 <b>운영자에게 그대로 보여줄</b> 사유가 본문 {@code issues[]} 에
     * 있다 — 여기서 뭉개면 오타 하나마다 왕복이 한 번씩 는다.
     *
     * @throws ApiException 400(검증 실패) — 호출부가 원장에 쓰지 않고 그대로 올린다.
     */
    public JsonNode validateConfigOverrides(Object overrides) {
        try {
            String body = objectMapper.writeValueAsString(Map.of("overrides",
                    overrides == null ? Map.of() : overrides));
            HttpRequest request = HttpRequest.newBuilder()
                    .uri(URI.create(runnerUrl + "/config/validate"))
                    .timeout(timeout)
                    .header("Content-Type", "application/json")
                    .POST(HttpRequest.BodyPublishers.ofString(body))
                    .build();
            HttpResponse<String> response = sendBounded(request);
            JsonNode root = objectMapper.readTree(response.body());
            if (response.statusCode() == 400) {
                throw ApiException.validation(issuesOf(root));
            }
            if (response.statusCode() != 200) {
                throw new IllegalStateException("runner /config/validate HTTP " + response.statusCode()
                        + ": " + truncate(response.body()));
            }
            return root;
        } catch (RuntimeException e) {
            throw e;
        } catch (Exception e) {
            // 러너가 안 떠 있으면 **검증 없이 통과시키지 않는다** — 게이트가 열려 있는 편이 낫다는
            // 판단은 여기서 할 수 없다(그 값은 이후 모든 신규 매치에 실린다).
            throw new IllegalStateException("runner /config/validate 호출 실패: " + e.getMessage(), e);
        }
    }

    private static String issuesOf(JsonNode root) {
        StringBuilder sb = new StringBuilder(root.path("error").asText("계수 검증 실패"));
        JsonNode issues = root.path("issues");
        if (issues.isArray() && !issues.isEmpty()) {
            sb.setLength(0);
            for (JsonNode i : issues) {
                if (sb.length() > 0) {
                    sb.append("; ");
                }
                sb.append(i.asText());
            }
        }
        return sb.toString();
    }

    private static String truncate(String s) {
        return s == null ? "" : s.substring(0, Math.min(s.length(), 300));
    }
}
