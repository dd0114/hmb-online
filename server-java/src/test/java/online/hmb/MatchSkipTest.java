package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
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
 * 경기 스킵 — {@code POST /api/matches/{id}/skip} (#421 W1).
 *
 * <p><b>무엇을 박제하나.</b> 스킵은 <b>새 상태 전이를 만들지 않는다</b> — 라이브 재생 창
 * ({@code phase_ends_at})을 지금으로 당기기만 하고, 그 뒤는 기존 만료 전이가 그대로 밟는다
 * (#249 오토가 감독시간 길이를 0으로 만들어 새 엣지 0개로 끝낸 것과 같은 수법). 그래서 이 클래스가
 * 지키는 것은 "빨라진다"가 아니라 <b>당김이 만들 수 있는 사고 넷</b>이다:
 *
 * <ol>
 *   <li><b>경합으로 다음 단계를 삼키지 않는다</b> — 바디 {@code phase} 를 CAS {@code WHERE state=?}
 *       에 넣는다. 전반 막바지 스킵과 스위퍼의 감독시간 개시가 1초 안에 겹칠 때, phase 없는 스킵은
 *       재전송 한 번으로 <b>후반을 통째로 날린다</b>(#249 가 {@code auto &&} 한 토큰으로 막은 것과
 *       같은 함정).</li>
 *   <li><b>되감기 불가</b> — 창은 앞으로만 당겨진다. 이미 지난 창을 지금으로 "당기면" 그건 연장이고,
 *       지고 있는 경기의 시간벌기가 된다.</li>
 *   <li><b>보상은 그대로 1회</b> — 후반 스킵은 정산 경계 CAS 를 그대로 타므로 두 번 눌러도 원장은
 *       한 줄이다.</li>
 *   <li><b>결정론 무영향</b> — 하프 번들(로그·resumeState·lastHash)은 창이 열리기 <b>전에</b>
 *       확정된다. 스킵은 그 뒤의 창만 만지므로 결과가 달라질 경로가 0개여야 한다.</li>
 * </ol>
 *
 * <p>시간 의존을 대기로 만들지 않는다 — {@code phase_ends_at} 을 DB 에서 밀고 스위퍼를 직접 부른다
 * ({@code MatchClockFlowTest} 와 같은 규율).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchSkipTest extends MatchTestBase {

    private static final long HALF_REAL_MS = 240_000;
    private static final long HALFTIME_MS = 60_000;

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        // 배경 @Scheduled 스위퍼를 사실상 끈다 — 스킵이 <b>요청 안에서</b> 전이를 끝내는지가 이
        // 클래스의 주제라, 스위퍼가 끼면 "누가 전이시켰나"를 구분할 수 없다.
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.clock.half-real-ms", () -> String.valueOf(HALF_REAL_MS));
        registry.add("hmb.match.clock.halftime-ms", () -> String.valueOf(HALFTIME_MS));
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    // ── ① 스킵하면 그 요청 안에서 다음 단계가 열린다 ──────────────────────

    /**
     * "닫으면 바로 후반"의 서버측 조건. 스위퍼를 <b>한 번도 부르지 않고</b> 전이 후 상태가 응답에
     * 실려야 한다 — 스위퍼 주기(1s)를 기다리면 유저에게 만료된 전반이 스쳐간다.
     */
    @Test
    void skippingTheFirstHalfOpensTheHalftimeInTheSameRequest() {
        String token = setupUserWithDeck("skip_h1");
        String matchId = kickoffAndSimulateH1(token);
        Instant plannedEnd = Instant.parse(clockColumn(matchId, "phase_ends_at"));

        ResponseEntity<Map> response = skip(token, matchId, "FIRST_HALF");

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().get("state")).isEqualTo("HALFTIME");
        Map<?, ?> clock = (Map<?, ?>) response.getBody().get("clock");
        assertThat(clock).isNotNull();
        assertThat(clock.get("phase")).isEqualTo("HALFTIME"); // 전이 후 시계가 실려 온다
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 감독시간은 <b>스킵한 그 순간</b>부터 정상 길이로 열린다(짧아지지도 길어지지도 않는다).
        Instant halftimeStart = Instant.parse(clockColumn(matchId, "phase_start_at"));
        Instant halftimeEnd = Instant.parse(clockColumn(matchId, "phase_ends_at"));
        assertThat(Duration.between(halftimeStart, halftimeEnd).toMillis()).isEqualTo(HALFTIME_MS);
        assertThat(halftimeStart).isBefore(plannedEnd); // 원래 전반 종료 예정보다 앞이다 = 당겨졌다
    }

    // ── ② 바디 phase = CAS 키 (경합으로 다음 단계를 삼키지 않는다) ─────────

    /**
     * 전반이 도는 중에 도착한 "후반 스킵"은 409 다. 이 단언이 지키는 것은 문법 검사가 아니라
     * <b>경합</b>이다 — phase 를 CAS 에 넣지 않으면 같은 요청이 다음 단계(후반)에 떨어졌을 때
     * 그 단계를 통째로 날린다.
     */
    @Test
    void skipRefusesAPhaseThatIsNotTheOneRunning() {
        String token = setupUserWithDeck("skip_phase");
        String matchId = kickoffAndSimulateH1(token);
        String windowBefore = clockColumn(matchId, "phase_ends_at");

        ResponseEntity<Map> response = skip(token, matchId, "SECOND_HALF");

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(response.getBody().get("code")).isEqualTo("INVALID_STATE");
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        assertThat(clockColumn(matchId, "phase_ends_at")).isEqualTo(windowBefore); // 창 무접촉
    }

    /**
     * 재전송 시나리오: 스킵이 성공한 뒤 <b>같은 요청이 한 번 더</b> 도착한다(더블클릭·리트라이).
     * 두 번째는 409 여야 하고, <b>무엇보다 감독시간이 살아있어야</b> 한다.
     */
    @Test
    void aRepeatedSkipDoesNotSwallowTheNextPhase() {
        String token = setupUserWithDeck("skip_repeat");
        String matchId = kickoffAndSimulateH1(token);

        assertThat(skip(token, matchId, "FIRST_HALF").getStatusCode()).isEqualTo(HttpStatus.OK);
        String halftimeWindow = clockColumn(matchId, "phase_ends_at");

        ResponseEntity<Map> again = skip(token, matchId, "FIRST_HALF");

        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(again.getBody().get("code")).isEqualTo("INVALID_STATE");
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        assertThat(clockColumn(matchId, "phase_ends_at")).isEqualTo(halftimeWindow);
    }

    @Test
    void skipRequiresAPhaseInTheBody() {
        String token = setupUserWithDeck("skip_nophase");
        String matchId = kickoffAndSimulateH1(token);

        assertThat(authPost("/api/matches/" + matchId + "/skip", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        // 라이브 단계가 아닌 값(감독시간)은 스킵 대상이 아니다 — 400 이지 조용한 성공이 아니다.
        assertThat(skip(token, matchId, "HALFTIME").getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
    }

    // ── ③ 되감기 불가 (창을 늘리는 도구가 아니다) ──────────────────────────

    /**
     * 이미 만료된 창을 스킵하면 <b>창이 앞으로 밀려서는 안 된다</b>. 그대로 {@code now} 를 쓰면 지난
     * 경계가 현재로 이동해 그만큼 <b>시간을 산다</b>(다음 단계 시작이 늦어진다). 만료 전이의 경계는
     * 언제나 원래 경계여야 한다(AC-W2-3 누적오차 0 과 같은 성질).
     */
    @Test
    void skipCannotBuyTimeOnAnAlreadyExpiredWindow() {
        String token = setupUserWithDeck("skip_rewind");
        String matchId = kickoffAndSimulateH1(token);

        Instant expired = Instant.now().minusSeconds(30);
        setPhaseEndsAt(matchId, expired);

        assertThat(skip(token, matchId, "FIRST_HALF").getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        // 감독시간은 **원래 경계**에서 시작한다 — 스킵이 창을 now 로 늘렸다면 30초 뒤가 됐을 것이다.
        assertThat(Instant.parse(clockColumn(matchId, "phase_start_at")))
                .isEqualTo(expired.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
    }

    // ── ④ 후반 스킵 = 종료·정산, 보상은 1회 ────────────────────────────────

    @Test
    void skippingTheSecondHalfFinishesAndSettlesExactlyOnce() {
        String token = setupUserWithDeck("skip_h2");
        String matchId = reachSecondHalf(token);

        ResponseEntity<Map> response = skip(token, matchId, "SECOND_HALF");

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().get("state")).isEqualTo("FINISHED");
        assertThat(response.getBody().get("result")).isNotNull();
        assertThat(response.getBody().get("clock")).isNull(); // 끝난 매치엔 창이 없다
        assertThat(rewardLedgerRows(matchId)).isEqualTo(1);

        // 두 번째 스킵은 409 — 그리고 보상은 그대로 한 줄이다(정산 경계 CAS 가 소유).
        assertThat(skip(token, matchId, "SECOND_HALF").getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(rewardLedgerRows(matchId)).isEqualTo(1);
        assertThat(authGet("/api/matches/" + matchId + "/result", token, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    // ── ⑤ 오토 모드와 정합 (추가 배선 0) ──────────────────────────────────

    /**
     * 오토(#249)면 감독시간이 0초로 열리므로 <b>같은 체인</b>이 후반 재생까지 잇는다. 스킵은 창만
     * 당기고 전이는 기존 경로가 밟으므로 이 성질은 <b>배선 없이</b> 따라와야 한다 — 따라오지 않으면
     * 스킵이 어딘가에 자기 전이를 새로 판 것이다.
     */
    @Test
    void skipInAutoModeChainsStraightToTheSecondHalf() {
        String token = setupUserWithDeck("skip_auto");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/auto", token, Map.of("auto", true), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        kickoffAndSimulateH1(token, matchId);

        ResponseEntity<Map> response = skip(token, matchId, "FIRST_HALF");

        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(response.getBody().get("state")).isEqualTo("SECOND_HALF");
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        // 새 AI 흐름 0 — 감독시간 만료 경로와 같은 승계(잡이 큐에 뜨지 않는다).
        assertThat(queuedJobCount(matchId, 2)).isZero();
    }

    // ── ⑥ 결정론: 스킵은 시뮬 번들을 만지지 않는다 ─────────────────────────

    /**
     * 하프 번들은 창이 열리기 <b>전에</b> 확정되고 {@code phase_ends_at} 은 시뮬 입력 어디에도 들어가지
     * 않는다 → 스킵으로 결과가 달라질 경로는 0개다. 스킵 전후로 h1 번들이 <b>바이트 단위로</b> 같은지,
     * 그리고 스킵으로 만들어진 h2 가 <b>만료 경로로 만든 h2 와 같은 지문</b>인지로 박는다.
     *
     * <p>(러너는 픽스처를 돌려주는 페이크다 — 이 단언이 증명하는 것은 "엔진이 결정론적"이 아니라
     * <b>서버가 스킵 경로에서 같은 번들을 같은 입력으로 저장한다</b>는 쪽이다. 엔진 결정론은
     * packages/engine 의 골든이 소유한다.)
     */
    @Test
    void skipDoesNotChangeTheSimulationBundle() {
        String token = setupUserWithDeck("skip_determinism");
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/auto", token, Map.of("auto", true), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        kickoffAndSimulateH1(token, matchId);

        String logBefore = halfColumn(matchId, 1, "match_log_json");
        String resumeBefore = halfColumn(matchId, 1, "resume_state_json");
        String hashBefore = halfColumn(matchId, 1, "last_hash");
        assertThat(hashBefore).isEqualTo(MatchClockFlowTest.FIXTURE_H1_LAST_HASH);

        skip(token, matchId, "FIRST_HALF");

        assertThat(halfColumn(matchId, 1, "match_log_json")).isEqualTo(logBefore);
        assertThat(halfColumn(matchId, 1, "resume_state_json")).isEqualTo(resumeBefore);
        assertThat(halfColumn(matchId, 1, "last_hash")).isEqualTo(hashBefore);
        String skippedH2Hash = halfColumn(matchId, 2, "last_hash");

        // 대조군: 스킵 없이 만료로 후반까지 간 매치(다른 유저 = 잠금 무관). 같은 지문이어야 한다.
        String controlToken = setupUserWithDeck("skip_control");
        String controlId = reachSecondHalf(controlToken);
        assertThat(halfColumn(controlId, 1, "last_hash")).isEqualTo(hashBefore);
        assertThat(halfColumn(controlId, 2, "last_hash")).isEqualTo(skippedH2Hash);
    }

    // ── ⑦ 소유권 ───────────────────────────────────────────────────────

    @Test
    void skipIsRefusedForSomeoneElsesMatch() {
        String token = setupUserWithDeck("skip_owner");
        String matchId = kickoffAndSimulateH1(token);
        String windowBefore = clockColumn(matchId, "phase_ends_at");

        String intruder = setupUserWithDeck("skip_intruder");
        ResponseEntity<Map> response = skip(intruder, matchId, "FIRST_HALF");

        // 소유권 비노출 = 404(존재 자체를 알리지 않는다. getOwned 관례).
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        assertThat(clockColumn(matchId, "phase_ends_at")).isEqualTo(windowBefore);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private ResponseEntity<Map> skip(String token, String matchId, String phase) {
        return authPost("/api/matches/" + matchId + "/skip", token, Map.of("phase", phase), Map.class);
    }

    private String kickoffAndSimulateH1(String token) {
        return kickoffAndSimulateH1(token, createMatch(token, "BOT_BAL"));
    }

    private String kickoffAndSimulateH1(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");
        return matchId;
    }

    /** 스킵 없이(=만료 경로로) 후반 재생 창까지 간다 — 대조군·전제 준비용. */
    private String reachSecondHalf(String token) {
        String matchId = kickoffAndSimulateH1(token);
        for (int i = 0; i < 4 && !"SECOND_HALF".equals(matchState(matchId)); i++) {
            setPhaseEndsAt(matchId, Instant.now().minusSeconds(1));
            clockSweeper.sweep();
        }
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        return matchId;
    }

    private void setPhaseEndsAt(String matchId, Instant instant) {
        jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                .params(MatchClockService.format(instant), matchId)
                .update();
    }

    private String clockColumn(String matchId, String column) {
        return jdbcClient.sql("SELECT " + column + " FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    private String halfColumn(String matchId, int half, String column) {
        return jdbcClient.sql("SELECT " + column + " FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(String.class).single();
    }

    private long queuedJobCount(String matchId, int half) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = 'queued'")
                .params(matchId, half).query(Long.class).single();
    }

    private long rewardLedgerRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'")
                .param(matchId).query(Long.class).single();
    }
}
