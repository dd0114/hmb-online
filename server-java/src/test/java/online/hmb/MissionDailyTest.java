package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import online.hmb.catalog.EconomyService;
import online.hmb.common.Ulid;
import online.hmb.mission.MissionProperties;
import online.hmb.mission.MissionRule;
import online.hmb.mission.MissionService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 원정 데일리 미션 계약 (#408, hero 확정 2026-08-02 — {@code docs/plan-v5/away-daily-mission.md}).
 *
 * <p><b>금액은 픽스처 economy 로 검증한다</b>(발행물 100/200/300 이 아니라 <b>11/22/33</b>).
 * 같은 값을 쓰면 "config 를 무시하고 상수를 쓰는" 변이체가 전 스위트를 통과한다 — #251/#368 독립검증
 * MAJOR-1 이 실제로 그 상태였다. 발행값이 hero 확정과 같은지는
 * {@link #publishedEconomyCarriesHeroConfirmedMissionRewards} 가 <b>따로</b> 본다.
 *
 * <p><b>추첨은 유저 id(ULID) 시드라 실행마다 다른 미션이 나온다.</b> 그래서 규칙별 계약은 미션을
 * <b>지정해 심고</b> 판정만 태운다 — "어떤 미션이 나왔는지 봐서 그때그때 다르게 단언"하면 표본이
 * 우연에 좌우돼 변이체가 살아남는다(#251 이 순위 경계에서 겪은 형태).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MissionDailyTest extends MatchTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    /** KST 2026-08-02 12:00. */
    private static final Instant MIDDAY = Instant.parse("2026-08-02T03:00:00Z");
    /** KST 2026-08-02 23:59 — 자정 1분 전. UTC 로는 08-02. */
    private static final Instant BEFORE_MIDNIGHT = Instant.parse("2026-08-02T14:59:00Z");
    /**
     * KST 2026-08-03 00:30 — 자정 통과. <b>UTC 로는 여전히 08-02</b> 라, 존을 무시한 구현은 위와
     * 같은 날로 읽는다(이 표본이 곧 UTC-자정 변이체를 죽이는 장치다).
     */
    private static final Instant AFTER_MIDNIGHT = Instant.parse("2026-08-02T15:30:00Z");

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

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
    }

    @Resource
    private MissionService missionService;

    @Resource
    private MissionProperties missionProps;

    @Resource
    private EconomyService economyService;

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private String user(String nickname) {
        login(nickname);
        return userIdOf(nickname);
    }

    private MissionProperties.Entry entry(String missionId) {
        return missionProps.getCatalog().stream()
                .filter(e -> missionId.equals(e.getId()))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("카탈로그에 없는 미션: " + missionId));
    }

    /**
     * 지정한 미션을 그 슬롯에 심는다 — 규칙별 판정을 <b>추첨 운과 분리</b>하기 위한 장치.
     * 금액은 프로덕션과 같은 경로({@code economyService})로 채워, 이 헬퍼가 config 를 우회하지 않는다.
     */
    private String seed(String userId, String day, int slotNo, String missionId) {
        MissionProperties.Entry e = entry(missionId);
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO daily_missions(id, user_id, day, slot_no, mission_id, title, tier,
                                rule, currency, amount, target, progress, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'GEM', ?, ?, 0, ?)
                        """)
                .params(id, userId, day, slotNo, e.getId(), e.getTitle(), e.getTier(),
                        e.getRule().name(),
                        economyService.dailyMissionReward().amountFor(e.getTier()), e.getTarget(),
                        NOW.get().toString())
                .update();
        return id;
    }

    /** 슬롯 2를 아무 미션으로 채워 lazy 생성이 끼어들지 않게 한다(주제와 무관한 축 제거). */
    private void fillOtherSlot(String userId, String day, String missionId) {
        seed(userId, day, 2, missionId);
    }

    private int progressOf(String missionRowId) {
        return jdbcClient.sql("SELECT progress FROM daily_missions WHERE id = ?")
                .param(missionRowId).query(Integer.class).single();
    }

    private String completedAtOf(String missionRowId) {
        return jdbcClient.sql("SELECT completed_at FROM daily_missions WHERE id = ?")
                .param(missionRowId).query(String.class).optional().orElse(null);
    }

    /** 원정 한 판을 정산시킨다(엔진·HTTP 없이 판정만). 매치 id 는 매번 새로 — 멱등 축이 match 다. */
    private void play(String userId, String result, int userGoals, int oppGoals) {
        missionService.settle(Ulid.next(), userId, result, userGoals, oppGoals, true, NOW.get());
    }

    private long gems(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    private long missionLedgerRows(String userId) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM gem_ledger WHERE user_id = ? AND reason = 'daily_mission'")
                .param(userId).query(Long.class).single();
    }

    // ── 카탈로그 · 추첨 ──────────────────────────────────────────────────

    /**
     * 카탈로그가 hero 확정 풀(§4)과 <b>글자 그대로</b> 같은가. 문구는 hero 산출물이라 임의 수정 금지다 —
     * 여기서 박아 두지 않으면 다음 사람이 "다듬는다"며 조용히 바꾸고, 그건 게임 내용 변경이다.
     */
    @Test
    void catalogIsTheHeroConfirmedPoolOfFourteen() {
        List<MissionProperties.Entry> pool = missionProps.getCatalog();
        assertThat(pool).hasSize(14);
        assertThat(pool.stream().map(MissionProperties.Entry::getId))
                .containsExactly("away_play_1", "away_win_1", "away_goals_2", "away_first_goal",
                        "away_play_2", "away_win_2", "away_streak_2", "away_goals_3", "away_clean_win",
                        "away_play_3", "away_win_3", "away_streak_3", "away_margin_3", "away_goals_4");
        assertThat(pool.stream().filter(e -> "EASY".equals(e.getTier())).count()).isEqualTo(5);
        assertThat(pool.stream().filter(e -> "NORMAL".equals(e.getTier())).count()).isEqualTo(5);
        assertThat(pool.stream().filter(e -> "HARD".equals(e.getTier())).count()).isEqualTo(4);

        assertThat(entry("away_streak_2").getTitle()).isEqualTo("원정 2연승");
        assertThat(entry("away_streak_2").getRule()).isEqualTo(MissionRule.WIN_STREAK);
        assertThat(entry("away_streak_2").getTarget()).isEqualTo(2);
        assertThat(entry("away_margin_3").getTitle()).isEqualTo("3골차 이상으로 승리");
        assertThat(entry("away_first_goal").getTitle()).isEqualTo("원정 경기에서 선제골을 넣는다");
        // §4 "풀에서 뺀 것" — 개인 득점·어시스트·무승부는 근거를 뒤집기 전엔 들어오지 않는다.
        assertThat(pool.stream().map(MissionProperties.Entry::getId))
                .noneMatch(id -> id.contains("assist") || id.contains("hattrick") || id.contains("draw"));
    }

    /**
     * 하루 2개는 <b>서로 다른</b> 미션이고, 추첨은 14종 <b>전체</b>를 덮는다.
     *
     * <p>커버리지를 보는 이유: "항상 첫 두 개를 준다" 같은 변이체는 중복 금지 계약만으로는 살아남고,
     * 그러면 풀의 일부가 영영 안 나오는데 아무도 모른다(설계 §8 계약표의 "풀 일부가 영영 안 나오는 변이").
     */
    @Test
    void twoDailyMissionsAreDistinctAndTheDrawCoversTheWholePool() {
        NOW.set(MIDDAY);
        Set<String> seen = new LinkedHashSet<>();
        for (int i = 0; i < 80; i++) {
            String uid = user("mis_draw_" + i);
            List<MissionService.MissionView> missions = missionService.daily(uid).missions();
            assertThat(missions).hasSize(2);
            assertThat(missions.get(0).missionId()).isNotEqualTo(missions.get(1).missionId());
            missions.forEach(m -> seen.add(m.missionId()));
        }
        assertThat(seen)
                .as("14종 전부가 추첨에 등장해야 한다 — 안 나오는 미션은 없는 미션이다")
                .hasSize(14);
    }

    /** 추첨은 시드 결정론 — 같은 유저·같은 날이면 몇 번을 조회해도 같은 두 미션이다(재생성 금지). */
    @Test
    void theDrawIsSeedDeterministicSoRepeatedReadsNeverReshuffle() {
        NOW.set(MIDDAY);
        String uid = user("mis_stable");
        List<MissionService.MissionView> first = missionService.daily(uid).missions();
        List<MissionService.MissionView> second = missionService.daily(uid).missions();
        assertThat(second.stream().map(MissionService.MissionView::id).toList())
                .isEqualTo(first.stream().map(MissionService.MissionView::id).toList());
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_missions WHERE user_id = ?")
                .param(uid).query(Long.class).single()).isEqualTo(2L);
    }

    // ── 날짜 경계 ────────────────────────────────────────────────────────

    /**
     * 하루 경계는 <b>KST 자정</b>이다. UTC 자정으로 자르는 구현은 {@link #AFTER_MIDNIGHT}(UTC 로는
     * 아직 같은 날)에서 어제 미션을 계속 준다 — 이 리포가 두 번 당한 부류(#245).
     */
    @Test
    void dayBoundaryIsKstMidnightNotUtcMidnight() {
        String uid = user("mis_kst");

        NOW.set(BEFORE_MIDNIGHT);
        MissionService.DailyView before = missionService.daily(uid);
        assertThat(before.day()).isEqualTo("2026-08-02");
        Set<String> yesterday = new HashSet<>(before.missions().stream()
                .map(MissionService.MissionView::id).toList());

        NOW.set(AFTER_MIDNIGHT);
        MissionService.DailyView after = missionService.daily(uid);
        assertThat(after.day()).isEqualTo("2026-08-03");
        assertThat(after.missions().stream().map(MissionService.MissionView::id))
                .as("자정을 넘으면 어제 행이 아니라 새 날짜의 행이다")
                .doesNotContainAnyElementsOf(yesterday);
        assertThat(after.resetAtKst()).isEqualTo("2026-08-04T00:00:00+09:00");
    }

    /** 정산의 날짜 앵커는 <b>종료 시각</b>이다 — 자정을 넘겨 끝난 판은 <b>오늘</b> 미션을 민다(§6.1). */
    @Test
    void progressAnchorsToTheFinishTimeNotTheDayTheMatchStarted() {
        String uid = user("mis_anchor");
        NOW.set(BEFORE_MIDNIGHT);
        String yesterdaysMission = seed(uid, "2026-08-02", 1, "away_play_3");
        fillOtherSlot(uid, "2026-08-02", "away_win_3");

        NOW.set(AFTER_MIDNIGHT);   // 23:58 에 시작해 00:03 에 끝난 판
        missionService.settle(Ulid.next(), uid, "WIN", 1, 0, true, NOW.get());

        assertThat(progressOf(yesterdaysMission))
                .as("어제 미션은 움직이지 않는다 — 유저의 오늘 화면에 없는 미션이다").isZero();
        assertThat(jdbcClient.sql("""
                        SELECT COALESCE(SUM(progress), 0) FROM daily_missions
                         WHERE user_id = ? AND day = '2026-08-03'
                        """).param(uid).query(Long.class).single())
                .as("오늘 미션이 대신 밀렸다").isPositive();
    }

    /**
     * <b>{@code finishedAt} 파라미터가 권위다 — 주변 시계가 아니라.</b>
     *
     * <p>{@link MissionFinishHookWiringTest} 가 "호출자가 <b>종료 시각</b>을 넘긴다"를 지키고, 이건
     * "서비스가 <b>넘겨받은 값</b>을 쓴다"를 지킨다. 둘이 붙어야 §6.1 의 날짜 앵커가 완전히 박힌다.
     *
     * <p>⚠️ 이 계약이 없으면 {@code dateOf(finishedAt)} → {@code today()} 변이가 <b>아무 테스트도
     * 죽이지 않는다</b>(독립검증 minor-3) — 유일 호출자가 {@code now()} 를 넘기니 값이 같아서다.
     * 그 상태에선 <b>파라미터가 장식</b>이고, 나중에 재정산 도구·백필처럼 "지금"이 아닌 시각으로
     * 부르는 두 번째 호출자가 생기는 순간 조용히 오늘 미션을 민다.
     */
    @Test
    void settleAnchorsToTheGivenFinishTimeNotToWhateverTimeItIsNow() {
        String uid = user("mis_param");
        NOW.set(BEFORE_MIDNIGHT);
        String yesterday = seed(uid, "2026-08-02", 1, "away_play_3");
        fillOtherSlot(uid, "2026-08-02", "away_win_3");

        // 시계는 이미 다음 날인데, **08-02 에 끝난 경기**를 지금 정산한다.
        NOW.set(AFTER_MIDNIGHT);
        missionService.settle(Ulid.next(), uid, "WIN", 1, 0, true, BEFORE_MIDNIGHT);

        assertThat(progressOf(yesterday)).as("넘겨받은 종료일(08-02) 미션이 밀린다").isEqualTo(1);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_missions WHERE user_id = ? AND day = ?")
                .params(uid, "2026-08-03").query(Long.class).single())
                .as("'지금'(08-03) 미션은 만들어지지도 않는다 — 그 경기는 어제 것이다").isZero();
    }

    // ── 규칙별 판정 ──────────────────────────────────────────────────────

    /** 출전형은 승패와 무관하게 센다(패배도 "치른 경기"다). */
    @Test
    void playCountsEveryFinishedAwayMatchIncludingLosses() {
        String uid = user("mis_play");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_3");
        fillOtherSlot(uid, "2026-08-02", "away_win_3");

        play(uid, "LOSS", 0, 2);
        play(uid, "DRAW", 1, 1);
        assertThat(progressOf(m)).isEqualTo(2);
        assertThat(completedAtOf(m)).isNull();
        play(uid, "WIN", 3, 0);
        assertThat(progressOf(m)).isEqualTo(3);
        assertThat(completedAtOf(m)).as("목표에 닿으면 그 자리에서 달성 시각이 찍힌다").isNotNull();
    }

    /** 승수형은 승리만 센다. */
    @Test
    void winCountsOnlyWins() {
        String uid = user("mis_win");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_win_2");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        play(uid, "LOSS", 0, 1);
        play(uid, "DRAW", 1, 1);
        assertThat(progressOf(m)).isZero();
        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 2, 1);
        assertThat(progressOf(m)).isEqualTo(2);
    }

    /**
     * 연승은 <b>패배로 끊기고 무승부로는 안 끊긴다</b>. 무승부 유지는 {@code AwayService} 통산 연승
     * (hero E4)과 같은 규칙이다 — 두 화면이 다른 "연승"을 말하면 유저는 어느 쪽도 믿지 않는다.
     *
     * <p>하루 경계는 미션 행이 day 로 잘려 있어 자동으로 성립한다({@code away_streaks} 는 통산이라
     * 그대로 쓸 수 없다 — 어제 2연승이 오늘 미션을 시작부터 채우면 안 된다).
     */
    @Test
    void winStreakBreaksOnLossSurvivesADrawAndDoesNotInheritYesterday() {
        String uid = user("mis_streak");
        NOW.set(BEFORE_MIDNIGHT);
        String yesterday = seed(uid, "2026-08-02", 1, "away_streak_3");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 1, 0);
        assertThat(progressOf(yesterday)).isEqualTo(2);

        NOW.set(AFTER_MIDNIGHT);
        String today = seed(uid, "2026-08-03", 1, "away_streak_3");
        fillOtherSlot(uid, "2026-08-03", "away_play_3");
        assertThat(progressOf(today)).as("어제 2연승이 오늘로 넘어오지 않는다").isZero();

        play(uid, "WIN", 1, 0);
        play(uid, "DRAW", 1, 1);
        assertThat(progressOf(today)).as("무승부는 연승을 유지한다").isEqualTo(1);
        play(uid, "WIN", 2, 0);
        assertThat(progressOf(today)).isEqualTo(2);
        play(uid, "LOSS", 0, 1);
        assertThat(progressOf(today)).as("패배는 0 으로 끊는다").isZero();
        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 1, 0);
        assertThat(progressOf(today)).isEqualTo(3);
        assertThat(completedAtOf(today)).isNotNull();
    }

    /** "한 경기에서 N골"은 <b>합계가 아니라 최고값</b>이다 — 1골 경기 3판으로 3골 미션이 깨지면 안 된다. */
    @Test
    void goalsInAMatchTakesTheBestSingleMatchNotTheSum() {
        String uid = user("mis_goals");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_goals_3");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 1, 0);
        assertThat(progressOf(m)).as("합계가 아니다").isEqualTo(1);
        play(uid, "LOSS", 2, 3);
        assertThat(progressOf(m)).as("진 경기의 득점도 '한 경기 N골'이다").isEqualTo(2);
        play(uid, "WIN", 3, 1);
        assertThat(completedAtOf(m)).isNotNull();
    }

    /** 무실점 승리는 <b>둘 다</b> 필요하다 — 무실점 무승부도, 실점한 승리도 아니다. */
    @Test
    void cleanWinNeedsBothAWinAndAShutout() {
        String uid = user("mis_clean");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_clean_win");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        play(uid, "DRAW", 0, 0);
        play(uid, "WIN", 3, 1);
        assertThat(progressOf(m)).isZero();
        play(uid, "WIN", 1, 0);
        assertThat(progressOf(m)).isEqualTo(1);
        assertThat(completedAtOf(m)).isNotNull();
    }

    /** 골 차는 <b>이긴 경기</b>에서만, 그리고 최고값으로 잰다. */
    @Test
    void winMarginTakesTheBestWinningMarginAndIgnoresDefeats() {
        String uid = user("mis_margin");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_margin_3");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        play(uid, "LOSS", 0, 5);
        assertThat(progressOf(m)).as("5골차로 진 것은 골 차 미션이 아니다").isZero();
        play(uid, "WIN", 2, 0);
        assertThat(progressOf(m)).isEqualTo(2);
        play(uid, "WIN", 1, 0);
        assertThat(progressOf(m)).as("최고값이라 내려가지 않는다").isEqualTo(2);
        play(uid, "WIN", 4, 1);
        assertThat(progressOf(m)).isEqualTo(3);
        assertThat(completedAtOf(m)).isNotNull();
    }

    /**
     * 선제골은 <b>매치로그의 첫 goal 이벤트</b>가 우리 팀일 때만. 유저가 away 사이드인 경기에서
     * 사이드를 안 보는 구현은 상대 선제골을 우리 것으로 센다.
     */
    @Test
    void firstGoalCountsOnlyWhenOurSideScoredFirst() {
        String uid = user("mis_first");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_first_goal");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        // 상대가 먼저 넣은 경기 — 우리(home)는 선제골이 아니다.
        String lostFirst = matchWithGoals(uid, List.of("away", "home"));
        missionService.settle(lostFirst, uid, "DRAW", 1, 1, true, NOW.get());
        assertThat(progressOf(m)).isZero();

        // 같은 로그라도 유저가 away 사이드면 선제골이다(사이드를 무시하는 구현이 여기서 죽는다).
        String asAway = matchWithGoals(uid, List.of("away", "home"));
        missionService.settle(asAway, uid, "DRAW", 1, 1, false, NOW.get());
        assertThat(progressOf(m)).isEqualTo(1);
        assertThat(completedAtOf(m)).isNotNull();
    }

    /** 골이 하나도 없으면 선제골은 없다(0:0 은 "선제골 없음"이지 우리 것이 아니다). */
    @Test
    void aGoallessMatchHasNoFirstGoal() {
        String uid = user("mis_first_none");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_first_goal");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        String goalless = matchWithGoals(uid, List.of());
        missionService.settle(goalless, uid, "DRAW", 0, 0, true, NOW.get());
        assertThat(progressOf(m)).isZero();
    }

    /** 골 이벤트 순서를 지정한 매치 + 전반 로그를 심는다(엔진·HTTP 없이 파싱 경로만 태운다). */
    private String matchWithGoals(String userId, List<String> goalTeams) {
        String matchId = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', '0.9.0', '{}', 'away', 'DRAW', ?)
                        """)
                .params(matchId, userId, NOW.get().toString())
                .update();
        List<String> events = new ArrayList<>();
        events.add("{\"tick\":0,\"type\":\"kickoff\",\"team\":\"home\"}");
        int tick = 10;
        for (String team : goalTeams) {
            events.add("{\"tick\":" + tick + ",\"type\":\"goal\",\"team\":\"" + team + "\"}");
            tick += 10;
        }
        String log = "{\"events\":[" + String.join(",", events) + "]}";
        jdbcClient.sql("""
                        INSERT INTO match_halves(match_id, half, select_data_json, home_input_json,
                                away_input_json, half_seed, match_log_json, last_hash)
                        VALUES (?, 1, '{}', '{}', '{}', 's', ?, 'h')
                        """)
                .params(matchId, log)
                .update();
        return matchId;
    }

    /** 달성한 뒤에는 진행도가 얼어붙는다 — 나중 패배가 연승 미션을 0 으로 되돌리면 보상이 사라진다. */
    @Test
    void progressFreezesOnceTheMissionIsCompleted() {
        String uid = user("mis_freeze");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_streak_2");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");

        play(uid, "WIN", 1, 0);
        play(uid, "WIN", 1, 0);
        String completedAt = completedAtOf(m);
        assertThat(completedAt).isNotNull();

        // 결과 화면 응답까지 본다 — DB 는 `completed_at IS NULL` 가드가 지키지만, 응답을 만드는
        // 쪽이 새 값을 계산해 실으면 "달성한 미션이 결과 화면에서 0/2 로 보이는" 상태가 된다
        // (그 변이체는 DB 단정만으로는 살아남는다 — 실측).
        List<MissionService.MatchMissionView> reported =
                missionService.settle(Ulid.next(), uid, "LOSS", 0, 3, true, NOW.get());
        assertThat(reported).filteredOn(v -> v.id().equals(m))
                .singleElement()
                .satisfies(v -> {
                    assertThat(v.progress()).isEqualTo(2);
                    assertThat(v.completedNow()).isFalse();
                });
        assertThat(progressOf(m)).isEqualTo(2);
        assertThat(completedAtOf(m)).isEqualTo(completedAt);
    }

    /**
     * 같은 매치를 다시 정산해도 진행도가 두 번 오르지 않는다. 재정산은 스위퍼 경합·재진입으로 실제로
     * 일어나고, 여기서 새면 "출전 3회"가 한 판으로 끝난다.
     */
    @Test
    void settleIsIdempotentAcrossReentry() {
        String uid = user("mis_idem");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_3");
        fillOtherSlot(uid, "2026-08-02", "away_win_3");

        String matchId = Ulid.next();
        missionService.settle(matchId, uid, "WIN", 2, 0, true, NOW.get());
        missionService.settle(matchId, uid, "WIN", 2, 0, true, NOW.get());
        missionService.settle(matchId, uid, "WIN", 2, 0, true, NOW.get());

        assertThat(progressOf(m)).isEqualTo(1);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_mission_progress WHERE match_id = ?")
                .param(matchId).query(Long.class).single()).isEqualTo(2L);
    }

    /** 미션이 없는 유저의 첫 경기도 진행도를 얻는다 — 조회 전에 정산이 와도 그날 미션이 생긴다(§6.4 확장). */
    @Test
    void aMatchThatFinishesBeforeTheFirstScreenOpenStillCounts() {
        String uid = user("mis_lazy");
        NOW.set(MIDDAY);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM daily_missions WHERE user_id = ?")
                .param(uid).query(Long.class).single()).isZero();

        play(uid, "WIN", 2, 0);

        MissionService.DailyView view = missionService.daily(uid);
        assertThat(view.missions()).hasSize(2);
        assertThat(view.missions().stream().mapToInt(MissionService.MissionView::progress).sum())
                .as("앱을 안 켜고 원정만 친 유저의 진행도가 사라지면 안 된다").isPositive();
    }

    // ── 금액 · 박제 ──────────────────────────────────────────────────────

    /**
     * 금액이 <b>economy config</b> 에서 오는가. 픽스처는 발행값(100/200/300)과 <b>일부러 다른</b>
     * 11/22/33 이라, 상수를 박은 변이체는 여기서 죽는다(#251 MAJOR-1 이 못 잡았던 형태).
     */
    @Test
    void tierAmountsComeFromEconomyConfigNotConstants() {
        NOW.set(MIDDAY);
        // ⚠️ **생성 경로(추첨 → insert)를 그대로 태운다.** 미션을 심어 두고 재는 초판은 헬퍼가
        // 금액을 채워서, 생성 지점을 상수 100/200/300 으로 바꾼 변이체가 살아남았다(실측).
        // 픽스처는 발행값과 일부러 다른 11/22/33 이라 상수를 박는 순간 여기서 죽는다.
        java.util.Map<String, Integer> fixtureAmount =
                java.util.Map.of("EASY", 11, "NORMAL", 22, "HARD", 33);
        Set<String> tiersObserved = new LinkedHashSet<>();
        for (int i = 0; i < 40; i++) {
            String uid = user("mis_amount_" + i);
            for (MissionService.MissionView m : missionService.daily(uid).missions()) {
                assertThat(m.amount()).as("%s(%s)", m.missionId(), m.tier())
                        .isEqualTo(fixtureAmount.get(m.tier()));
                assertThat(m.currency()).isEqualTo("GEM");
                tiersObserved.add(m.tier());
            }
        }
        assertThat(tiersObserved)
                .as("세 티어가 전부 관측돼야 '티어별로 config 를 읽는다'가 검증된다")
                .containsExactlyInAnyOrder("EASY", "NORMAL", "HARD");
    }

    /**
     * 금액은 <b>행에 박제</b>되고, 지급은 그 행을 읽는다 — economy 를 돌려도 이미 발급된 미션의
     * 보상이 소급 변조되지 않는다. 행의 금액을 직접 바꿔 두고 지급액이 <b>그 값</b>인지 본다
     * (지급 시점에 config 를 다시 읽는 구현이 여기서 죽는다).
     */
    @Test
    void payoutReadsTheStampedAmountNotTheCurrentKnob() {
        String uid = user("mis_stamped");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_1");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        jdbcClient.sql("UPDATE daily_missions SET amount = 777 WHERE id = ?").param(m).update();

        play(uid, "WIN", 1, 0);
        long before = gems(uid);
        MissionService.ClaimResult claimed = missionService.claim(uid, m);

        assertThat(claimed.claimed().amount()).isEqualTo(777);
        assertThat(claimed.claimed().currency()).isEqualTo("GEM");
        assertThat(gems(uid)).isEqualTo(before + 777);
        assertThat(claimed.wallet().gems()).isEqualTo(before + 777);
    }

    // ── 수령 ────────────────────────────────────────────────────────────

    /** 수령은 지갑·원장·상태를 한 번에 움직이고, <b>두 번째 수령은 지갑을 건드리지 않는다</b>. */
    @Test
    void claimPaysOnceAndTheSecondClaimIsRejectedWithoutTouchingTheWallet() {
        String uid = user("mis_claim");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_1");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        play(uid, "WIN", 1, 0);

        long before = gems(uid);
        missionService.claim(uid, m);
        assertThat(gems(uid)).isEqualTo(before + 11);
        assertThat(missionLedgerRows(uid)).isEqualTo(1L);
        assertThat(missionService.daily(uid).missions().stream()
                .filter(v -> v.id().equals(m)).findFirst().orElseThrow().state()).isEqualTo("CLAIMED");

        assertThatApi(() -> missionService.claim(uid, m))
                .hasStatus(HttpStatus.CONFLICT).hasCode("MISSION_ALREADY_CLAIMED");
        assertThat(gems(uid)).isEqualTo(before + 11);
        assertThat(missionLedgerRows(uid)).isEqualTo(1L);
    }

    /** 미달성 수령은 409 — 그리고 아무것도 지급되지 않는다. */
    @Test
    void claimingAnUnfinishedMissionIsRejected() {
        String uid = user("mis_early");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_3");
        fillOtherSlot(uid, "2026-08-02", "away_win_3");
        play(uid, "WIN", 1, 0);

        long before = gems(uid);
        assertThatApi(() -> missionService.claim(uid, m))
                .hasStatus(HttpStatus.CONFLICT).hasCode("MISSION_NOT_COMPLETED");
        assertThat(gems(uid)).isEqualTo(before);
        assertThat(missionLedgerRows(uid)).isZero();
    }

    /** 남의 미션은 <b>없는 미션과 같은 404</b> — 갈라 두면 id 실재가 새어 나간다. */
    @Test
    void anotherUsersMissionIsIndistinguishableFromAbsent() {
        String owner = user("mis_owner");
        String other = user("mis_other");
        NOW.set(MIDDAY);
        String m = seed(owner, "2026-08-02", 1, "away_play_1");
        fillOtherSlot(owner, "2026-08-02", "away_play_3");
        play(owner, "WIN", 1, 0);

        assertThatApi(() -> missionService.claim(other, m)).hasStatus(HttpStatus.NOT_FOUND);
        assertThatApi(() -> missionService.claim(other, Ulid.next())).hasStatus(HttpStatus.NOT_FOUND);
        assertThat(missionLedgerRows(other)).isZero();
    }

    /**
     * §6.3 — <b>달성했는데 안 받은 보상은 기한 없이 남는다.</b> 미션은 자정에 교체되지만 그 행의
     * 보상은 다음 날에도 받을 수 있고, 홈의 "받을 보상 N건"은 지난 날짜 미수령분을 <b>합산</b>한다.
     */
    @Test
    void completedRewardsSurviveTheDayBoundaryAndShowUpInTheClaimableSummary() {
        String uid = user("mis_carry");
        NOW.set(BEFORE_MIDNIGHT);
        String m = seed(uid, "2026-08-02", 1, "away_play_1");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        play(uid, "WIN", 1, 0);

        NOW.set(AFTER_MIDNIGHT);
        MissionService.DailyView today = missionService.daily(uid);
        assertThat(today.day()).isEqualTo("2026-08-03");
        assertThat(today.missions().stream().map(MissionService.MissionView::id)).doesNotContain(m);
        assertThat(today.claimableCount()).as("어제 미수령분이 홈 한 줄에 잡힌다").isEqualTo(1);
        assertThat(today.claimableAmount()).isEqualTo(11);

        long before = gems(uid);
        assertThat(missionService.claim(uid, m).claimed().amount()).isEqualTo(11);
        assertThat(gems(uid)).isEqualTo(before + 11);
        assertThat(missionService.daily(uid).claimableCount()).isZero();
    }

    // ── 지난 날짜의 미수령분 (pendingClaims) ─────────────────────────────

    /** 지난 날짜의 달성·미수령 행을 심는다(그날 미션은 이미 교체됐지만 보상은 남는다, §6.3). */
    private String seedCompletedOn(String userId, String day, int slotNo, String missionId) {
        String id = seed(userId, day, slotNo, missionId);
        jdbcClient.sql("UPDATE daily_missions SET progress = target, completed_at = ? WHERE id = ?")
                .params(day + "T12:00:00Z", id)
                .update();
        return id;
    }

    /**
     * <b>홈이 "받을 보상 1건"이라고 말하면 화면에 그 카드가 있어야 한다.</b>
     *
     * <p>합계({@code claimableCount})만 전 기간이고 목록({@code missions})은 오늘 것뿐이면,
     * 어제 달성하고 안 받은 유저는 홈에서 1건을 보는데 원정 화면엔 받을 카드가 없다 —
     * §6.3(달성분은 기한 없이 남는다)이 <b>화면에서 도달 불가능</b>해진다. 그 반대 방향 버그도 같다.
     */
    @Test
    void pendingClaimsCarriesPastDaysUnclaimedRewardsSoTheyStayReachable() {
        String uid = user("mis_pending");
        NOW.set(MIDDAY);
        String yesterday = seedCompletedOn(uid, "2026-08-01", 1, "away_win_2");

        MissionService.DailyView view = missionService.daily(uid);
        assertThat(view.pendingClaims()).singleElement().satisfies(p -> {
            assertThat(p.id()).isEqualTo(yesterday);
            assertThat(p.day()).isEqualTo("2026-08-01");
            assertThat(p.missionId()).isEqualTo("away_win_2");
            assertThat(p.title()).isEqualTo("원정에서 2승");
            assertThat(p.tier()).isEqualTo("NORMAL");
            assertThat(p.currency()).isEqualTo("GEM");
            assertThat(p.amount()).isEqualTo(22);   // 픽스처 NORMAL
        });

        // **수령은 오늘 것과 같은 엔드포인트**다 — claim 은 날짜를 보지 않는다.
        long before = gems(uid);
        assertThat(missionService.claim(uid, yesterday).claimed().amount()).isEqualTo(22);
        assertThat(gems(uid)).isEqualTo(before + 22);
        assertThat(missionService.daily(uid).pendingClaims()).isEmpty();
    }

    /**
     * ⚠️ <b>오늘 것은 {@code pendingClaims} 에 들어가지 않는다</b> — 이미 {@code missions} 에
     * {@code state=COMPLETED} 로 있다. 중복으로 실으면 화면이 같은 보상을 두 장 그리고,
     * 유저는 하나를 받은 뒤 나머지 한 장이 409 를 뱉는 걸 본다.
     */
    @Test
    void todaysCompletedMissionLivesInMissionsOnlyAndIsNeverDuplicatedIntoPendingClaims() {
        String uid = user("mis_pending_dup");
        NOW.set(MIDDAY);
        String today = seed(uid, "2026-08-02", 1, "away_play_1");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        String yesterday = seedCompletedOn(uid, "2026-08-01", 1, "away_win_2");
        play(uid, "WIN", 1, 0);   // 오늘 것을 달성시킨다

        MissionService.DailyView view = missionService.daily(uid);
        assertThat(view.missions()).filteredOn(m -> m.id().equals(today))
                .singleElement()
                .satisfies(m -> assertThat(m.state()).isEqualTo("COMPLETED"));
        assertThat(view.pendingClaims().stream().map(MissionService.PendingClaim::id))
                .as("오늘 것은 missions 에 있다 — 여기 또 실으면 같은 보상이 두 장 그려진다")
                .containsExactly(yesterday);
    }

    /**
     * <b>합계와 목록이 어긋나지 않는다</b>: {@code claimableCount/Amount}
     * = {@code missions} 의 COMPLETED(미수령) + {@code pendingClaims} 전부.
     *
     * <p>관계식으로 걸어야 한다 — 숫자만 단정하면 "합계는 전 기간, 목록은 오늘"이라는 <b>원래의 갭</b>이
     * 그대로 통과한다. 표본에 <b>어제 행</b>이 반드시 있어야 관계가 공허하지 않다.
     */
    @Test
    void claimableTotalsAlwaysMatchWhatTheScreenCanActuallyShow() {
        String uid = user("mis_cl_rel");
        NOW.set(MIDDAY);
        String today = seed(uid, "2026-08-02", 1, "away_play_1");     // EASY 11
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        seedCompletedOn(uid, "2026-08-01", 1, "away_win_2");          // NORMAL 22
        seedCompletedOn(uid, "2026-07-31", 1, "away_margin_3");       // HARD 33
        play(uid, "WIN", 1, 0);                                       // 오늘 것 달성

        MissionService.DailyView view = missionService.daily(uid);
        long shownCount = view.missions().stream().filter(m -> "COMPLETED".equals(m.state())).count()
                + view.pendingClaims().size();
        long shownAmount = view.missions().stream().filter(m -> "COMPLETED".equals(m.state()))
                .mapToLong(MissionService.MissionView::amount).sum()
                + view.pendingClaims().stream().mapToLong(MissionService.PendingClaim::amount).sum();

        assertThat(view.claimableCount()).isEqualTo((int) shownCount).isEqualTo(3);
        assertThat(view.claimableAmount()).isEqualTo(shownAmount).isEqualTo(11 + 22 + 33);

        // 하나 받으면 합계와 목록이 **같이** 줄어든다.
        missionService.claim(uid, today);
        MissionService.DailyView after = missionService.daily(uid);
        assertThat(after.claimableCount()).isEqualTo(
                (int) (after.missions().stream().filter(m -> "COMPLETED".equals(m.state())).count()
                        + after.pendingClaims().size()))
                .isEqualTo(2);
        assertThat(after.missions()).filteredOn(m -> m.id().equals(today))
                .singleElement().satisfies(m -> assertThat(m.state()).isEqualTo("CLAIMED"));
    }

    /** 오래된 것부터 — 유저가 받는 순서를 예측할 수 있어야 한다(같은 날은 슬롯 순). */
    @Test
    void pendingClaimsAreOrderedOldestFirst() {
        String uid = user("mis_p_order");
        NOW.set(MIDDAY);
        String older = seedCompletedOn(uid, "2026-07-30", 1, "away_win_1");
        String midSlot2 = seedCompletedOn(uid, "2026-08-01", 2, "away_goals_3");
        String midSlot1 = seedCompletedOn(uid, "2026-08-01", 1, "away_win_2");

        assertThat(missionService.daily(uid).pendingClaims()
                .stream().map(MissionService.PendingClaim::id))
                .containsExactly(older, midSlot1, midSlot2);
    }

    /** 은퇴한(리롤된) 행은 지난 날짜여도 목록에 없다 — 유저가 갖고 있던 미션이 아니다. */
    @Test
    void retiredRowsNeverAppearInPendingClaims() {
        String uid = user("mis_p_retired");
        NOW.set(MIDDAY);
        String retired = seedCompletedOn(uid, "2026-08-01", 1, "away_win_2");
        jdbcClient.sql("UPDATE daily_missions SET rerolled_at = '2026-08-01T13:00:00Z' WHERE id = ?")
                .param(retired).update();
        String live = seedCompletedOn(uid, "2026-08-01", 2, "away_play_1");

        MissionService.DailyView view = missionService.daily(uid);
        assertThat(view.pendingClaims().stream().map(MissionService.PendingClaim::id))
                .containsExactly(live);
        assertThat(view.claimableCount()).isEqualTo(1);
    }

    // ── 결과 화면 미션의 state ───────────────────────────────────────────

    /**
     * <b>결과 화면 미션에 {@code state} 가 실린다.</b> 없으면 web 이 "지금 받을 수 있나"를
     * {@code progress >= target} 으로 <b>재계산</b>해야 하고, 그러면 <b>수령한 뒤에도 "받기"가 계속
     * 보인다</b> — 이 설계가 금지한 바로 그 짓이다(§8). 그래서 W3 는 결과 화면에 수령 버튼을 못 달았다.
     */
    @Test
    void resultMissionsCarryStateSoTheScreenNeverRecomputesIt() {
        String uid = user("mis_result_state");
        NOW.set(MIDDAY);
        String done = seed(uid, "2026-08-02", 1, "away_play_1");    // 이 경기로 달성된다
        String ongoing = seed(uid, "2026-08-02", 2, "away_play_3"); // 아직 진행 중

        String matchId = Ulid.next();
        List<MissionService.MatchMissionView> applied =
                missionService.settle(matchId, uid, "WIN", 1, 0, true, NOW.get());
        assertThat(applied).filteredOn(v -> v.id().equals(done)).singleElement()
                .satisfies(v -> {
                    assertThat(v.completedNow()).isTrue();
                    assertThat(v.state()).isEqualTo("COMPLETED");
                });
        assertThat(applied).filteredOn(v -> v.id().equals(ongoing)).singleElement()
                .satisfies(v -> assertThat(v.state()).isEqualTo("IN_PROGRESS"));

        // 다시 읽어도 같다(결과 화면은 여러 번 열린다).
        assertThat(missionService.progressOf(matchId, uid))
                .filteredOn(v -> v.id().equals(done)).singleElement()
                .satisfies(v -> assertThat(v.state()).isEqualTo("COMPLETED"));

        // ⚠️ **수령하면 CLAIMED 로 바뀐다** — 이게 안 바뀌면 결과 화면이 받은 보상을 또 권한다.
        missionService.claim(uid, done);
        assertThat(missionService.progressOf(matchId, uid))
                .filteredOn(v -> v.id().equals(done)).singleElement()
                .satisfies(v -> {
                    assertThat(v.state()).isEqualTo("CLAIMED");
                    assertThat(v.completedNow()).as("'이 경기로 달성됐다'는 사실은 안 바뀐다").isTrue();
                });
    }

    // ── 리롤 ────────────────────────────────────────────────────────────

    /** 리롤 = 슬롯당 1회 · 전체 풀에서 재추첨(보유분 제외) · 진행도 0 · 두 번째는 409. */
    @Test
    void rerollReplacesTheMissionResetsProgressAndIsOncePerSlot() {
        String uid = user("mis_reroll");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_3");
        String other = seed(uid, "2026-08-02", 2, "away_win_3");
        play(uid, "WIN", 1, 0);
        assertThat(progressOf(m)).isEqualTo(1);

        MissionService.MissionView fresh = missionService.reroll(uid, m);
        assertThat(fresh.missionId()).isNotEqualTo("away_play_3");
        assertThat(fresh.missionId()).as("보유 중인 다른 슬롯과도 겹치지 않는다").isNotEqualTo("away_win_3");
        assertThat(fresh.progress()).isZero();
        assertThat(fresh.rerollable()).isFalse();

        List<MissionService.MissionView> now = missionService.daily(uid).missions();
        assertThat(now).hasSize(2);
        assertThat(now.stream().map(MissionService.MissionView::id))
                .as("은퇴한 행은 화면에서 사라진다").doesNotContain(m).contains(fresh.id(), other);

        assertThatApi(() -> missionService.reroll(uid, fresh.id()))
                .hasStatus(HttpStatus.CONFLICT).hasCode("MISSION_REROLL_USED");
    }

    /** 달성한 미션은 리롤 불가 — 열면 "보상만 챙기고 새 미션"의 무한 루프가 된다(§6.2). */
    @Test
    void aCompletedMissionCannotBeRerolled() {
        String uid = user("mis_reroll_done");
        NOW.set(MIDDAY);
        String m = seed(uid, "2026-08-02", 1, "away_play_1");
        fillOtherSlot(uid, "2026-08-02", "away_play_3");
        play(uid, "WIN", 1, 0);

        assertThatApi(() -> missionService.reroll(uid, m))
                .hasStatus(HttpStatus.CONFLICT).hasCode("MISSION_ALREADY_COMPLETED");
        assertThat(missionService.daily(uid).missions().stream()
                .filter(v -> v.id().equals(m)).findFirst().orElseThrow().rerollable()).isFalse();
    }

    /** 지난 날짜의 미션은 교체 대상이 아니다(그날은 끝났다) — 남은 건 수령뿐이다. */
    @Test
    void yesterdaysMissionCannotBeRerolled() {
        String uid = user("mis_reroll_old");
        NOW.set(BEFORE_MIDNIGHT);
        String m = seed(uid, "2026-08-02", 1, "away_play_3");
        fillOtherSlot(uid, "2026-08-02", "away_win_3");

        NOW.set(AFTER_MIDNIGHT);
        assertThatApi(() -> missionService.reroll(uid, m))
                .hasStatus(HttpStatus.GONE).hasCode("MISSION_EXPIRED");
    }

    /** 리롤도 <b>전체 풀</b>에서 뽑는다 — 티어 안에서만 도는 변이체는 커버리지에서 죽는다(§6.2 대안 기각). */
    @Test
    void rerollDrawsFromTheWholePoolNotJustTheSameTier() {
        NOW.set(MIDDAY);
        // ⚠️ "리롤 결과 티어가 셋 다 나온다"로 걸면 **어차피 참**이다 — 원래 미션의 티어가 이미
        // 셋에 걸쳐 있어서, 같은 티어 안에서만 도는 변이체도 그 집합을 만족한다(실측으로 살아남았다).
        // 관계식으로 건다: **티어를 건너뛴 리롤이 실제로 일어나는가**.
        int crossTier = 0;
        for (int i = 0; i < 60; i++) {
            String uid = user("mis_rr_" + i);
            List<MissionService.MissionView> missions = missionService.daily(uid).missions();
            MissionService.MissionView target = missions.get(0);
            MissionService.MissionView fresh = missionService.reroll(uid, target.id());
            assertThat(fresh.missionId())
                    .isNotEqualTo(target.missionId())
                    .isNotEqualTo(missions.get(1).missionId());
            if (!fresh.tier().equals(target.tier())) {
                crossTier++;
            }
        }
        assertThat(crossTier)
                .as("전체 풀에서 뽑으면 티어를 건너뛴 결과가 나온다 — 0 이면 같은 티어 안에서만 돈 것이다")
                .isPositive();
    }

    // ── 발행값 · 경제 서열 ───────────────────────────────────────────────

    /**
     * <b>발행물</b>({@code data/players/economy.v3.json})이 hero 확정 금액을 싣고 있는가.
     * 위 계약들은 픽스처로 "config 를 읽는가"를 보고, 이것은 "발행값이 맞는가"를 본다 —
     * 두 질문을 한 파일로 합치면 상수 변이체가 산다(#251 MAJOR-1).
     */
    @Test
    void publishedEconomyCarriesHeroConfirmedMissionRewards() throws Exception {
        var root = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(new java.io.File("../data/players/economy.v3.json"));
        var reward = root.path("mission").path("reward");
        assertThat(reward.path("EASY").asInt()).isEqualTo(100);
        assertThat(reward.path("NORMAL").asInt()).isEqualTo(200);
        assertThat(reward.path("HARD").asInt()).isEqualTo(300);
    }

    /**
     * §5.3 <b>경제 서열</b> — 미션 하루 상한이 리그 축을 추월하면 "리그를 하는 것보다 미션 두 개가
     * 낫다"가 되어 리그의 위상이 무너진다. 노브를 돌려 서열이 깨지면 여기서 먼저 깨진다.
     *
     * <p>⚠️ 판정은 <b>발행 파일</b>로 한다 — 테스트 픽스처(11/22/33 · 6칸)로 재면 실경제가 아니라
     * 픽스처 곡선을 재게 되고, 그건 아무 의미가 없는 리포트다(#368 §4 마지막 경고).
     */
    @Test
    void missionDailyCeilingStaysUnderTheLeagueAxes() throws Exception {
        var root = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(new java.io.File("../data/players/economy.v3.json"));
        int hard = root.path("mission").path("reward").path("HARD").asInt();
        int missionCeiling = hard * missionProps.getCount();
        assertThat(missionCeiling).isEqualTo(600);

        var track = root.path("league").path("dailyReward");
        int slots = track.path("slotsPerDay").asInt();
        int bigCount = track.path("bigSlots").size();
        long leagueCeiling = (long) (slots - bigCount) * track.path("small").asInt()
                + (long) bigCount * track.path("big").asInt();
        assertThat((long) missionCeiling)
                .as("미션 하루 상한 < 리그 일일 트랙 이론 상한").isLessThan(leagueCeiling);
        assertThat(missionCeiling)
                .as("미션 하루 상한 < 리그 시즌 완주 보상")
                .isLessThan(root.path("league").path("gemReward").path("completion").asInt());
    }

    // ── 작은 단정 헬퍼 ───────────────────────────────────────────────────

    private static ApiAssert assertThatApi(Runnable action) {
        try {
            action.run();
            throw new AssertionError("ApiException 이 나야 하는데 정상 반환됐다");
        } catch (online.hmb.common.ApiException e) {
            return new ApiAssert(e);
        }
    }

    private record ApiAssert(online.hmb.common.ApiException e) {
        ApiAssert hasStatus(HttpStatus status) {
            assertThat(e.getStatus()).isEqualTo(status);
            return this;
        }

        ApiAssert hasCode(String code) {
            assertThat(e.getCode()).isEqualTo(code);
            return this;
        }
    }
}
