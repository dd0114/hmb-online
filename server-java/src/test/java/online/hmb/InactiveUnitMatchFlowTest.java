package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#207 핵심 계약</b>: <b>비활성 유닛이 덱에 편성돼 있어도 경기가 끝까지 정상 동작한다.</b>
 *
 * <p>hero 결정 U-D1(조합안)의 실질이 이것이다 — 비활성화는 <b>신규 획득만</b> 막는 조치지
 * "그 카드를 못 쓰게 하는" 조치가 아니다. 구 LEGEND 14종을 끄는 순간 <b>이미 그들을 주전으로
 * 편성해 둔 테스터들</b>이 존재하는데, 어디선가 {@code active} 필터가 한 겹 더 걸리면 그 유저들은
 * 덱 저장이 막히거나 킥오프에서 터진다. 상태코드 하나가 아니라 <b>덱 저장 → 매치 생성 → 킥오프 →
 * SelectData → 하프타임 → 재개 → FINISHED + 보상</b> 전 구간을 실제로 통과시켜 확인한다.
 *
 * <p>끄는 대상은 <b>선발 1명 + 벤치 1명</b>이다 — 선발만 끄면 교체 경로(벤치 검증)를 못 밟는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class InactiveUnitMatchFlowTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 이 테스트의 주제는 시계가 아니다 — 즉시 전개 흐름으로 고정(MatchFlowE2ETest 와 동일).
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Test
    void matchRunsToCompletionWithDeactivatedUnitsInTheSquad() {
        // 선발 P005(DF) + 벤치 P012(FW) 를 비활성화 — 보유분은 그대로 남는다.
        jdbcClient.sql("UPDATE players SET active = 0 WHERE id IN ('P005', 'P012')").update();

        // ① 덱 편성 — 비활성 유닛이 포함돼 있어도 저장된다(뺏지 않는다).
        String token = setupUserWithDeck("inactive_squad");
        assertThat(jdbcClient.sql("""
                        SELECT COUNT(*) FROM deck_slots s JOIN decks d ON d.id = s.deck_id
                        WHERE d.user_id = ? AND s.player_id IN ('P005', 'P012')
                        """).param(userIdOf("inactive_squad")).query(Long.class).single())
                .as("비활성 유닛이 덱 저장에서 탈락했다").isEqualTo(2L);

        // ② 매치 생성 → 프롬프트 → 킥오프
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "team", "text", "평소대로"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        // 비활성 유닛에 개별 프롬프트도 걸린다(선수별 프롬프트가 활성 여부로 갈리면 안 된다).
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "pre", "scope", "player", "playerId", "P005", "text", "라인 유지"), Map.class)
                .getStatusCode()).as("비활성 유닛에 프롬프트를 못 걸었다").isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> kickoff = authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        assertThat(kickoff.getStatusCode()).as("비활성 유닛 때문에 킥오프가 막혔다: " + kickoff.getBody())
                .isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        // ③ SelectData 에 비활성 유닛이 그대로 실린다(엔진이 그를 뛰게 한다).
        String selectData = jdbcClient.sql(
                        "SELECT select_data_json FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single();
        assertThat(selectData).as("SelectData 에서 비활성 유닛이 빠졌다 — 10명으로 뛰게 된다").contains("P005");

        ResponseEntity<Map> afterH1 = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(afterH1.getBody().get("state")).isEqualTo("HALFTIME");

        // ④ 하프타임 교체 — 비활성 유닛을 빼고 비활성 유닛을 넣는다(양방향). 보유분은 정상 자원이다.
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of(Map.of("out", "P005", "in", "P012"))), Map.class)
                .getStatusCode()).as("비활성 유닛이 낀 교체가 막혔다").isEqualTo(HttpStatus.OK);

        // ⑤ 재개 → FINISHED + 보상까지
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        ResponseEntity<Map> finished = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(finished.getBody().get("state")).as("비활성 유닛이 낀 경기가 끝나지 못했다")
                .isEqualTo("FINISHED");

        ResponseEntity<Map> result = authGet("/api/matches/" + matchId + "/result", token, Map.class);
        assertThat(result.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(result.getBody().get("result")).isNotNull();
    }
}
