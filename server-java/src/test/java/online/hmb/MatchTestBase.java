package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.BeforeEach;
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

    /**
     * ai_jobs 는 클래스 단위로 DB 를 공유하므로(테스트 메서드 간) 각 메서드 시작 시 큐를 비운다.
     * #1 봇 프리페치 이후 createMatch 가 봇 잡을 enqueue 하므로, 드레인/카운트 검증이 다른 메서드가
     * 남긴 잡에 오염되지 않도록 클린 슬레이트로 시작한다. (InternalJobApiTest 의 clearJobQueue 와 동일 취지)
     */
    @BeforeEach
    void clearAiJobsBeforeEach() {
        jdbcClient.sql("DELETE FROM ai_jobs").update();
        releaseActiveMatches();
    }

    /**
     * 테스트 픽스처 위생 (#217): 잠금 도입 이후 <b>유저당 끝나지 않은 매치는 하나</b>다. 클래스 단위로
     * DB 를 공유하므로 앞 테스트가 남긴 매치가 다음 테스트의 {@code createMatch} 를 409 로 막는다.
     * 각 테스트를 "미완 매치 0" 상태에서 시작시킨다.
     *
     * <p>이걸 {@code createMatch} 안으로 숨기지 않는 이유: 그러면 잠금 자체가 테스트에서 영원히
     * 관측되지 않는다. 한 메서드 안에서 매치가 둘 이상 필요한 테스트는 <b>명시적으로</b> 이걸 부른다.
     */
    protected void releaseActiveMatches() {
        jdbcClient.sql("UPDATE matches SET state = 'ABANDONED' "
                        + "WHERE state NOT IN ('FINISHED', 'ABANDONED')")
                .update();
    }

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

    /**
     * <b>원정 상대로 설 수 있는</b> 유저 — 덱 + 완료 경기 1판 (#296).
     *
     * <p>자격 필터가 들어온 뒤로 "덱만 있는 유저"는 상대 풀에 들어오지 않는다(덱은 온보딩이 자동
     * 지급하므로 활동 증거가 아니다). 원정 픽스처가 {@code setupUserWithDeck} 만 쓰면 후보가 0이 되어
     * 테스트가 {@code NO_OPPONENT} 으로 무너진다 — 상대를 세우는 자리엔 이걸 쓴다.
     *
     * <p>공격자에겐 쓰지 마라: 공격자는 자격을 요구받지 않는다(hero D3). 공격자에까지 붙이면 그
     * 사실이 테스트에서 관측되지 않는다.
     */
    protected String setupOpponentWithDeck(String nickname) {
        String token = setupUserWithDeck(nickname);
        markPlayedOnce(userIdOf(nickname));
        return token;
    }

    /** 완료 경기 1판을 심어 자격을 준다(#296). 과거 시각·practice 라 일일 한도·잠금과 무관하다. */
    protected void markPlayedOnce(String userId) {
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', '0.9.0', '{}', 'practice', 'WIN', ?)
                        """)
                .params(online.hmb.common.Ulid.next(), userId, "2026-05-01T00:00:00Z")
                .update();
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
