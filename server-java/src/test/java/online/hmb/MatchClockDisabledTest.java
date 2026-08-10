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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 롤백 스위치 검증 (LLD-e2-flow-clock §7.7, T-W3-5): {@code hmb.match.clock.enabled=false} 면
 * 시계 이전 동작 그대로다 — 전반 시뮬 직후 감독시간 대기(무기한), 후반 시뮬 직후 즉시 종료·정산.
 * 상태 이름만 HALFTIME(구 H1_BREAK)이고 {@code clock} 은 null 이라 웹은 카운트다운/상한 없이 돈다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchClockDisabledTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        // 배경 @Scheduled 스위퍼를 사실상 끈다 — 이 테스트는 sweep() 을 직접 호출해
        // 단계 전환 시점을 스스로 통제한다(스케줄러가 끼면 상태가 앞서가 판정이 흔들린다).
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "false");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Test
    void disabledClockKeepsTheLegacyImmediateFlow() {
        String token = setupUserWithDeck("clk_off");
        String matchId = createMatch(token, "BOT_BAL");

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();

        // 전반 시뮬 = 곧바로 감독시간(대기). 시계가 없으니 만료도, 자동 후반도 없다.
        Map<?, ?> afterH1 = authGet("/api/matches/" + matchId, token, Map.class).getBody();
        assertThat(afterH1.get("state")).isEqualTo("HALFTIME");
        assertThat(afterH1.get("clock")).isNull();
        assertThat(afterH1.get("scoreH1Home")).isEqualTo(1); // 전반이 끝난 상태라 스코어 공개

        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();

        // 후반 시뮬 = 곧바로 종료·정산(구 동작).
        Map<?, ?> finished = authGet("/api/matches/" + matchId, token, Map.class).getBody();
        assertThat(finished.get("state")).isEqualTo("FINISHED");
        assertThat(finished.get("clock")).isNull();
        assertThat(finished.get("result")).isEqualTo("WIN");
        assertThat(authGet("/api/matches/" + matchId + "/result", token, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // 시계 on/off 로 시뮬 번들이 달라지지 않는다 — 재현 지문이 같은 값이어야 한다
        // (MatchClockFlowTest.clockDoesNotChangeTheSimulationBundle 과 같은 상수, 루트 §2-5).
        String lastHash = jdbcClient.sql("SELECT last_hash FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single();
        assertThat(lastHash).isEqualTo(MatchClockFlowTest.FIXTURE_H1_LAST_HASH);
    }

    /**
     * <b>#492</b> — 롤백 경로에서도 {@code match_finish} 가 남는다.
     *
     * <p>이 경로는 후반 진입이 곧 종료라 정산이 {@code simulateAndStore} 의 트랜잭션 <b>안</b>에서
     * 끝난다. 예전엔 그 자리에 커밋 후 훅이 없어 시계를 끄면 <b>이 이벤트만 조용히 사라졌고</b>,
     * 퍼널은 {@code match_start} 까지만 찍힌 유저를 "경기를 끝내지 못한 사람"으로 그렸다.
     * 시계가 켜진 경로({@code settleFinishedIfDue})와 <b>같은 props</b> 여야 하므로 값까지 본다 —
     * 종류만 맞고 내용이 다르면 {@code mode} 필터·퍼널이 롤백 환경에서만 다르게 동작한다.
     */
    @Test
    void matchFinishIsRecordedEvenWhenTheClockIsDisabled() {
        String token = setupUserWithDeck("clk_off_ev");
        String matchId = createMatch(token, "BOT_BAL");

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();

        assertThat(authGet("/api/matches/" + matchId, token, Map.class).getBody().get("state"))
                .isEqualTo("FINISHED");

        // 정확히 1건 — 재정산·중복 훅이 있으면 여기서 깨진다.
        Integer finishes = jdbcClient.sql("""
                        SELECT COUNT(*) FROM business_events
                        WHERE event = 'match_finish' AND json_extract(props_json, '$.matchId') = ?
                        """)
                .param(matchId).query(Integer.class).single();
        assertThat(finishes).isEqualTo(1);

        Map<String, Object> props = jdbcClient.sql("""
                        SELECT json_extract(props_json, '$.mode')   AS mode,
                               json_extract(props_json, '$.result') AS result
                        FROM business_events
                        WHERE event = 'match_finish' AND json_extract(props_json, '$.matchId') = ?
                        """)
                .param(matchId).query((rs, n) -> Map.<String, Object>of(
                        "mode", rs.getString("mode"), "result", rs.getString("result")))
                .single();
        assertThat(props).containsEntry("mode", "practice").containsEntry("result", "WIN");
    }
}
