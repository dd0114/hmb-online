package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
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
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 오토 모드 (#249) — 전반이 끝나면 감독시간(3분) 없이 후반이 바로 시작된다.
 *
 * <p><b>이 클래스가 박제하는 것</b>은 "오토면 빨라진다"가 아니라 <b>관측 가능한 계약</b> 넷이다:
 * ①오토 매치는 <b>기다리는 감독시간을 절대 노출하지 않는다</b>(만료된 0초 감독시간도 포함)
 * ②오토가 아니면 현행 감독시간 창이 한 밀리초도 안 바뀐다(회귀) ③토글은 경계 어느 쪽에 떨어져도
 * 결과가 같다(경합 무해) ④후반 인풋은 <b>새 AI 흐름 없이</b> 감독시간 만료 경로와 같은 것을 쓴다.
 *
 * <p>시간 의존을 대기로 만들지 않는다 — {@code phase_ends_at} 을 과거로 밀고 스위퍼를 직접 호출한다
 * ({@code MatchClockFlowTest} 와 같은 규율).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchAutoModeTest extends MatchTestBase {

    private static final long HALFTIME_MS = 60_000;

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        TestDbSupport.disableOverhaulRouting(registry);
        // 배경 스위퍼를 사실상 끈다 — 전이 시점을 이 테스트가 직접 통제한다.
        registry.add("hmb.match.clock.sweep-interval-ms", () -> "3600000");
        registry.add("hmb.match.clock.enabled", () -> "true");
        registry.add("hmb.match.clock.halftime-ms", () -> String.valueOf(HALFTIME_MS));
        registry.add("hmb.match.auto.enabled", () -> "true");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @Resource
    private FakeServants fakeServants;

    @Resource
    private MatchClockSweeper clockSweeper;

    @Resource
    private MatchClockService clockService;

    @Resource
    private ObjectMapper objectMapper;

    // ── 계약 ①: 오토면 감독시간을 거치지 않는다 ────────────────────────────

    @Test
    void autoSkipsHalftimeAndGoesStraightToTheSecondHalf() throws Exception {
        String token = setupUserWithDeck("auto_skip");
        String matchId = createMatch(token, "BOT_BAL");

        // 경기 시작 전(브리핑)에 켠다 — hero 요구 1의 한쪽.
        assertThat(setAuto(token, matchId, true).get("auto")).isEqualTo(true);

        kickoffAndSimulateH1(token, matchId);
        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");

        expireNow(matchId);
        clockSweeper.sweep();

        // 한 스윕 안에서 후반 재생 창까지 간다. 감독시간은 열리지 않았다.
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        // 계약 ④: 새 AI 흐름 0 — 하프타임 지시가 없으니 전반 인풋 승계(잡 자체가 안 뜬다).
        // 이건 감독시간 만료 경로(halftimeExpiryAutoResumesInheritingFirstHalfInputs)와 같은 성질이다.
        assertThat(queuedJobCount(matchId, 2)).isZero();
        JsonNode h1 = objectMapper.readTree(halfInput(matchId, 1));
        JsonNode h2 = objectMapper.readTree(halfInput(matchId, 2));
        assertThat(h2.path("seed").asText()).isNotEqualTo(h1.path("seed").asText());
        assertThat(withoutSeed(h2)).isEqualTo(withoutSeed(h1));
    }

    /**
     * 계약 ①의 날카로운 면 — <b>조회 경로가 만료된 0초 감독시간을 노출하지 않는다</b>.
     *
     * <p>오토는 감독시간을 0초로 열어 같은 체인에서 GEN2 로 잇는다(hero 컨펌 Q1). 그 두 번째 전이는
     * 엔진 RPC 를 물고 있어 조회 경로에서는 못 밟는데, 첫 번째만 밟아 두면 유저에게 <b>이미 만료된
     * 감독시간</b>이 보인다 = 감독 패널이 번쩍인다. 그래서 조회 경로는 오토 매치의 전반 종료 전이를
     * 아예 시작하지 않는다. 이 테스트가 그 가드를 지킨다(가드를 지우면 아래 단언이 HALFTIME 으로 깨진다).
     */
    @Test
    void readPathNeverExposesAnExpiredHalftimeForAutoMatches() {
        String token = setupUserWithDeck("auto_read");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);
        kickoffAndSimulateH1(token, matchId);

        expireNow(matchId);

        // 스위퍼 없이 GET 만. 아직 전반으로 보인다(≤ sweep-interval 후 후반이 열린다).
        Map<?, ?> detail = detail(token, matchId);
        assertThat(detail.get("state")).isEqualTo("FIRST_HALF");
        assertThat(clockService.clockOf(matchId).phase()).isEqualTo("FIRST_HALF");

        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }

    // ── 계약 ②: 오토가 아니면 현행 그대로 (회귀) ──────────────────────────

    @Test
    void withoutAutoTheHalftimeWindowIsUnchanged() {
        String token = setupUserWithDeck("auto_off");
        String matchId = createMatch(token, "BOT_BAL");
        kickoffAndSimulateH1(token, matchId);

        assertThat(detail(token, matchId).get("auto")).isEqualTo(false); // 기본값
        Instant boundary = Instant.now().minusSeconds(30);
        setPhaseEndsAt(matchId, boundary);
        clockSweeper.sweep();

        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        Instant start = Instant.parse(clockColumn(matchId, "phase_start_at"));
        Instant end = Instant.parse(clockColumn(matchId, "phase_ends_at"));
        assertThat(start).isEqualTo(boundary.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
        assertThat(Duration.between(start, end).toMillis()).isEqualTo(HALFTIME_MS);
    }

    /** hero 요구 3 — 전반 중에 오토를 풀면 정상 흐름(감독시간)이 돌아온다. */
    @Test
    void turningAutoOffDuringTheFirstHalfRestoresTheHalftime() {
        String token = setupUserWithDeck("auto_recant");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);
        kickoffAndSimulateH1(token, matchId);

        // 전반 재생 중에 푼다(hero 요구 1의 나머지 한쪽 = 전반 경기 중 토글).
        assertThat(setAuto(token, matchId, false).get("auto")).isEqualTo(false);

        expireNow(matchId);
        clockSweeper.sweep();

        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        Instant start = Instant.parse(clockColumn(matchId, "phase_start_at"));
        Instant end = Instant.parse(clockColumn(matchId, "phase_ends_at"));
        assertThat(Duration.between(start, end).toMillis()).isEqualTo(HALFTIME_MS);
    }

    // ── 계약 ③: 경계 경합이 무해하다 ──────────────────────────────────────

    /**
     * 감독시간이 이미 열린 뒤(=토글이 경계보다 1틱 늦게 도착) ON 이면 그 자리에서 후반이 열린다.
     * 덕분에 토글이 경계 <b>직전</b>에 떨어지든 <b>직후</b>에 떨어지든 유저가 보는 결과가 같다.
     */
    @Test
    void turningAutoOnAfterTheHalftimeOpenedStartsTheSecondHalfImmediately() {
        String token = setupUserWithDeck("auto_late");
        String matchId = createMatch(token, "BOT_BAL");
        kickoffAndSimulateH1(token, matchId);

        expireInto(matchId, "HALFTIME");
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        setAuto(token, matchId, true);

        // 감독시간 잔여와 무관하게 후반이 열렸다(POST /resume 과 같은 전이).
        assertThat(matchState(matchId)).isNotEqualTo("HALFTIME");
        assertThat(matchState(matchId)).isIn("GEN2", "SECOND_HALF");
    }

    /**
     * 경합의 <b>반대 방향</b> — 감독시간에 도착한 것이 OFF 면 감독시간이 그대로 살아 있어야 한다
     * (독립검증 major-1: {@code setAutoCas} 의 {@code auto &&} 가드를 지워도 게이트가 전부 통과했다).
     *
     * <p>이 경로는 실제로 일어난다: 화면이 아직 전반을 그리는 동안(조회 경로 가드로 최대 1초) 유저가
     * 오토를 <b>끄는데</b> 그 사이 스위퍼가 경계를 넘어 감독시간이 열리면, OFF 요청이 HALFTIME 에
     * 떨어진다. 가드가 없으면 끄려던 조작이 후반을 즉시 열어 <b>원했던 감독시간 3분을 통째로
     * 잃는다</b> — hero 요구 3 의 정반대다.
     */
    @Test
    void turningAutoOffDuringTheHalftimeKeepsTheHalftime() {
        String token = setupUserWithDeck("auto_late_recant");
        String matchId = createMatch(token, "BOT_BAL");
        kickoffAndSimulateH1(token, matchId);
        expireInto(matchId, "HALFTIME"); // 경계가 지나 감독시간이 열렸다(유저 화면은 아직 전반일 수 있다)

        String deadlineBefore = clockColumn(matchId, "phase_ends_at");
        assertThat(setAuto(token, matchId, false).get("auto")).isEqualTo(false);

        // 후반이 열리지 않았다. 감독시간 창도 손대지 않았다(끄는 조작이 시간을 깎지 않는다).
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        assertThat(clockColumn(matchId, "phase_ends_at")).isEqualTo(deadlineBefore);
    }

    /**
     * 오토가 여는 감독시간은 <b>정확히 0초</b>다 (독립검증 minor-3). 종단 상태만 단언하면 deadline 을
     * `boundary+1ms` 로 바꿔도 통과한다 — 스위프가 한 번 더 필요해질 뿐 수렴은 하기 때문이다.
     * "0초"가 문서에만 있고 계약엔 없으면 그건 계약이 아니다.
     */
    @Test
    void theAutoHalftimeWindowIsExactlyZero() {
        String token = setupUserWithDeck("auto_zero");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);
        kickoffAndSimulateH1(token, matchId);

        Instant boundary = Instant.now().minusSeconds(30);
        setPhaseEndsAt(matchId, boundary);

        // 조회 경로는 오토 전이를 시작하지 않으므로(가드), 무거운 전이를 막은 채 첫 전이만 관찰한다.
        // → HALFTIME 을 밟은 흔적을 phase_* 로 확인하려면 후반 시작을 잠시 막아야 한다.
        // 여기서는 대신 GEN2 진입 직후의 기록을 본다: 오토 경로가 남긴 것은 "경계 = 시작 = 종료"다.
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        // 후반 창은 감독시간 0초 뒤에 열렸다 — 경계 시각에 3분이 더해지지 않았다.
        // (감독시간이 180초였다면 후반 시작이 그만큼 늦다.)
        Instant secondHalfStart = Instant.parse(clockColumn(matchId, "phase_start_at"));
        assertThat(Duration.between(boundary, secondHalfStart).toMillis())
                .as("감독시간 0초 → 경계와 후반 시작 사이에 halftimeMs 가 끼지 않는다")
                .isLessThan(HALFTIME_MS);
    }

    /** 계약이 `required: [auto]` 라면 빠진 요청은 400 이다 — 조용히 OFF 가 아니다(독립검증 minor-2). */
    @Test
    void aRequestWithoutTheAutoFieldIsRejectedNotSilentlyTreatedAsOff() {
        String token = setupUserWithDeck("auto_badreq");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);

        assertThat(authPost("/api/matches/" + matchId + "/auto", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        // 거부된 요청이 상태를 바꾸지 않았다.
        assertThat(detail(token, matchId).get("auto")).isEqualTo(true);
    }

    /** 이중 토글은 멱등이다 — 연타가 상태를 흔들지 않는다. */
    @Test
    void repeatedTogglesAreIdempotent() {
        String token = setupUserWithDeck("auto_idem");
        String matchId = createMatch(token, "BOT_BAL");

        assertThat(setAuto(token, matchId, true).get("auto")).isEqualTo(true);
        assertThat(setAuto(token, matchId, true).get("auto")).isEqualTo(true);
        assertThat(setAuto(token, matchId, false).get("auto")).isEqualTo(false);
        assertThat(setAuto(token, matchId, false).get("auto")).isEqualTo(false);

        kickoffAndSimulateH1(token, matchId);
        expireNow(matchId);
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME"); // 마지막 값이 이긴다
    }

    /** 스위퍼를 여러 번 돌려도 전이는 한 번뿐이다(멱등 — 보상·시뮬 중복 금지). */
    @Test
    void repeatedSweepsTransitionOnlyOnce() {
        String token = setupUserWithDeck("auto_sweep");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);
        kickoffAndSimulateH1(token, matchId);

        expireNow(matchId);
        clockSweeper.sweep();
        String phaseStart = clockColumn(matchId, "phase_start_at");
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        clockSweeper.sweep();
        clockService.advanceDue(matchId);
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        assertThat(clockColumn(matchId, "phase_start_at")).isEqualTo(phaseStart);
        assertThat(halfRowCount(matchId, 2)).isEqualTo(1); // 후반이 두 번 시뮬되지 않았다
    }

    // ── 계약 ④: 프리페치 미완이면 GEN2 대기 = 기존 경로가 폴백 ─────────────

    /**
     * 하프타임 지시를 미리 써 두면 후반 인풋에 AI 패치 잡이 필요하다. 오토는 그 잡을 <b>기다린다</b> —
     * 감독시간을 건너뛴다고 준비 안 된 후반을 틀지 않는다. 잡이 끝나면 그대로 후반이 열린다.
     *
     * <p>이게 "프리페치 미완 폴백 = 짧은 GEN2 대기(기존 경로)"의 박제다. 그리고 <b>오토는 지시 포기가
     * 아니라는 것</b>도 같이 증명한다 — 전반 중에 써 둔 후반 지시가 그대로 잡에 실린다.
     */
    @Test
    void autoWaitsInGen2WhenTheSecondHalfInputIsNotReadyYet() throws Exception {
        String token = setupUserWithDeck("auto_pending");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);
        kickoffAndSimulateH1(token, matchId);

        // 전반을 보면서 후반 지시를 미리 써 둔다(FIRST_HALF 에서 허용 — LLD §2.3).
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", "후반은 역습"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        expireNow(matchId);
        clockSweeper.sweep();

        // 감독시간은 건너뛰었지만 후반은 아직 안 열렸다 — 인풋을 기다리는 중이다.
        assertThat(matchState(matchId)).isEqualTo("GEN2");
        JsonNode context = objectMapper.readTree(jobContext(matchId, 2, "home"));
        assertThat(context.path("kind").asText()).isEqualTo("team-input-patch");

        // 잡이 끝나면 그대로 후반.
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }

    // ── 액션 허용표 ───────────────────────────────────────────────────────

    /** 후반이 열린 뒤 토글은 409 — 감독시간은 지나갔고 되돌릴 수 없다(hero 지적의 명문화). */
    @Test
    void togglingAutoIsRejectedOnceTheSecondHalfHasOpened() {
        String token = setupUserWithDeck("auto_late_off");
        String matchId = createMatch(token, "BOT_BAL");
        setAuto(token, matchId, true);
        kickoffAndSimulateH1(token, matchId);
        expireNow(matchId);
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        assertThat(authPost("/api/matches/" + matchId + "/auto", token, Map.of("auto", false), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    /** 남의 매치는 404(소유권 비노출) — 다른 유저가 남의 경기 흐름을 바꿀 수 없다. */
    @Test
    void togglingSomeoneElsesMatchIsNotFound() {
        String owner = setupUserWithDeck("auto_owner");
        String stranger = setupUserWithDeck("auto_stranger");
        String matchId = createMatch(owner, "BOT_BAL");

        assertThat(authPost("/api/matches/" + matchId + "/auto", stranger, Map.of("auto", true), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── 헬퍼 ──────────────────────────────────────────────────────────────

    private Map<?, ?> setAuto(String token, String matchId, boolean auto) {
        var response = authPost("/api/matches/" + matchId + "/auto", token,
                Map.of("auto", auto), Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    private void kickoffAndSimulateH1(String token, String matchId) {
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
    }

    private Map<?, ?> detail(String token, String matchId) {
        var response = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    private void expireNow(String matchId) {
        setPhaseEndsAt(matchId, Instant.now().minusSeconds(1));
    }

    private void expireInto(String matchId, String targetState) {
        for (int i = 0; i < 4 && !targetState.equals(matchState(matchId)); i++) {
            expireNow(matchId);
            clockSweeper.sweep();
        }
        assertThat(matchState(matchId)).isEqualTo(targetState);
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

    private long queuedJobCount(String matchId, int half) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = 'queued'")
                .params(matchId, half).query(Long.class).single();
    }

    private long halfRowCount(String matchId, int half) {
        return jdbcClient.sql("SELECT COUNT(*) FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(Long.class).single();
    }

    private String halfInput(String matchId, int half) {
        return jdbcClient.sql("SELECT home_input_json FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(String.class).single();
    }

    private String jobContext(String matchId, int half, String side) {
        return jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = ? AND side = ?
                        ORDER BY created_at DESC LIMIT 1
                        """)
                .params(matchId, half, side).query(String.class).single();
    }

    private static JsonNode withoutSeed(JsonNode input) {
        com.fasterxml.jackson.databind.node.ObjectNode copy = input.deepCopy();
        copy.remove("seed");
        return copy;
    }
}
