package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.Resource;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import online.hmb.meta.AiModeService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * AI 모드 신고 → {@code GET /api/config} 노출 계약 (#471 AC3).
 *
 * <p>hero 요구: <i>"클로드 로그인 안되어있으면 게임시작할때 안내말만하고 스태틱 엔진으로 써있어야함."</i>
 * 로그인 여부를 아는 것은 실행기이고 안내를 그리는 것은 웹이라, 이 파일이 그 둘 사이의 계약을 지킨다.
 *
 * <p>이 테스트가 실제로 무는 성질 세 가지:
 * <ol>
 *   <li><b>모르는 것은 모른다고 한다</b> — 신고 전 {@code unknown}. {@code stub} 으로 답하면
 *       Java 부팅~실행기 신고 사이 창에서 로그인한 사용자에게 스텁 배너가 번쩍인다.</li>
 *   <li><b>죽은 실행기는 거짓말하지 않는다</b> — TTL 을 넘긴 신고는 다시 {@code unknown}.</li>
 *   <li><b>신고 문은 서번트 토큰 뒤에 있다</b> — 아무나 "live" 라고 우기면 안내가 무의미해진다.</li>
 * </ol>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AiModeConfigTest extends ApiTestBase {

    private static final String SERVANT_TOKEN = "change-me"; // application.yml hmb.servant.internal-token 기본값
    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    private static final Instant T0 = Instant.parse("2026-08-09T12:00:00Z");
    static final AtomicReference<Instant> NOW = new AtomicReference<>(T0);

    private static final HttpClient HTTP = HttpClient.newHttpClient();

    @TestConfiguration
    static class MutableClockConfig {
        @Bean
        @Primary
        Clock testClock() {
            return new Clock() {
                @Override
                public ZoneId getZone() {
                    return KST;
                }

                @Override
                public Clock withZone(ZoneId zone) {
                    return this;
                }

                @Override
                public Instant instant() {
                    return NOW.get();
                }
            };
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private ObjectMapper objectMapper;

    @Resource
    private AiModeService aiModeService;

    @BeforeEach
    void resetClock() {
        NOW.set(T0);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private Map<String, Object> configAi() {
        // /api/config 는 인증 예외 = 로그인 전 시작 화면에서도 읽힌다(그게 안내가 뜨는 자리다).
        HttpResult res = getRaw("/api/config");
        assertThat(res.status().value()).isEqualTo(200);
        Map<String, Object> body = asMap(res);
        return (Map<String, Object>) body.get("ai");
    }

    private HttpResult getRaw(String path) {
        return send(HttpRequest.newBuilder(URI.create(baseUrl(path))).GET().build());
    }

    private HttpResult report(String token, Map<String, Object> body) {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create(baseUrl("/internal/ai-mode")))
                .header("Content-Type", "application/json");
        if (token != null) {
            b.header("X-Servant-Token", token);
        }
        try {
            return send(b.POST(HttpRequest.BodyPublishers.ofString(objectMapper.writeValueAsString(body))).build());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private HttpResult send(HttpRequest req) {
        try {
            HttpResponse<String> res = HTTP.send(req, HttpResponse.BodyHandlers.ofString());
            return new HttpResult(org.springframework.http.HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private static Map<String, Object> body(String mode, String reason) {
        return Map.of("mode", mode, "reason", reason, "wanted", "claude-code", "effective",
                "live".equals(mode) ? "claude-code" : "stub", "workerId", "test-worker");
    }

    // ── 계약 ────────────────────────────────────────────────────────────

    /** 신고 전에는 unknown 이다 — stub 이 아니다(그 차이가 이 필드의 존재 이유다). */
    @Test
    void unreportedIsUnknownNotStub() {
        // 신고는 되돌릴 수 없고(그럴 API 가 없어야 정상이다) 컨텍스트는 클래스 공유라, "미신고" 성질만은
        // 서비스 단위로 검정한다 — 이 성질이 깨지는 자리는 HTTP 가 아니라 여기다.
        AiModeService fresh = new AiModeService(Clock.fixed(T0, KST));
        assertThat(fresh.current().mode()).isEqualTo("unknown");
        assertThat(fresh.current().mode()).isNotEqualTo("stub");
    }

    /** 강등 신고가 config 에 그대로 보인다 — 웹은 이 값 하나로 안내를 켠다. */
    @Test
    void stubReportSurfacesInConfig() {
        assertThat(report(SERVANT_TOKEN, body("stub", "logged-out")).status().value()).isEqualTo(200);
        Map<String, Object> ai = configAi();
        assertThat(ai).containsEntry("mode", "stub").containsEntry("reason", "logged-out");
        assertThat(ai).containsEntry("effective", "stub");
    }

    /** 로그인 상태면 live — 안내는 뜨지 않는다. */
    @Test
    void liveReportSurfacesInConfig() {
        assertThat(report(SERVANT_TOKEN, body("live", "logged-in")).status().value()).isEqualTo(200);
        assertThat(configAi()).containsEntry("mode", "live").containsEntry("reason", "logged-in");
    }

    /** TTL 을 넘긴 신고는 unknown 으로 돌아간다 — 죽은 실행기가 "live" 라고 계속 우기면 안 된다. */
    @Test
    void staleReportExpiresToUnknown() {
        report(SERVANT_TOKEN, body("live", "logged-in"));
        assertThat(configAi()).containsEntry("mode", "live");

        NOW.set(T0.plus(AiModeService.TTL).plusSeconds(1));
        Map<String, Object> ai = configAi();
        assertThat(ai).containsEntry("mode", "unknown").containsEntry("reason", "stale-report");
    }

    /** TTL 경계 안(하트비트가 살아 있는 상태)에서는 유지된다. */
    @Test
    void freshReportSurvivesWithinTtl() {
        report(SERVANT_TOKEN, body("live", "logged-in"));
        NOW.set(T0.plus(AiModeService.TTL).minusSeconds(1));
        assertThat(configAi()).containsEntry("mode", "live");
    }

    /** 토큰 없으면 401 — /internal/** 는 서번트 문 뒤다(별도 배선 없이 인터셉터가 건다). */
    @Test
    void reportRequiresServantToken() {
        assertThat(report(null, body("live", "logged-in")).status().value()).isEqualTo(401);
        assertThat(report("wrong-token", body("live", "logged-in")).status().value()).isEqualTo(401);
    }

    /** unknown 은 서버가 붙이는 상태이지 신고할 수 있는 값이 아니다(TTL 만료와 구분이 사라진다). */
    @Test
    void unknownIsNotReportable() {
        assertThat(report(SERVANT_TOKEN, body("unknown", "no-report")).status().value()).isEqualTo(400);
    }
}
