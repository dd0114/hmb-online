package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import jakarta.annotation.Resource;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
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
 * P4-E2 (#170) 서버 권위 시계 + 감독시간 — LLD-e2-flow-clock §10 (T-W3, T-W2, T-M 계열).
 *
 * <p>시간 의존 테스트를 시계 대기로 만들지 않는다: 단계 종료 시각(`phase_ends_at`)을 DB 에서 과거로
 * 밀고 스위퍼/지연평가를 <b>직접 호출</b>한다(JobLeaseSweeper 테스트와 동일 규율 — 타이밍 비의존).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchClockFlowTest extends MatchTestBase {

    /** 픽스처 h1 재현 지문 — 시계 on/off 양쪽에서 같아야 한다(docs/plan-v2/fixtures/matchlog-h1.json). */
    static final String FIXTURE_H1_LAST_HASH = "1a7317ce";

    private static final long HALF_REAL_MS = 240_000;
    private static final long HALFTIME_MS = 60_000;

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
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
    private MatchClockService clockService;

    @Resource
    private MatchClockSweeper clockSweeper;

    @Resource
    private ObjectMapper objectMapper;

    // ── T-W3-1: 전반 라이브 진입 + 창 기록 ────────────────────────────────

    @Test
    void h1SimulationEntersFirstHalfAndRecordsClockWindow() {
        String token = setupUserWithDeck("clk_enter");
        String matchId = kickoffAndSimulateH1(token);

        assertThat(matchState(matchId)).isEqualTo("FIRST_HALF");

        Map<?, ?> detail = detail(token, matchId);
        Map<?, ?> clock = (Map<?, ?>) detail.get("clock");
        assertThat(clock).isNotNull();
        assertThat(clock.get("phase")).isEqualTo("FIRST_HALF");
        assertThat((String) clock.get("kickoffAt")).isNotBlank();
        assertThat((String) clock.get("serverNow")).isNotBlank();
        assertThat(((Number) clock.get("halfRealMs")).longValue()).isEqualTo(HALF_REAL_MS);
        assertThat(((Number) clock.get("halftimeMs")).longValue()).isEqualTo(HALFTIME_MS);
        assertThat(clock.get("seekForwardBlocked")).isEqualTo(true);

        // 창 = kickoffAt .. kickoffAt + halfRealMs (AC-W3-2/3)
        Instant start = Instant.parse((String) clock.get("phaseStartAt"));
        Instant end = Instant.parse((String) clock.get("phaseEndsAt"));
        assertThat(Duration.between(start, end).toMillis()).isEqualTo(HALF_REAL_MS);
        assertThat((String) clock.get("kickoffAt")).isEqualTo(clock.get("phaseStartAt"));

        // 스포일러 금지: 전반이 진행 중인 동안 전반 스코어는 노출하지 않는다.
        assertThat(detail.get("scoreH1Home")).isNull();
        assertThat(detail.get("scoreH1Away")).isNull();

        // 전반 로그는 라이브 중에도 받아야 재생할 수 있다(상한은 clock 기반 클라 강제).
        assertThat(authGet("/api/matches/" + matchId + "/halves/1/log", token, String.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ── T-W2-1: 후반 앞당기기 금지 + 전반 중 사전입력 허용 ────────────────

    @Test
    void resumeIsRejectedDuringFirstHalfButPreInputIsAllowed() {
        String token = setupUserWithDeck("clk_pre");
        String matchId = kickoffAndSimulateH1(token);

        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);

        // 전반을 보면서 후반 지시를 미리 쓰고, 교체도 미리 짜둘 수 있다(#169 S1 "후반 지시" 패널 계약).
        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", "후반엔 라인 내려"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ── T-W3-2/3: 만료 전이는 경계값 기준 + 멱등 ──────────────────────────

    @Test
    void expiryUsesBoundaryNotNowAndIsIdempotent() {
        String token = setupUserWithDeck("clk_bound");
        String matchId = kickoffAndSimulateH1(token);

        // 스위퍼가 늦게 도는 상황: 창이 30초 전에 이미 끝났다.
        Instant boundary = Instant.now().minusSeconds(30);
        setPhaseEndsAt(matchId, boundary);

        // 반환값(진행시킨 매치 수)이 아니라 결과 상태로 판정한다 — 백그라운드 @Scheduled 스위퍼가
        // 같은 전이를 먼저 집어갈 수 있고, 그래도 결과가 같아야 하는 게 이 설계의 요지다(멱등).
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 감독시간 창은 **경계에서** 시작한다 — 스위퍼 지연이 감독시간을 늘리지 않는다(AC-W2-3 재현).
        Instant halftimeStart = Instant.parse(clockColumn(matchId, "phase_start_at"));
        Instant halftimeEnd = Instant.parse(clockColumn(matchId, "phase_ends_at"));
        assertThat(halftimeStart).isEqualTo(boundary.truncatedTo(java.time.temporal.ChronoUnit.MILLIS));
        assertThat(Duration.between(halftimeStart, halftimeEnd).toMillis()).isEqualTo(HALFTIME_MS);

        // 멱등: 다시 돌려도 아무 일도 없다(아직 감독시간 안).
        clockSweeper.sweep();
        clockService.advanceDue(matchId);
        clockService.advanceDue(matchId);
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        assertThat(Instant.parse(clockColumn(matchId, "phase_ends_at"))).isEqualTo(halftimeEnd);

        // 감독시간 중 전반 스코어는 이제 공개된다(전반이 끝났으므로).
        assertThat(detail(token, matchId).get("scoreH1Home")).isEqualTo(1);
    }

    // ── T-W2-4: 미제출 만료 = 전반 프롬프트(=인풋) 승계, AI 콜 0 ───────────

    @Test
    void halftimeExpiryAutoResumesInheritingFirstHalfInputs() throws Exception {
        String token = setupUserWithDeck("clk_inherit");
        String matchId = kickoffAndSimulateH1(token);

        expireInto(matchId, "HALFTIME");
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");

        // 유저가 아무것도 제출하지 않고 감독시간이 끝난다.
        expireNow(matchId);
        clockSweeper.sweep();

        // 승계 = 전반 인풋 재사용(materialized)이라 **AI 잡이 아예 큐에 안 뜬다** → GEN2 를 그 자리에서
        // 통과해 후반 재생 창까지 간다(서번트 왕복 0). 잡이 필요한 경우(프롬프트 있음)와의 차이가 이것이다.
        assertThat(queuedJobCount(matchId, 2)).isZero();
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        JsonNode h1Input = objectMapper.readTree(halfInput(matchId, 1));
        JsonNode h2Input = objectMapper.readTree(halfInput(matchId, 2));
        assertThat(h2Input.path("seed").asText()).isNotEqualTo(h1Input.path("seed").asText());
        assertThat(withoutSeed(h2Input)).isEqualTo(withoutSeed(h1Input)); // 전반 지시 그대로 승계
    }

    // ── T-W2-4(뒷면): 하프타임 프롬프트가 있으면 라이브 AI 재호출(패치 잡) ──

    @Test
    void halftimePromptsProduceAPatchJobForSecondHalf() throws Exception {
        String token = setupUserWithDeck("clk_patch");
        String matchId = kickoffAndSimulateH1(token);

        assertThat(authPost("/api/matches/" + matchId + "/prompts", token,
                Map.of("phase", "halftime", "scope", "team", "text", "후반은 역습"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        expireInto(matchId, "HALFTIME");
        expireNow(matchId);
        clockSweeper.sweep();
        assertThat(matchState(matchId)).isEqualTo("GEN2");

        JsonNode context = objectMapper.readTree(jobContext(matchId, 2, "home"));
        assertThat(context.path("kind").asText()).isEqualTo("team-input-patch");
        assertThat(context.path("base").isObject()).isTrue();
    }

    // ── T-W2-2: 유저 제출은 감독시간 잔여와 무관하게 즉시 후반 ─────────────

    @Test
    void userSubmitDuringHalftimeResumesImmediately() {
        String token = setupUserWithDeck("clk_submit");
        String matchId = kickoffAndSimulateH1(token);
        expireInto(matchId, "HALFTIME");

        ResponseEntity<Map> resume = authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        assertThat(resume.getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        // 프롬프트·교체가 없으면 후반 인풋은 재사용이라 GEN2 를 즉시 통과한다(AI 콜 0).
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        // 이미 후반이 시작됐으면 두 번째 제출은 409 — 감독시간은 한 번뿐이다(멱등).
        assertThat(authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
    }

    // ── T-W3-4: 서버가 오래 죽어 있었어도 한 번에 따라잡는다 ───────────────

    @Test
    void catchUpChainsTransitionsAfterDowntime() {
        String token = setupUserWithDeck("clk_catchup");
        String matchId = kickoffAndSimulateH1(token);

        // 전반 창도, 그 뒤 감독시간도 이미 한참 전에 끝났다(서버 다운 10분).
        setPhaseEndsAt(matchId, Instant.now().minusSeconds(600));

        // 한 호출로 FIRST_HALF → HALFTIME → GEN2 를 연쇄로 밟는다(승계라 GEN2 는 그대로 통과).
        clockService.advanceDue(matchId);
        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");

        // 새 창은 따라잡기 시점에 열린다 — 유저는 후반을 처음부터 본다(경과분을 건너뛰지 않는다).
        MatchClockService.MatchClock clock = clockService.clockOf(matchId);
        assertThat(clock).isNotNull();
        assertThat(clock.phase()).isEqualTo("SECOND_HALF");
        assertThat(Instant.parse(clock.phaseEndsAt())).isAfter(Instant.now());
    }

    // ── T-M-1: 후반 재생이 끝나야 FINISHED + 정산(정확히 1회) ─────────────

    @Test
    void settlementHappensOnlyWhenSecondHalfClockExpires() {
        String token = setupUserWithDeck("clk_settle");
        String matchId = kickoffAndSimulateH1(token);
        expireInto(matchId, "HALFTIME");
        expireNow(matchId);
        clockSweeper.sweep();
        fakeServants.drain();

        assertThat(matchState(matchId)).isEqualTo("SECOND_HALF");
        // 후반 스코어는 DB 에 보관된다(응답엔 안 나가지만 정산 때 합산돼야 한다). 픽스처 h2 = 0-0 이라
        // 여기서 임의 값으로 덮어 **합산 경로**를 실제로 태운다 — 안 그러면 "저장 안 함"과 구분되지 않는다.
        assertThat(clockColumn(matchId, "score_h2_home")).isNotNull();
        assertThat(clockColumn(matchId, "score_h2_away")).isNotNull();
        jdbcClient.sql("UPDATE matches SET score_h2_home = 2, score_h2_away = 1 WHERE id = ?")
                .param(matchId).update();
        // 재생 중에는 결과도, 최종 스코어도, 보상도 없다(스포일러 금지 + 라이브 모델 정합).
        assertThat(authGet("/api/matches/" + matchId + "/result", token, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.CONFLICT);
        Map<?, ?> live = detail(token, matchId);
        assertThat(live.get("scoreHome")).isNull();
        assertThat(live.get("result")).isNull();
        assertThat(rewardLedgerRows(matchId)).isZero();

        // 후반 창 만료 → FINISHED + 정산. **스위퍼 단독으로** 돌린다 — "화면을 안 봐도 정산된다"가
        // 이 경로의 계약이고, 여기서 GET 지연평가를 같이 부르면 스위퍼 결함이 가려진다(독립검증 major).
        expireNow(matchId);
        clockSweeper.sweep();
        clockSweeper.sweep(); // 여러 번 돌아도 보상은 1회(멱등)

        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        Map<?, ?> finished = detail(token, matchId);
        assertThat(finished.get("clock")).isNull();
        assertThat(finished.get("scoreHome")).isEqualTo(3); // h1 1-0 + h2 2-1
        assertThat(finished.get("scoreAway")).isEqualTo(1);
        assertThat(finished.get("result")).isEqualTo("WIN");
        assertThat(rewardLedgerRows(matchId)).isEqualTo(1);
        // 정산의 나머지 side effect(관계/사기, AC-C4)도 이 전이에서 정확히 1회 적용된다.
        assertThat(jdbcClient.sql("SELECT relations_applied FROM matches WHERE id = ?")
                .param(matchId).query(Integer.class).single()).isEqualTo(1);
        assertThat(authGet("/api/matches/" + matchId + "/result", token, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
        assertThat(authGet("/api/matches/" + matchId + "/halves/2/log", token, String.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);
    }

    // ── T-W2-5: 시계는 시뮬 입력에 흘러들지 않는다(결정론 불변, 루트 §2-5) ──

    @Test
    void clockDoesNotChangeTheSimulationBundle() {
        String token = setupUserWithDeck("clk_determinism");
        String matchId = kickoffAndSimulateH1(token);

        // 시계 켜짐/꺼짐과 무관하게 같은 시드·같은 인풋이면 같은 결과여야 한다. 재현 지문(last_hash)이
        // 시계 없는 경로(MatchClockDisabledTest)와 **같은 값**인지로 박제한다.
        assertThat(halfLastHash(matchId, 1)).isEqualTo(FIXTURE_H1_LAST_HASH);
    }

    // ── 지연 평가: 스위퍼가 없어도 보고 있는 화면은 정확하다 ────────────────

    @Test
    void gettingTheMatchAdvancesDueTransitionsLazily() {
        String token = setupUserWithDeck("clk_lazy");
        String matchId = kickoffAndSimulateH1(token);
        expireNow(matchId);

        // 스위퍼를 호출하지 않는다 — GET 만으로 만료가 반영돼야 한다.
        assertThat(detail(token, matchId).get("state")).isEqualTo("HALFTIME");
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private String kickoffAndSimulateH1(String token) {
        String matchId = createMatch(token, "BOT_BAL");
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        return matchId;
    }

    private Map<?, ?> detail(String token, String matchId) {
        ResponseEntity<Map> response = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(response.getStatusCode()).isEqualTo(HttpStatus.OK);
        return response.getBody();
    }

    /** 현재 단계 창을 과거로 밀고 만료를 반영시킨다(= 그 단계가 끝났다). */
    private void expireNow(String matchId) {
        setPhaseEndsAt(matchId, Instant.now().minusSeconds(1));
    }

    /** 만료를 반복 적용해 목표 상태까지 진행시킨다(테스트 준비용). */
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

    private String halfLastHash(String matchId, int half) {
        return jdbcClient.sql("SELECT last_hash FROM match_halves WHERE match_id = ? AND half = ?")
                .params(matchId, half).query(String.class).single();
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

    private long queuedJobCount(String matchId, int half) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE match_id = ? AND half = ? AND status = 'queued'")
                .params(matchId, half).query(Long.class).single();
    }

    private long rewardLedgerRows(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE ref_id = ? AND reason LIKE 'reward_%'")
                .param(matchId).query(Long.class).single();
    }

    private static JsonNode withoutSeed(JsonNode input) {
        ObjectNode copy = input.deepCopy();
        copy.remove("seed");
        return copy;
    }
}
