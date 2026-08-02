package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import online.hmb.common.Ulid;
import online.hmb.match.MatchClockService;
import online.hmb.match.MatchClockSweeper;
import online.hmb.mission.MissionProperties;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Import;
import org.springframework.context.annotation.Primary;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 원정 데일리 미션 — <b>{@code finishMatch} 호출부가 훅에 넘기는 인자</b>의 계약 (#408, 독립검증
 * minor-1/minor-2 로 발견된 커버리지 공백).
 *
 * <h2>왜 별도 클래스인가</h2>
 * {@code MissionDailyTest} 는 {@code finishedAt}·{@code userHome} 을 <b>서비스에 직접 넘긴다</b> =
 * 호출자가 무엇을 넘기는지는 한 번도 검사하지 않는다. {@code MissionMatchFlowTest} 는 실제 경기를
 * 태우지만 "미션이 밀렸다" 한 축만 본다. 그래서 독립검증이 다음 두 변이를 <b>미션 계약 55건 전부
 * 통과</b>시켰다:
 * <ul>
 *   <li>{@code clockService.now()} → {@code Instant.parse(match.createdAt())}
 *       — 설계 §6.1 이 <b>이름 붙여 경계한 버그</b>(23:58 에 시작해 00:03 에 끝난 경기가 어제 미션을
 *       채운다)를 한 줄로 되살린다. 하루를 <b>빼는</b> 변이는 죽었으니, <b>그럴듯하게 틀린 값만</b>
 *       통과하는 상태였다 — 가장 나쁜 종류의 구멍이다.</li>
 *   <li>{@code userHome} → {@code !userHome} — 선제골 판정의 기준 사이드가 뒤집힌다.</li>
 * </ul>
 *
 * <p>여기서는 <b>서비스에 아무것도 직접 넘기지 않는다.</b> 시각도 사이드도 전부 실제 경기 흐름
 * (HTTP 킥오프 → 엔진 → 시계 스윕 → FINISHED CAS)이 정하게 두고 결과만 본다. 그래야 호출부가 태워진다.
 *
 * <p>시각은 주입 {@link Clock}(@Primary)으로 옮긴다 — 매치 생성과 종료가 <b>서로 다른 KST 날짜</b>에
 * 걸치는 표본은 그 방법으로만 만들 수 있다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MissionFinishHookWiringTest extends MatchTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    /** KST 2026-08-02 12:00 — 하루 한복판(경계와 무관한 표본용). */
    private static final Instant MIDDAY = Instant.parse("2026-08-02T03:00:00Z");
    /** KST 2026-08-02 23:59 — 자정 1분 전. 매치를 <b>여기서 만든다</b>. */
    private static final Instant BEFORE_MIDNIGHT = Instant.parse("2026-08-02T14:59:00Z");
    /**
     * KST 2026-08-03 00:01 — 자정 통과. 매치를 <b>여기서 끝낸다</b>.
     *
     * <p><b>UTC 로는 여전히 08-02</b> 라 존을 무시한 구현은 생성일과 같은 날로 읽는다. 간격을 2분으로
     * 좁게 잡은 이유: {@code hmb.match.abandon.stale-after-min}(720분)에 안 걸리게 — 표본이 주제와
     * 무관한 스위퍼에 먹히면 계약이 조용히 공허해진다.
     */
    private static final Instant AFTER_MIDNIGHT = Instant.parse("2026-08-02T15:01:00Z");

    static final AtomicReference<Instant> NOW = new AtomicReference<>(MIDDAY);

    @TestConfiguration
    static class MutableClockConfig {
        @Bean
        @Primary
        Clock testClock() {
            return new Clock() {
                @Override
                public ZoneId getZone() {
                    return KST;
                }

                @Override
                public Clock withZone(ZoneId zone) {
                    return this;
                }

                @Override
                public Instant instant() {
                    return NOW.get();
                }
            };
        }
    }

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

    @Resource
    private online.hmb.away.AwayService awayService;

    @Resource
    private MissionProperties missionProps;

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private String startAwayPinned(String attackerId, String defenderId) {
        // ⚠️ 제시 TTL 은 주입 Clock 이 아니라 **실제 시각**을 본다(`AwayService.assertOffered` 가
        // `Instant.now()` 를 쓴다 — 이 웨이브의 주제가 아닌 선존 관행). 그래서 이 픽스처 행만
        // 실제 시각으로 찍는다. 테스트 시계로 찍으면 시계를 옮긴 표본에서 "상대 목록이 만료됐습니다"
        // 로 무너져, 계약이 자기 주제와 무관한 이유로 깨진다.
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, "[\"" + defenderId + "\"]", Instant.now().toString())
                .update();
        return awayService.start(attackerId, defenderId).id();
    }

    /**
     * 실제 경기를 FINISHED 까지 민다. 단계 만료는 <b>테스트 시계 기준</b>으로 찍는다 — 실제 시각으로
     * 찍으면 스위퍼(주입 Clock)가 그 행을 due 로 보지 않아 루프가 헛돈다.
     */
    private void driveToFinished(String token, String matchId) {
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        for (int i = 0; i < 6 && !"FINISHED".equals(matchState(matchId)); i++) {
            jdbcClient.sql("UPDATE matches SET phase_ends_at = ? WHERE id = ?")
                    .params(MatchClockService.format(NOW.get().minusSeconds(1)), matchId)
                    .update();
            clockSweeper.sweep();
            fakeServants.drain();
        }
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    private String createdAtOf(String matchId) {
        return jdbcClient.sql("SELECT created_at FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
    }

    /** 그 경기가 민 미션들이 **어느 날짜의** 미션인가. 훅이 어떤 시각을 넘겼는지가 여기 드러난다. */
    private List<String> daysProgressedBy(String matchId) {
        return jdbcClient.sql("""
                        SELECT DISTINCT m.day FROM daily_mission_progress p
                          JOIN daily_missions m ON m.id = p.mission_row_id
                         WHERE p.match_id = ?
                        """)
                .param(matchId).query(String.class).list();
    }

    /** 지정한 미션을 그 슬롯에 심는다 — 추첨 운(유저 id = ULID)과 주제를 분리한다. */
    private String seed(String userId, String day, int slotNo, String missionId) {
        MissionProperties.Entry e = missionProps.getCatalog().stream()
                .filter(x -> missionId.equals(x.getId())).findFirst().orElseThrow();
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO daily_missions(id, user_id, day, slot_no, mission_id, title, tier,
                                rule, currency, amount, target, progress, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'GEM', 100, ?, 0, ?)
                        """)
                .params(id, userId, day, slotNo, e.getId(), e.getTitle(), e.getTier(),
                        e.getRule().name(), e.getTarget(), NOW.get().toString())
                .update();
        return id;
    }

    private int progressOf(String missionRowId) {
        return jdbcClient.sql("SELECT progress FROM daily_missions WHERE id = ?")
                .param(missionRowId).query(Integer.class).single();
    }

    // ── minor-1: 훅이 넘기는 시각 = **종료 시각** ────────────────────────

    /**
     * <b>자정을 넘겨 끝난 경기는 오늘(종료일) 미션을 민다.</b> 설계 §6.1 이 이름 붙여 경계한 버그 —
     * 23:58 에 시작해 00:03 에 끝난 경기가 어제 미션을 채우면, 유저는 오늘 화면에서 그 판이 사라진 걸 본다.
     *
     * <p>이 계약의 요점은 <b>서비스가 아니라 호출부</b>다: {@code finishedAt} 을 직접 넘기지 않고
     * 실제 경기 흐름이 정하게 둔다. 그래서 {@code finishMatch} 가 {@code match.createdAt()} 을 넘기는
     * 변이가 여기서 죽는다(그 변이는 기존 미션 계약 55건을 전부 통과했다).
     */
    @Test
    void aMatchThatCrossesMidnightFeedsTheDayItFinishedNotTheDayItStarted() {
        setupOpponentWithDeck("mfh_def1");
        String attacker = setupUserWithDeck("mfh_atk1");
        String attackerId = userIdOf("mfh_atk1");

        NOW.set(BEFORE_MIDNIGHT);
        String matchId = startAwayPinned(attackerId, userIdOf("mfh_def1"));
        // 표본이 실제로 경계에 걸쳐 있는지 먼저 확인한다 — 아니면 이 계약은 공허하다.
        assertThat(Instant.parse(createdAtOf(matchId)).atZone(KST).toLocalDate())
                .as("매치는 08-02 에 만들어졌다").hasToString("2026-08-02");

        NOW.set(AFTER_MIDNIGHT);
        driveToFinished(attacker, matchId);

        assertThat(daysProgressedBy(matchId))
                .as("훅이 넘긴 시각이 종료 시각이면 종료일(08-03) 미션만 밀린다")
                .containsExactly("2026-08-03");
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_missions WHERE user_id = ? AND day = ?")
                .params(attackerId, "2026-08-02").query(Long.class).single())
                .as("생성일 미션은 만들어지지도 않는다 — 그날 유저는 미션 화면을 연 적이 없다")
                .isZero();
        assertThat(jdbcClient.sql("""
                        SELECT COALESCE(SUM(progress), 0) FROM daily_missions
                         WHERE user_id = ? AND day = '2026-08-03'
                        """).params(attackerId).query(Long.class).single())
                .as("종료일 미션이 실제로 밀렸다(훅 자체가 살아 있다)").isPositive();
    }

    // ── minor-2: 훅이 넘기는 사이드 = **유저 팀** ────────────────────────

    /**
     * <b>선제골 판정이 전 경로에서 우리 팀 기준이다.</b> {@code MissionDailyTest} 는 사이드를 서비스에
     * 직접 넘기므로, 호출부에서 {@code !userHome} 로 뒤집는 변이가 미션 계약 전부를 통과했다.
     *
     * <p>표본의 전제(픽스처 첫 골이 home · 원정은 유저가 home)를 <b>DB 에서 읽어 같이 단정</b>한다 —
     * 나중에 픽스처가 바뀌면 계약이 조용히 항진명제가 되는 대신 여기서 깨진다.
     */
    @Test
    void firstGoalIsJudgedFromTheUsersSideAllTheWayThroughTheFinishHook() {
        setupOpponentWithDeck("mfh_def2");
        String attacker = setupUserWithDeck("mfh_atk2");
        String attackerId = userIdOf("mfh_atk2");

        NOW.set(MIDDAY);
        String firstGoal = seed(attackerId, "2026-08-02", 1, "away_first_goal");
        seed(attackerId, "2026-08-02", 2, "away_play_3");

        String matchId = startAwayPinned(attackerId, userIdOf("mfh_def2"));
        driveToFinished(attacker, matchId);

        // 표본 전제 ①: 이 경기의 첫 goal 이벤트는 home 팀이 넣었다.
        String log = jdbcClient.sql(
                        "SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = 1")
                .param(matchId).query(String.class).single();
        assertThat(firstGoalTeam(log)).as("픽스처 전제 — 첫 골은 home").isEqualTo("home");
        // 표본 전제 ②: 원정 매치는 유저가 엔진 관점의 home 이다(리그 어웨이 라운드와 다르다).
        assertThat(jdbcClient.sql("SELECT league_fixture_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).optional())
                .as("원정은 리그 픽스처가 없으므로 userIsHome=true 경로다").isEmpty();

        assertThat(progressOf(firstGoal))
                .as("우리 팀이 선제골을 넣었다 — 사이드를 뒤집으면 0 이 된다")
                .isEqualTo(1);
    }

    /** 저장된 매치로그에서 첫 goal 이벤트의 팀. 목이 아니라 <b>실제로 저장된 로그</b>를 읽는다. */
    private String firstGoalTeam(String logJson) {
        try {
            var root = MAPPER.readTree(logJson);
            for (var event : root.path("events")) {
                if ("goal".equals(event.path("type").asText())) {
                    return event.path("team").asText();
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException("매치로그 파싱 실패", e);
        }
        return null;
    }
}
