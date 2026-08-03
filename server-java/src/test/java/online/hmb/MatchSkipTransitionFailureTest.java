package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.doThrow;

import jakarta.annotation.Resource;
import java.time.Instant;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * D8 — <b>창 단축과 전이가 갈라지면 지고 있는 경기에 포기(리롤) 버튼이 열린다</b> (#421 W1).
 *
 * <p>{@code MatchLockService.abandonable} 은 <b>{@code phase_ends_at + stuck-grace-ms}</b> 로 열린다
 * (시계가 멈춘 라이브 = 회수 대상). 스킵이 창만 지금으로 당겨 놓고 전이에 실패하면, 그 유예가
 * 통째로 앞당겨져 <b>정상 재생 중인 경기가 곧 "포기 가능"이 된다</b> — #217 이 막으려던 리롤 경로가
 * 스킵 버튼 하나로 다시 열리는 것이다(리그면 픽스처 리롤).
 *
 * <p>그래서 스킵은 <b>당김과 전이를 같은 요청 안에서</b> 처리하고, 전이가 예외로 죽으면 당긴 창을
 * <b>되돌린다</b>(아무도 그 사이 창을 건드리지 않았을 때만 — CAS). 이 클래스가 그 보상을 박는다.
 *
 * <p>전이 실패를 재현하는 방법: 정산 경로({@code settleFinishedIfDue})를 던지게 만든다. 실 코드의
 * 시뮬 실패는 {@code maybeSimulate} 가 삼켜 FAILED 로 떨어뜨리므로(예외가 안 올라온다) 예외 경로를
 * 정직하게 태우려면 스파이가 유일한 손잡이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchSkipTransitionFailureTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    /** 실제 빈을 감싼 스파이 — 정산만 실패시켜 "전이가 죽은" 요청을 만든다. */
    @SpyBean
    private online.hmb.match.MatchOrchestrator orchestrator;

    @Test
    void aFailedTransitionDoesNotLeaveTheWindowShortened() {
        String token = setupUserWithDeck("skip_fail");
        String matchId = reachSecondHalf(token);
        String windowBefore = clockColumn(matchId, "phase_ends_at");

        doThrow(new IllegalStateException("정산 실패(테스트)"))
                .when(orchestrator).settleFinishedIfDue(any(), any());

        ResponseEntity<Map> response = authPost("/api/matches/" + matchId + "/skip", token,
                Map.of("phase", "SECOND_HALF"), Map.class);

        assertThat(response.getStatusCode().is5xxServerError()).isTrue(); // 실패는 실패로 보고한다
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        // 핵심: 창이 되돌아왔다 = 포기(리롤) 유예도 앞당겨지지 않았다.
        assertThat(clockColumn(matchId, "phase_ends_at")).isEqualTo(windowBefore);
        assertThat(rewardLedgerRows(matchId)).isZero();
    }

    private String reachSecondHalf(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        for (int i = 0; i < 4 && !"SECOND_HALF".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(Instant.now().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
        }
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        return matchId;
    }

    private String clockColumn(String matchId, String column) {
        return jdbcClient.sql("SELECT " + column + " FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    private long rewardLedgerRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'")
                .param(matchId).query(Long.class).single();
    }
}
