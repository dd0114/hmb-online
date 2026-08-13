package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doThrow;

import jakarta.annotation.Resource;
import java.time.Instant;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#492</b> — 정산이 예외로 롤백되면 {@code match_finish} 는 <b>남지 않는다</b>.
 *
 * <h2>왜 이 계약이 필요한가</h2>
 * AC7 패널 4R 의 엣지케이스 렌즈가 이 경로를 지목했다: {@code finishMatch} 안의 정산
 * ({@code awayService.settle}·{@code missionService.settle}·{@code settleGrowth}·
 * {@code relationService.applyMatchResult})이 던지면 트랜잭션이 롤백되고, 훅은 커밋 <b>뒤</b>에
 * 있으므로 이벤트가 안 나간다. <b>렌즈가 이걸 "유실"이라 불렀지만 그 반대다</b> — 롤백된 경기는
 * 끝나지 않았고(FINISHED 아님·보상 0), 거기서 이벤트를 남기면 <b>끝나지 않은 경기의 종료 이벤트</b>가
 * 생겨 퍼널이 거짓이 된다. 즉 <b>없는 것이 옳은 동작</b>이다.
 *
 * <p>렌즈가 옳게 짚은 것은 하나: <b>그 성질을 박은 계약이 0건이었다</b>. 유실이 아니라 미검증이었고,
 * 이 클래스가 그 자리를 메운다. 훅을 {@code txRunner.run(...)} 람다 <b>안</b>으로 옮기면 (= 기록이
 * 정산을 되돌리는 #492 무영향 원칙 위반) 아래 ①이 "이벤트 1건"으로 깨진다.
 *
 * <h2>공허해지지 않게</h2>
 * "0건"은 <b>부재 주장</b>이라 그것만 보면 훅을 통째로 지운 변이체도 통과한다. 그래서 ②가 같은
 * 경로·같은 진입점을 예외 없이 태워 <b>1건</b>을 확인한다. 두 단정이 같이 있어야 ①의 0 이
 * "롤백돼서 없다"를 뜻한다.
 *
 * <p>예외 손잡이는 {@link online.hmb.match.RelationService} 스파이다 — 모드와 무관하게 모든 정산이
 * 지나는 지점이라(리그·원정 분기 밖) 연습 매치 하나로 그 경계를 정직하게 태울 수 있다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class BusinessEventSettlementRollbackTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        // 배경 스위퍼가 강제로 만든 SECOND_HALF 를 앞질러 정산하면 판정이 흔들린다.
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "3600000");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private online.hmb.match.MatchOrchestrator orchestrator;

    /** 실제 빈을 감싼 스파이 — 정산 한 지점만 던지게 해 "롤백된 종료"를 만든다. */
    @SpyBean
    private online.hmb.match.RelationService relationService;

    // ── ① 롤백 = 이벤트 없음 (+ 경기도 안 끝났다) ──────────────────────────

    @Test
    void aRolledBackSettlementLeavesNoFinishEvent() {
        String token = setupUserWithDeck("evt_rb_fail");
        String matchId = createMatch(token, "BOT_BAL");
        forceSecondHalf(matchId);

        doThrow(new IllegalStateException("정산 실패(테스트)"))
                .when(relationService).applyMatchResult(anyString(), anyString(), anyString());

        assertThatThrownBy(() -> orchestrator.settleFinishedIfDue(matchId, null))
                .isInstanceOf(IllegalStateException.class);

        // 롤백이 실제로 일어났다는 증거 — 이게 없으면 아래 0 은 "훅이 안 붙었다"와 구분되지 않는다.
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        assertThat(rewardLedgerRows(matchId)).isZero();

        // 핵심: 끝나지 않은 경기에는 종료 이벤트가 없다.
        assertThat(finishEvents(matchId)).isZero();
    }

    // ── ② 같은 경로가 정상 커밋되면 1건 (①의 0 이 공허하지 않다는 증거) ────

    @Test
    void theSamePathRecordsExactlyOneEventWhenSettlementCommits() {
        String token = setupUserWithDeck("evt_rb_ok");
        String matchId = createMatch(token, "BOT_BAL");
        forceSecondHalf(matchId);

        assertThat(orchestrator.settleFinishedIfDue(matchId, null)).isTrue();

        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        assertThat(finishEvents(matchId)).isEqualTo(1);
    }

    // ── helpers ───────────────────────────────────────────────────────────

    /**
     * 시뮬을 돌리지 않고 정산 진입점 바로 앞 상태를 만든다(BusinessEventFlowTest 와 같은 규율 —
     * 검증 대상은 시뮬이 아니라 <b>정산 트랜잭션 경계</b>라 그 경계만 정직하게 지나면 된다).
     */
    private void forceSecondHalf(String matchId) {
        jdbcClient.sql("""
                        UPDATE matches SET state = 'SECOND_HALF', score_h1_home = 1, score_h1_away = 0,
                               score_h2_home = 0, score_h2_away = 0, phase_start_at = ?, phase_ends_at = NULL
                        WHERE id = ?
                        """)
                .params(Instant.now().toString(), matchId)
                .update();
    }

    private long finishEvents(String matchId) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM business_events
                        WHERE event = 'match_finish' AND json_extract(props_json, '$.matchId') = ?
                        """)
                .param(matchId).query(Long.class).single();
    }

    private long rewardLedgerRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'")
                .param(matchId).query(Long.class).single();
    }
}
