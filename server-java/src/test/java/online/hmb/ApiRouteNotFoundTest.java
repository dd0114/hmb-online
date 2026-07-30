package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>없는 경로는 404 다</b>(#335).
 *
 * <p>매핑되지 않은 요청은 Spring 이 정적 리소스 조회로 흘리고, 거기서 난
 * {@code NoResourceFoundException} 이 포괄 핸들러에 걸려 <b>500</b> 이 됐다 — 오탈자 URL 하나가
 * "서버가 아프다"로 보고됐다는 뜻이다(실측: {@code GET /api/mails/{id}} →
 * {@code 500 "No static resource api/mails/01KY…"}).
 *
 * <p>이 서버는 <b>"없는 것"과 "못 보는 것"을 구분 불가능하게</b> 만드는 데 공을 들여 왔다
 * (예약 공지 404 #297 · 남의 우편 404 #323). 그런데 정작 <b>오타는 500</b> 이라 다르게 보였다.
 *
 * <p>⚠️ 계약을 <b>상태코드만</b>으로 걸지 않는다 — 예외 메시지를 그대로 흘리면 내부 구현(정적
 * 리소스 폴백)과 요청 경로가 노출된다. "500 이 아니다"와 "내부를 흘리지 않는다"를 함께 건다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class ApiRouteNotFoundTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Test
    void unmappedApiPathsAre404NotServerError() {
        String token = login("route404");

        for (String path : new String[]{
                "/api/mails/01KYT981G1K57GKWH50TPJ0EVX",   // 실재하지 않는 **동사**(목록·read·claim 만 있다)
                "/api/nope",
                "/api/me/definitely-not-here",
        }) {
            HttpResult res = get(path, token);
            assertThat(res.status()).as(path + " → " + res.body()).isEqualTo(HttpStatus.NOT_FOUND);

            Map<String, Object> body = asMap(res);
            assertThat(body.get("code")).as(path).isEqualTo("NOT_FOUND");
            // 내부 구현·요청 경로를 되비추지 않는다.
            //
            // ⚠️ **경로는 선행 슬래시를 뗀 모양으로 새어 나온다** — 실제 누출 문자열이
            // `"No static resource api/nope."` 라 `doesNotContain("/api/nope")` 는 **아무것도 잡지
            // 못했다**(독립검증 minor-1 이 변이체로 실증: 문구만 바꾸고 경로는 그대로 노출하는
            // 구현이 이 단언을 통과했다). 프레임워크 문구가 바뀌어도 남는 축은 **경로 반사**다.
            assertThat(String.valueOf(body.get("message")))
                    .as("예외 메시지를 그대로 흘리면 안 된다: " + res.body())
                    .doesNotContain("static resource")
                    .doesNotContain(path)
                    .doesNotContain(path.substring(1));
        }
    }

    /** 인증 없이 접근한 미지 경로도 마찬가지 — 401 게이트가 먼저 걸리는 것은 그대로 둔다. */
    @Test
    void unmappedPathBehindAuthStillGuardsFirst() {
        HttpResult res = get("/api/nope", null);
        assertThat(res.status())
                .as("인증 게이트가 먼저다 — 미지 경로라고 인증을 건너뛰지 않는다")
                .isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** 도메인 404(실재하는 라우트 + 없는 대상)는 그대로여야 한다 — 이 매핑이 삼키지 않았는지. */
    @Test
    void domainNotFoundIsUnchanged() {
        String token = login("route404b");
        HttpResult res = get("/api/notices/does-not-exist", token);
        assertThat(res.status()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(asMap(res).get("code")).isEqualTo("NOT_FOUND");
    }

    private HttpResult get(String path, String token) {
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .GET();
            if (token != null) {
                builder.header("Authorization", "Bearer " + token);
            }
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient()
                    .send(builder.build(), java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
