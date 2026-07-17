package online.hmb;

import java.util.List;
import java.util.Map;
import org.springframework.boot.test.web.client.TestRestTemplate;
import org.springframework.boot.test.web.server.LocalServerPort;
import org.springframework.http.HttpEntity;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.http.ResponseEntity;

/**
 * HTTP 스택 통과 테스트 공통 헬퍼(로그인·Bearer 요청). 서브클래스가 각자
 * @SpringBootTest(RANDOM_PORT) + @DynamicPropertySource(TestDbSupport)를 선언한다.
 */
abstract class ApiTestBase {

    @LocalServerPort
    protected int port;

    protected final TestRestTemplate rest = new TestRestTemplate();

    protected String baseUrl(String path) {
        return "http://localhost:" + port + path;
    }

    /** 로그인 후 세션 토큰 반환(신규면 스타터 팩 지급됨). */
    @SuppressWarnings("unchecked")
    protected String login(String nickname) {
        ResponseEntity<Map> response = rest.postForEntity(
                baseUrl("/api/auth/login"), Map.of("nickname", nickname), Map.class);
        if (!response.getStatusCode().is2xxSuccessful() || response.getBody() == null) {
            throw new IllegalStateException("login failed: " + response.getStatusCode() + " " + response.getBody());
        }
        return (String) response.getBody().get("token");
    }

    protected HttpHeaders bearer(String token) {
        HttpHeaders headers = new HttpHeaders();
        headers.set("Authorization", "Bearer " + token);
        headers.setContentType(MediaType.APPLICATION_JSON);
        return headers;
    }

    protected <T> ResponseEntity<T> authGet(String path, String token, Class<T> type) {
        return rest.exchange(baseUrl(path), HttpMethod.GET, new HttpEntity<>(bearer(token)), type);
    }

    protected <T> ResponseEntity<T> authPut(String path, String token, Object body, Class<T> type) {
        return rest.exchange(baseUrl(path), HttpMethod.PUT, new HttpEntity<>(body, bearer(token)), type);
    }

    protected <T> ResponseEntity<T> authPost(String path, String token, Object body, Class<T> type) {
        return rest.exchange(baseUrl(path), HttpMethod.POST, new HttpEntity<>(body, bearer(token)), type);
    }

    protected <T> ResponseEntity<T> authDelete(String path, String token, Class<T> type) {
        return rest.exchange(baseUrl(path), HttpMethod.DELETE, new HttpEntity<>(bearer(token)), type);
    }

    /** 덱 PUT 바디 헬퍼. */
    protected static Map<String, Object> deckBody(String formation, List<Map<String, Object>> slots) {
        return Map.of("formation", formation, "slots", slots);
    }

    protected static Map<String, Object> slot(String playerId, String role, int slotIndex) {
        return Map.of("playerId", playerId, "role", role, "slotIndex", slotIndex);
    }

    protected static Map<String, Object> slot(String playerId, String role, int slotIndex, String promptText) {
        return Map.of("playerId", playerId, "role", role, "slotIndex", slotIndex, "promptText", promptText);
    }
}
