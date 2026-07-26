package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Instant;
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
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;

/**
 * AC1 통합: 실제 매치플로우(킥오프→가짜 서번트→시계만료 스윕→FINISHED)가 FINISHED CAS 통과 시
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

    @Resource
    private MatchClockSweeper clockSweeper;

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

        // 선발 P001 stat_levels_json 이 채워짐(V2: 스탯별 XP/레벨).
        String statLevels = jdbcClient.sql("SELECT stat_levels_json FROM user_players WHERE user_id=? AND player_id='P001'")
                .param(userId).query(String.class).single();
        assertThat(statLevels).isNotNull();

        // 리포트 노출(ResultPage S1).
        ResponseEntity<Map> report = authGet("/api/growth/report/" + matchId, token, Map.class);
        assertThat(report.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<?>) report.getBody().get("entries")).isNotEmpty();
    }

    /**
     * P4 매치클록(main 머지) 이후 플로우: 킥오프→시뮬 후 상태는 FIRST_HALF(서버 시계 게이트).
     * 시계 창(phase_ends_at)을 강제 만료시키고 스위퍼로 FIRST_HALF→HALFTIME→(승계)→SECOND_HALF→FINISHED
     * 를 밟는다 — MatchClockFlowTest 의 expire 패턴과 동일.
     */
    private String driveToFinished(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        for (int i = 0; i < 6 && !"FINISHED".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
            fakeServants.drain();
        }
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        return matchId;
    }
}
