package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.LinkedHashMap;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 계약 B(#98 요구 2 "경기 후 과거 세팅 로그 → 프리셋"): {@code GET /api/matches/{id}} 응답에
 * 이미 저장된 {@code matches.user_deck_json} 을 openapi-v2 {@code TeamSnapshot} 형상의
 * {@code userDeckSnapshot} 으로 노출한다(순수 additive — 새 테이블·새 저장 로직 없음).
 *
 * <p>검증: ①형상·내용이 저장값과 일치(formation/starters×11/bench/promptText/teamTactics)
 * ②남의 매치는 404(getOwned 경로 그대로) ③user_deck_json 없음/손상이면 필드 null + 200(500 금지)
 * ④기존 MatchDetail 필드 회귀 0.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MatchDeckSnapshotApiTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    private final ObjectMapper mapper = new ObjectMapper();

    private JsonNode detail(String token, String matchId) {
        ResponseEntity<String> response = authGet("/api/matches/" + matchId, token, String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        try {
            return mapper.readTree(response.getBody());
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    @Test
    void 매치_상세에_저장된_덱_스냅샷이_TeamSnapshot_형상으로_노출된다() {
        String token = setupUserWithDeck("snap-own");
        Map<String, Object> tactics = new LinkedHashMap<>();
        tactics.put("line", 0.8);
        tactics.put("press", 0.3);
        tactics.put("tempo", 0.7);
        tactics.put("width", 0.2);
        ResponseEntity<Map> created = authPost("/api/matches", token,
                Map.of("teamTactics", tactics), Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) created.getBody().get("id");

        JsonNode snapshot = detail(token, matchId).get("userDeckSnapshot");
        assertThat(snapshot).isNotNull();
        assertThat(snapshot.isObject()).isTrue();

        // 형상: TeamSnapshot = {formation, starters[11], bench[], teamTactics?}
        assertThat(snapshot.path("formation").asText()).isEqualTo("4-4-2");
        assertThat(snapshot.path("starters").size()).isEqualTo(11);
        assertThat(snapshot.path("bench").size()).isEqualTo(2);

        // 내용: 저장값(user_deck_json)과 정확히 일치
        String stored = jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        JsonNode storedNode;
        try {
            storedNode = mapper.readTree(stored);
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
        assertThat(snapshot.path("starters")).isEqualTo(storedNode.path("starters"));
        assertThat(snapshot.path("bench")).isEqualTo(storedNode.path("bench"));

        // 선발 슬롯 필드 = SnapshotSlot {playerId, slotIndex, promptText?}
        JsonNode gk = snapshot.path("starters").get(0);
        assertThat(gk.path("playerId").asText()).isEqualTo("P001");
        assertThat(gk.path("slotIndex").asInt()).isEqualTo(0);

        // 벤치 프롬프트가 스냅샷을 통해 그대로 전달된다(프리셋 복원 시 프롬프트 유실 방지).
        JsonNode benchWithPrompt = snapshot.path("bench").get(1);
        assertThat(benchWithPrompt.path("playerId").asText()).isEqualTo("P013");
        assertThat(benchWithPrompt.path("promptText").asText()).isEqualTo("벤치 프롬프트");

        // teamTactics 도 그대로(프리셋 저장 시 전술까지 복원돼야 한다)
        assertThat(snapshot.path("teamTactics").path("line").asDouble()).isEqualTo(0.8);
        assertThat(snapshot.path("teamTactics").path("press").asDouble()).isEqualTo(0.3);
        assertThat(snapshot.path("teamTactics").path("tempo").asDouble()).isEqualTo(0.7);
        assertThat(snapshot.path("teamTactics").path("width").asDouble()).isEqualTo(0.2);
    }

    @Test
    void 기존_MatchDetail_필드는_회귀없이_그대로다() {
        String token = setupUserWithDeck("snap-reg");
        String matchId = createMatch(token, null);

        JsonNode detail = detail(token, matchId);
        assertThat(detail.path("id").asText()).isEqualTo(matchId);
        assertThat(detail.path("state").asText()).isEqualTo("BRIEFING");
        assertThat(detail.has("failReason")).isTrue();
        assertThat(detail.path("opponent").path("name").isTextual()).isTrue();
        assertThat(detail.path("opponent").path("deck").size()).isEqualTo(11);
        assertThat(detail.has("scoreHome")).isTrue();
        assertThat(detail.has("scoreAway")).isTrue();
        assertThat(detail.has("result")).isTrue();
        assertThat(detail.path("createdAt").isTextual()).isTrue();
        assertThat(detail.path("mode").asText()).isEqualTo("practice");
        assertThat(detail.path("conditions").size()).isEqualTo(13); // 선발 11 + 벤치 2
        assertThat(detail.has("leagueFixtureId")).isTrue();
    }

    @Test
    void 남의_매치_스냅샷은_노출되지_않는다() {
        String owner = setupUserWithDeck("snap-own2");
        String matchId = createMatch(owner, null);
        String other = setupUserWithDeck("snap-intr");

        ResponseEntity<String> response = authGet("/api/matches/" + matchId, other, String.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(response.getBody()).doesNotContain("userDeckSnapshot");
    }

    @Test
    void user_deck_json_이_비어있으면_필드는_null_이고_200() {
        // 컬럼은 NOT NULL 이라 실제 결측은 빈 문자열/공백 형태로만 존재할 수 있다(방어 경로).
        String token = setupUserWithDeck("snap-null");
        String matchId = createMatch(token, null);
        jdbcClient.sql("UPDATE matches SET user_deck_json = '' WHERE id = ?").param(matchId).update();

        JsonNode detail = detail(token, matchId);
        assertThat(detail.path("userDeckSnapshot").isNull()).isTrue();
        assertThat(detail.path("id").asText()).isEqualTo(matchId); // 나머지 응답은 정상
    }

    @Test
    void user_deck_json_이_손상돼도_500이_아니라_null_이다() {
        String token = setupUserWithDeck("snap-bad");
        String matchId = createMatch(token, null);
        jdbcClient.sql("UPDATE matches SET user_deck_json = ? WHERE id = ?")
                .params("{not json", matchId).update();

        JsonNode detail = detail(token, matchId);
        assertThat(detail.path("userDeckSnapshot").isNull()).isTrue();

        // 스키마가 어긋난 값(배열/필드 누락)도 동일하게 null — TeamSnapshot 형상이 아니면 노출 안 함.
        jdbcClient.sql("UPDATE matches SET user_deck_json = ? WHERE id = ?")
                .params("{\"formation\":\"4-4-2\"}", matchId).update();
        assertThat(detail(token, matchId).path("userDeckSnapshot").isNull()).isTrue();
    }
}
