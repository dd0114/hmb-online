package online.hmb;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.concurrent.CopyOnWriteArrayList;

/**
 * 가짜 엔진러너 (LLD §8: WireMock-or-fake — JDK 내장 httpserver 사용, main 의존성 0).
 * docs/plan-v2/fixtures/matchlog-h{1,2}.json 의 {request, response} 쌍에서 response를 재생한다.
 *
 * 응답 규칙:
 * - half=1 → h1 fixture response (matchLog + resumeState + lastHash)
 * - half=2 + resumeState 있음(교체 없음 경로) → h2 fixture response 그대로
 * - half=2 + resumeState 없음(교체 경로, LLD §5.4 독립 시뮬) → h2 response의 tick 전부
 *   +100000 시프트 + lastHash 접미사 "-nosub" (요청 경로 구분을 테스트에서 검증 가능하게)
 * 수신 요청은 requests에 기록된다.
 */
public class FakeEngineRunner {

    private static final String FIXTURE_DIR = "../docs/plan-v2/fixtures";
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private final HttpServer server;
    private final JsonNode h1Response;
    private final JsonNode h2Response;
    public final List<JsonNode> requests = new CopyOnWriteArrayList<>();

    public FakeEngineRunner() {
        try {
            h1Response = MAPPER.readTree(new File(FIXTURE_DIR, "matchlog-h1.json")).path("response");
            h2Response = MAPPER.readTree(new File(FIXTURE_DIR, "matchlog-h2.json")).path("response");
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/simulate", exchange -> {
                byte[] requestBytes = exchange.getRequestBody().readAllBytes();
                JsonNode request = MAPPER.readTree(requestBytes);
                requests.add(request);

                JsonNode response = respond(request);
                byte[] bytes = MAPPER.writeValueAsBytes(response);
                exchange.getResponseHeaders().set("Content-Type", "application/json");
                exchange.sendResponseHeaders(200, bytes.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(bytes);
                }
            });
            server.start();
        } catch (IOException e) {
            throw new IllegalStateException("FakeEngineRunner 기동 실패", e);
        }
    }

    private JsonNode respond(JsonNode request) {
        int half = request.path("half").asInt();
        JsonNode base;
        if (half == 1) {
            base = h1Response;
        } else if (request.has("resumeState")) {
            base = h2Response;
        } else {
            base = tickShifted(h2Response);
        }
        return withConfigHash(base, request);
    }

    /**
     * #383: 실제 러너는 응답에 <b>유효 config 지문</b>을 싣는다. 이 가짜가 그걸 안 주면
     * {@code EngineRunnerClient} 의 파싱과 {@code match_halves.effective_config_hash} 저장 경로가
     * <b>한 번도 실행되지 않고</b>, 그 컬럼을 null 로 만드는 변이체가 전 테스트를 통과한다
     * (독립검증 M1 — #385 와 같은 형태: 로컬 게이트 전부 green, 실환경에서만 빈다).
     *
     * <p>지문은 오버레이에서 파생시킨다 — 실제 러너처럼 <b>같은 config 면 같은 값</b>이어야
     * "두 하프가 같은 config 로 돌았다"를 테스트가 확인할 수 있다.
     */
    private JsonNode withConfigHash(JsonNode base, JsonNode request) {
        ObjectNode copy = base.deepCopy();
        String overrides = request.has("configOverrides") ? request.get("configOverrides").toString() : "{}";
        copy.put("effectiveConfigHash", String.format("%08x", overrides.hashCode()));
        return copy;
    }

    /** 교체 경로(h2, resumeState 없음) 구분용 변형: tick +100000, lastHash 접미사. */
    private JsonNode tickShifted(JsonNode original) {
        ObjectNode copy = original.deepCopy();
        ObjectNode matchLog = (ObjectNode) copy.path("matchLog");
        for (JsonNode tick : (ArrayNode) matchLog.path("tickSnapshots")) {
            ((ObjectNode) tick).put("tick", tick.path("tick").asInt() + 100000);
        }
        for (JsonNode event : (ArrayNode) matchLog.path("events")) {
            ((ObjectNode) event).put("tick", event.path("tick").asInt() + 100000);
        }
        copy.put("lastHash", original.path("lastHash").asText() + "-nosub");
        return copy;
    }

    public String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort();
    }

    public void stop() {
        server.stop(0);
    }

    public JsonNode lastRequestForHalf(int half) {
        for (int i = requests.size() - 1; i >= 0; i--) {
            if (requests.get(i).path("half").asInt() == half) {
                return requests.get(i);
            }
        }
        return null;
    }

    public static String bodyOf(byte[] bytes) {
        return new String(bytes, StandardCharsets.UTF_8);
    }
}
