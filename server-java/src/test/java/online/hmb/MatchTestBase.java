package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;

/**
 * 매치플로우 테스트 공통 — 유저+유효덱 셋업, 매치 생성 헬퍼.
 * 유저 덱: 선발 P001(GK)+P002..P011, 벤치 P012,P013(FW).
 */
abstract class MatchTestBase extends ApiTestBase {

    @Resource
    protected JdbcClient jdbcClient;

    protected String setupUserWithDeck(String nickname) {
        String token = login(nickname);
        List<Map<String, Object>> slots = new ArrayList<>();
        slots.add(slot("P001", "starter", 0));
        for (int i = 2; i <= 11; i++) {
            slots.add(slot(String.format("P%03d", i), "starter", i - 1));
        }
        slots.add(slot("P012", "bench", 0));
        slots.add(slot("P013", "bench", 1, "벤치 프롬프트"));
        ResponseEntity<Map> put = authPut("/api/deck", token, deckBody("4-4-2", slots), Map.class);
        assertThat(put.getStatusCode()).isEqualTo(HttpStatus.OK);
        return token;
    }

    protected String createMatch(String token, String botId) {
        Map<String, Object> body = botId == null ? Map.of() : Map.of("botId", botId);
        ResponseEntity<Map> response = authPost("/api/matches", token, body, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(response.getBody().get("state")).isEqualTo("BRIEFING");
        return (String) response.getBody().get("id");
    }

    protected String matchState(String matchId) {
        return jdbcClient.sql("SELECT state FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    protected void forceState(String matchId, String state) {
        jdbcClient.sql("UPDATE matches SET state = ? WHERE id = ?")
                .params(state, matchId).update();
    }

    protected String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }
}
