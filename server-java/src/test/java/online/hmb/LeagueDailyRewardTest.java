package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import online.hmb.league.LeagueDailyRewardService;
import online.hmb.league.LeagueService;
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
 * 리그 매판 일일 보상 트랙 계약 (#368, hero 확정 2026-07-31).
 *
 * <p>규칙: 칸 = 그날(KST) 치른 리그 경기 순번 · 승·무·패 무관 소비 · <b>지급은 승리에만</b> ·
 * 하루 {@code slotsPerDay} 칸까지 · 자정 리셋. 금액·칸 수·대량 위치는 economy 노브다.
 *
 * <p><b>금액은 픽스처 economy 로 검증한다</b>(발행물 18칸/9·18/30·300 이 아니라 6칸/3·6/7·70).
 * 같은 값을 쓰면 "config 를 무시하고 상수를 쓰는" 변이체가 전 스위트를 통과한다 — #251 독립검증
 * MAJOR-1 이 실제로 그 상태였다(지급점을 상수로 바꿔도 654/654 green). 발행값이 hero 확정과 같은지는
 * {@link #publishedEconomyCarriesHeroConfirmedTrackNumbers} 가 <b>따로</b> 본다.
 *
 * <p>시각은 가변 고정 Clock 빈(@Primary)으로 제어한다({@code MatchConditionDateAnchorTest} 와 같은 패턴).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueDailyRewardTest extends MatchTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    /** KST 2026-07-31 12:00 — 하루 한복판. */
    private static final Instant MIDDAY = Instant.parse("2026-07-31T03:00:00Z");
    /** KST 2026-07-31 23:59 — 자정 1분 전. UTC 로는 07-31. */
    private static final Instant BEFORE_MIDNIGHT = Instant.parse("2026-07-31T14:59:00Z");
    /**
     * KST 2026-08-01 00:30 — 자정 통과 후. <b>UTC 로는 여전히 07-31</b> 이라, 존을 무시한 구현은
     * 위와 같은 날로 읽는다(이 표본이 곧 UTC-자정 변이체를 죽이는 장치다).
     */
    private static final Instant AFTER_MIDNIGHT = Instant.parse("2026-07-31T15:30:00Z");

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
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
        // 픽스처 economy — 발행물과 **일부러 다른** 트랙 수치(6칸 · 3·6 대량 · 7 / 70).
        registry.add("hmb.data.economy-file", () -> "src/test/resources/fixtures/economy.v1.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @org.junit.jupiter.api.AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @jakarta.annotation.Resource
    private LeagueDailyRewardService dailyRewardService;

    @jakarta.annotation.Resource
    private LeagueService leagueService;

    @jakarta.annotation.Resource
    private FakeServants fakeServants;

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private LeagueDailyRewardService.SlotRow settle(String userId, String matchId, String result) {
        return dailyRewardService.settle(matchId, userId, result, NOW.get()).orElseThrow();
    }

    private long gemLedgerRows(String userId) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM gem_ledger WHERE user_id = ? AND reason = 'league_daily_gem'")
                .param(userId).query(Long.class).single();
    }

    private long gemLedgerTotal(String userId) {
        return jdbcClient.sql("""
                        SELECT COALESCE(SUM(delta), 0) FROM gem_ledger
                        WHERE user_id = ? AND reason = 'league_daily_gem'
                        """)
                .param(userId).query(Long.class).single();
    }

    private String newUser(String nickname) {
        setupUserWithDeck(nickname);
        NOW.set(MIDDAY);
        return userIdOf(nickname);
    }

    // ── 칸 소비 · 지급 ───────────────────────────────────────────────────

    /**
     * <b>패배도 칸을 쓴다.</b> 이 계약이 없으면 "이길 때까지 대박 칸을 지킨다"는 변이가 산다 —
     * 그러면 유저는 대박 칸 직전에서 지는 판을 무한히 재시도할 수 있고, hero 확정 ①(소멸)이 무너진다.
     */
    @Test
    void everyLeagueMatchConsumesASlotButOnlyWinsPay() {
        String uid = newUser("drt_consume");

        assertThat(settle(uid, "M-c1", "WIN").slotNo()).isEqualTo(1);
        assertThat(settle(uid, "M-c2", "LOSS").slotNo()).isEqualTo(2);
        assertThat(settle(uid, "M-c3", "DRAW").slotNo()).isEqualTo(3);
        assertThat(settle(uid, "M-c4", "WIN").slotNo()).isEqualTo(4);

        // 소멸한 칸도 **행은 남고 금액도 남는다**(화면이 "얼마를 날렸는지" 말해야 하므로).
        List<LeagueDailyRewardService.SlotRow> rows =
                dailyRewardService.slotsOf(uid, "2026-07-31");
        assertThat(rows).hasSize(4);
        assertThat(rows.get(1).awarded()).isFalse();
        assertThat(rows.get(1).amount()).isGreaterThan(0);
        assertThat(rows.get(2).awarded()).isFalse();

        // 지급은 승리 2건뿐: 1번 칸(소량 7) + 4번 칸(소량 7).
        assertThat(gemLedgerRows(uid)).isEqualTo(2L);
        assertThat(gemLedgerTotal(uid)).isEqualTo(14L);
    }

    /**
     * <b>대량 칸은 config 가 정한 위치에만</b> 있다. 픽스처는 6칸 트랙의 3·6번이 대량(70), 나머지 소량(7).
     * 위치를 상수로 박은 변이(9·18)는 여기서 죽는다 — 이 트랙엔 9번 칸 자체가 없다.
     */
    @Test
    void bigSlotsSitWhereConfigSaysAndPayTheBigAmount() {
        String uid = newUser("drt_big");

        int[] amounts = new int[7];
        for (int slot = 1; slot <= 6; slot++) {
            amounts[slot] = settle(uid, "M-b" + slot, "WIN").amount();
        }
        assertThat(amounts[1]).isEqualTo(7);
        assertThat(amounts[2]).isEqualTo(7);
        assertThat(amounts[3]).isEqualTo(70);
        assertThat(amounts[4]).isEqualTo(7);
        assertThat(amounts[5]).isEqualTo(7);
        assertThat(amounts[6]).isEqualTo(70);

        // 전승 하루 상한 = 4×7 + 2×70 = 168.
        assertThat(gemLedgerTotal(uid)).isEqualTo(168L);
    }

    /**
     * <b>트랙을 다 쓰면 거기서 끝이다</b>(hero 확정 2026-07-31 — 초기안의 "골드 사이클 무한반복" 철회).
     * 7번째 판은 이겨도 트랙 보상이 0이고 원장 행도 늘지 않는다. 칸 번호는 계속 세어지되 금액이 0이다.
     */
    @Test
    void trackEndsAfterSlotsPerDayAndFurtherWinsPayNothing() {
        String uid = newUser("drt_exhaust");
        for (int slot = 1; slot <= 6; slot++) {
            settle(uid, "M-x" + slot, "WIN");
        }
        long ledgerAfterTrack = gemLedgerRows(uid);
        long totalAfterTrack = gemLedgerTotal(uid);

        LeagueDailyRewardService.SlotRow beyond = settle(uid, "M-x7", "WIN");
        assertThat(beyond.slotNo()).isEqualTo(7);
        assertThat(beyond.amount()).isZero();
        assertThat(beyond.awarded()).isFalse();
        assertThat(gemLedgerRows(uid)).isEqualTo(ledgerAfterTrack);
        assertThat(gemLedgerTotal(uid)).isEqualTo(totalAfterTrack);

        // 트랙 응답도 "다 썼다"고 말한다 — 다음 칸이 없다.
        LeagueDailyRewardService.Track track =
                dailyRewardService.trackOf(uid, "2026-07-31", List.of());
        assertThat(track.next()).isNull();
        assertThat(track.consumed()).isEqualTo(7);
        assertThat(track.awardedCount()).isEqualTo(6);
    }

    // ── 날짜 경계 ────────────────────────────────────────────────────────

    /**
     * <b>경계는 KST 자정이지 UTC 자정이 아니다.</b> 두 표본은 <b>같은 UTC 날짜</b>(07-31 14:59Z / 15:30Z)
     * 이고 KST 로만 갈린다 — 존을 무시한 구현은 두 번째를 같은 날 2번 칸으로 읽는다.
     *
     * <p>#245 원정 일일제한이 이 부류의 버그를 <b>두 번</b> 잡혔다("세 번은 안 된다"고 적혀 있다).
     */
    @Test
    void dayBoundaryIsKstMidnightNotUtcMidnight() {
        String uid = newUser("drt_kst");

        NOW.set(BEFORE_MIDNIGHT);
        LeagueDailyRewardService.SlotRow lastOfToday = settle(uid, "M-k1", "WIN");
        assertThat(lastOfToday.slotNo()).isEqualTo(1);

        NOW.set(AFTER_MIDNIGHT);
        LeagueDailyRewardService.SlotRow firstOfTomorrow = settle(uid, "M-k2", "WIN");
        assertThat(firstOfTomorrow.slotNo())
                .as("KST 자정을 넘었으므로 새 날의 1번 칸이다(UTC 기준이면 2가 나온다)")
                .isEqualTo(1);

        // 두 날이 실제로 갈렸는지 — 각 날짜의 행이 하나씩.
        assertThat(dailyRewardService.slotsOf(uid, "2026-07-31")).hasSize(1);
        assertThat(dailyRewardService.slotsOf(uid, "2026-08-01")).hasSize(1);
    }

    // ── 멱등 ─────────────────────────────────────────────────────────────

    /**
     * 같은 매치를 두 번 정산해도 칸은 하나, 돈도 한 번. 두 층(match_id PK + 원장 유니크) 중
     * 어느 쪽이 막았는지와 무관하게 <b>관측되는 결과</b>로 건다.
     */
    @Test
    void settlingTheSameMatchTwiceConsumesOneSlotAndPaysOnce() {
        String uid = newUser("drt_idem");
        settle(uid, "M-i1", "WIN");

        assertThat(dailyRewardService.settle("M-i1", uid, "WIN", NOW.get())).isEmpty();
        assertThat(dailyRewardService.slotsOf(uid, "2026-07-31")).hasSize(1);
        assertThat(gemLedgerRows(uid)).isEqualTo(1L);
        assertThat(gemLedgerTotal(uid)).isEqualTo(7L);

        // 다음 매치는 정상적으로 2번 칸을 받는다(재진입이 칸을 태우지 않았다).
        assertThat(settle(uid, "M-i2", "WIN").slotNo()).isEqualTo(2);
    }

    /** 유저별로 칸이 독립이다 — 한 유저의 진행이 남의 칸을 당기지 않는다. */
    @Test
    void slotsAreCountedPerUser() {
        String a = newUser("drt_pu_a");
        String b = newUser("drt_pu_b");
        settle(a, "M-pa1", "WIN");
        settle(a, "M-pa2", "WIN");
        assertThat(settle(b, "M-pb1", "WIN").slotNo()).isEqualTo(1);
        assertThat(settle(a, "M-pa3", "WIN").slotNo()).isEqualTo(3);
    }

    // ── 트랙 응답 ────────────────────────────────────────────────────────

    /**
     * 트랙은 <b>서버가 통째로</b> 만든다 — 칸 수·대량 위치·금액·상대까지. 클라 계산 0 이 #262 컷 규율
     * (복제하면 config 를 돌린 순간 화면이 서버가 하지 않는 일을 단언한다).
     */
    @Test
    void trackCarriesEverySlotWithStateAndUpcomingOpponents() {
        String uid = newUser("drt_track");
        settle(uid, "M-t1", "WIN");
        settle(uid, "M-t2", "LOSS");

        LeagueDailyRewardService.Track track = dailyRewardService.trackOf(uid, "2026-07-31",
                List.of("Ironclad FC", "Crimson Vanguard"));

        assertThat(track.slots()).hasSize(6);            // = 픽스처 slotsPerDay
        assertThat(track.slots().get(0).state()).isEqualTo("WON");
        assertThat(track.slots().get(1).state()).isEqualTo("MISSED");
        assertThat(track.slots().get(2).state()).isEqualTo("PENDING");
        assertThat(track.slots().get(2).big()).isTrue();      // 픽스처 대량 = 3번
        assertThat(track.slots().get(2).amount()).isEqualTo(70);

        // 남은 칸에는 앞으로 칠 상대가 **가까운 순서대로** 붙는다(트랙 = 오늘의 일정).
        assertThat(track.slots().get(2).opponentName()).isEqualTo("Ironclad FC");
        assertThat(track.slots().get(3).opponentName()).isEqualTo("Crimson Vanguard");
        // 잔여 일정이 트랙보다 짧으면 그 칸의 상대는 없다 — 정상 상태다(화면은 보상만 그린다).
        assertThat(track.slots().get(4).opponentName()).isNull();

        assertThat(track.next().slotNo()).isEqualTo(3);
        assertThat(track.consumed()).isEqualTo(2);
        assertThat(track.awardedCount()).as("화면 헤더가 말하는 '오늘 n회 받음'").isEqualTo(1);
        assertThat(track.earned()).isEqualTo(7L);
    }

    /**
     * <b>지난 칸의 표시는 행이 진실이다</b>(독립검증 minor-2). 금액만 박제하고 {@code big} 을 읽을 때
     * 지금 config 로 재계산하면, 대량 위치를 옮기는 순간 <b>이미 받은 칸</b>이 "300 Z 를 받았는데
     * 소량 스타일"로 그려진다 — 돈은 맞고 스타일·라벨만 거짓말하는 상태라 더 찾기 어렵다.
     *
     * <p>노브를 실제로 돌릴 수는 없으므로(픽스처 고정) <b>행과 표시의 일치</b>로 건다:
     * 대량으로 지급된 칸은 트랙에서도 대량이고, 그 판정이 {@code amount} 와 함께 움직인다.
     */
    @Test
    void pastSlotsReportTheBigFlagThatWasStamped() {
        String uid = newUser("drt_stamp");
        for (int slot = 1; slot <= 4; slot++) {
            settle(uid, "M-s" + slot, "WIN");
        }
        List<LeagueDailyRewardService.SlotRow> rows = dailyRewardService.slotsOf(uid, "2026-07-31");
        // 픽스처 트랙에서 대량은 3번뿐(1·2·4는 소량).
        assertThat(rows.get(2).big()).isTrue();
        assertThat(rows.get(0).big()).isFalse();
        assertThat(rows.get(3).big()).isFalse();

        LeagueDailyRewardService.Track track =
                dailyRewardService.trackOf(uid, "2026-07-31", List.of());
        // 표시가 행을 따른다 + big 과 amount 가 **같은 출처**에서 온다(둘이 어긋나면 실패).
        for (LeagueDailyRewardService.TrackSlot slot : track.slots()) {
            if ("WON".equals(slot.state())) {
                assertThat(slot.big())
                        .as("칸 %d — 대량 표시는 지급액과 일치해야 한다", slot.slotNo())
                        .isEqualTo(slot.amount() == 70);
            }
        }
    }

    // ── 배선(이게 없으면 위 계약은 전부 공허하다) ────────────────────────

    /**
     * <b>실제 매치 플로우를 끝까지 돌려</b> 칸이 소비되는지 본다. 서비스 단위 계약만 있으면
     * {@code finishMatch} 에서 호출을 지운 변이가 전부 통과한다 — 트랙은 화면에서 영영 0칸인데
     * 스위트는 green 이다.
     */
    @Test
    void finishingARealLeagueMatchConsumesASlotThroughTheWholeFlow() {
        String token = setupUserWithDeck("drt_wire");
        String uid = userIdOf("drt_wire");
        NOW.set(MIDDAY);
        authPost("/api/league/start", token, null, Map.class);

        var nm = authPost("/api/league/next-match", token, null, Map.class);
        String matchId = (String) ((Map<?, ?>) nm.getBody().get("match")).get("id");

        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");

        LeagueDailyRewardService.SlotRow slot = dailyRewardService.slotOfMatch(matchId).orElseThrow();
        assertThat(slot.slotNo()).isEqualTo(1);
        assertThat(slot.opponentName()).as("상대 팀명이 그때 값으로 박제된다").isNotBlank();

        // 지급 여부는 **그 경기의 실제 결과와 묶어서** 본다(상수로 박으면 픽스처 스코어가 바뀔 때 거짓 실패).
        String result = jdbcClient.sql("SELECT result FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(slot.result()).isEqualTo(result);
        assertThat(slot.awarded()).isEqualTo("WIN".equals(result));
        assertThat(gemLedgerRows(uid)).isEqualTo("WIN".equals(result) ? 1L : 0L);

        // 연습 매치는 칸을 쓰지 않는다(트랙은 리그 축이다).
        releaseActiveMatches();
        String practiceId = createMatch(token, "BOT_BAL");
        authPost("/api/matches/" + practiceId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        authPost("/api/matches/" + practiceId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + practiceId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(practiceId)).isEqualTo("FINISHED");
        assertThat(dailyRewardService.slotOfMatch(practiceId)).isEmpty();
        assertThat(dailyRewardService.slotsOf(uid, "2026-07-31")).hasSize(1);
    }

    /** {@code GET /api/league} 가 트랙을 싣는다 — 시즌 DTO <b>밖</b>(칸은 시즌이 아니라 하루에 매인다). */
    @Test
    @SuppressWarnings("unchecked")
    void getLeagueCarriesTodayTrackEvenBeforeAnySeasonStarts() {
        String token = setupUserWithDeck("drt_api");
        NOW.set(MIDDAY);

        var before = authGet("/api/league", token, Map.class);
        assertThat(before.getBody().get("season")).isNull();
        Map<String, Object> track = (Map<String, Object>) before.getBody().get("dailyReward");
        assertThat(track).as("시즌이 없어도 오늘의 칸은 있다").isNotNull();
        assertThat(track.get("day")).isEqualTo("2026-07-31");
        assertThat(((Number) track.get("slotsPerDay")).intValue()).isEqualTo(6);
        assertThat((List<?>) track.get("slots")).hasSize(6);
        assertThat(((Number) track.get("consumed")).intValue()).isZero();
        assertThat(((Map<?, ?>) track.get("next")).get("slotNo")).isEqualTo(1);

        // 시즌을 시작하면 남은 칸에 잔여 일정 상대가 붙는다.
        authPost("/api/league/start", token, null, Map.class);
        var after = authGet("/api/league", token, Map.class);
        Map<String, Object> track2 = (Map<String, Object>) after.getBody().get("dailyReward");
        List<Map<String, Object>> slots = (List<Map<String, Object>>) track2.get("slots");
        assertThat(slots.get(0).get("opponentName")).isNotNull();
    }

    // ── 발행값 · 승급/강등 컷 (수치가 hero 확정과 같은가) ────────────────

    /**
     * <b>발행물</b>(`data/players/economy.v3.json`)이 hero 확정 트랙 수치를 싣고 있는가.
     * 위 계약들은 픽스처로 "config 를 읽는가"를 보고, 이것은 "발행값이 맞는가"를 본다 —
     * 두 질문을 한 파일로 합치면 상수 변이체가 산다(#251 MAJOR-1).
     */
    @Test
    void publishedEconomyCarriesHeroConfirmedTrackNumbers() throws Exception {
        var root = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(new java.io.File("../data/players/economy.v3.json"));
        var daily = root.path("league").path("dailyReward");
        assertThat(daily.path("slotsPerDay").asInt()).isEqualTo(18);
        assertThat(daily.path("bigSlots").toString()).isEqualTo("[9,18]");
        assertThat(daily.path("currency").asText()).isEqualTo("GEM");
        assertThat(daily.path("small").asInt()).isEqualTo(30);
        assertThat(daily.path("big").asInt()).isEqualTo(300);
        // 하루 전승 상한 = 16×30 + 2×300 = 1,080 Z (hero 확정 ①).
        assertThat(16 * daily.path("small").asInt() + 2 * daily.path("big").asInt()).isEqualTo(1080);
    }

    /**
     * 승급/강등 컷 (#368 축 2, hero 확정 ③④) — <b>1~2위 승급 · 9~10위 강등 · 3~8위 잔류</b>.
     *
     * <p>이 값은 #252 가 이미 넣어 둔 것이라 #368 은 코드를 바꾸지 않았다. 계약을 두는 이유는
     * <b>다음에 누가 튜닝하면 여기가 먼저 깨져 이 결정을 다시 보게</b> 하기 위해서다.
     * 사다리 양 끝 클램프(최상위 승급 없음 · 최하위 강등 없음)도 같이 건다.
     */
    @Test
    void promotionAndRelegationCutsMatchHeroConfirmedSpec() {
        int top = 1;
        int bottom = 10;
        int mid = 5;

        // 중간 디비전: 1~2위 승급(level-1) · 9~10위 강등(level+1) · 3~8위 유지.
        assertThat(LeagueService.nextDivision(mid, 1, top, bottom, 2, 9)).isEqualTo(mid - 1);
        assertThat(LeagueService.nextDivision(mid, 2, top, bottom, 2, 9)).isEqualTo(mid - 1);
        assertThat(LeagueService.nextDivision(mid, 3, top, bottom, 2, 9)).isEqualTo(mid);
        assertThat(LeagueService.nextDivision(mid, 8, top, bottom, 2, 9)).isEqualTo(mid);
        assertThat(LeagueService.nextDivision(mid, 9, top, bottom, 2, 9)).isEqualTo(mid + 1);
        assertThat(LeagueService.nextDivision(mid, 10, top, bottom, 2, 9)).isEqualTo(mid + 1);

        // 사다리 끝 클램프(hero 확정 ④): 최상위엔 승급이, 최하위엔 강등이 없다.
        assertThat(LeagueService.nextDivision(top, 1, top, bottom, 2, 9)).isEqualTo(top);
        assertThat(LeagueService.nextDivision(bottom, 10, top, bottom, 2, 9)).isEqualTo(bottom);

        // 서버가 실제로 쓰는 config 값이 그 컷인가(application.yml 이 SoT).
        assertThat(promoteRankMaxProperty()).isEqualTo(2);
        assertThat(relegateRankMinProperty()).isEqualTo(9);
    }

    @org.springframework.beans.factory.annotation.Value("${hmb.league.division.promote-rank-max}")
    private int promoteRankMax;

    @org.springframework.beans.factory.annotation.Value("${hmb.league.division.relegate-rank-min}")
    private int relegateRankMin;

    private int promoteRankMaxProperty() {
        return promoteRankMax;
    }

    private int relegateRankMinProperty() {
        return relegateRankMin;
    }
}
