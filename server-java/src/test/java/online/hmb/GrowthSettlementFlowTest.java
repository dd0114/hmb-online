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
 * AC1 통합: 실제 매치플로우(킥오프→가짜 서번트→H1_BREAK→재개→FINISHED)가 FINISHED CAS 통과 시
 * 성장 정산을 1회 트리거하는지 — growth_applied 행 + match_xp 증가 + report 노출 확인.
 * finishMatch 훅(MatchOrchestrator.settleGrowth)의 end-to-end 배선 검증.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class GrowthSettlementFlowTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @SuppressWarnings("unchecked")
    @Test
    void finishedMatchSettlesGrowthOnce() {
        String token = setupUserWithDeck("gs_flow");
        String userId = userIdOf("gs_flow");
        String matchId = driveToFinished(token);

        // 기용 로스터(선발 11 + 벤치 2) 전원 growth_applied 적립.
        long applied = jdbcClient.sql("SELECT COUNT(*) FROM growth_applied WHERE match_id=? AND user_id=?")
                .params(matchId, userId).query(Long.class).single();
        assertThat(applied).isEqualTo(13);

        // 선발 P001 match_xp 증가.
        int xp = jdbcClient.sql("SELECT match_xp FROM user_players WHERE user_id=? AND player_id='P001'")
                .param(userId).query(Integer.class).single();
        assertThat(xp).isGreaterThan(0);

        // 리포트 노출(ResultPage S1).
        ResponseEntity<Map> report = authGet("/api/growth/report/" + matchId, token, Map.class);
        assertThat(report.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) report.getBody().get("entries")).isNotEmpty();
    }

    private String driveToFinished(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("H1_BREAK");
        authPost("/api/matches/" + matchId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        return matchId;
    }
}
