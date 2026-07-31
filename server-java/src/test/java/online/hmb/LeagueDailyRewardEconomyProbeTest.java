package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.List;
import java.util.SplittableRandom;
import online.hmb.catalog.EconomyService.LeagueDailyReward;
import org.junit.jupiter.api.Test;

/**
 * #368 축 4 — <b>다시드 경제 스윕</b>. 매판 보상 트랙이 다이아(Z) 수급에 얼마를 더하는지 실측한다.
 *
 * <p><b>왜 시드를 여러 개 도는가</b>: 트랙 자체는 결정론이다(칸→금액이 고정). 흔들리는 것은
 * <b>유저가 몇 판 이기느냐</b>이고, 그게 곧 실수급이다. 승률 하나로 단정하면 "평균은 맞는데 꼬리에서
 * 터지는" 곡선을 못 본다 — 그래서 승률대별로 다시드를 돌려 <b>분포</b>를 찍는다
 * (루트 memory `balance-measure-multiseed` 와 같은 규율).
 *
 * <p><b>기준선</b>: 젬 수급원은 지금 셋이다 — 가입 지급 · 시즌 완주(#251, 3,000~9,000 Z) · 이 트랙.
 * 판정 어서션은 <b>구조적 상한·서열</b>만 두고 나머지는 리포트다. 확률 지표를 계약으로 걸면
 * 곡선을 튜닝할 때마다 거짓 실패가 된다.
 *
 * <p>⚠️ <b>스윕이 보는 것은 발행물이지 픽스처가 아니다.</b> {@code TestDbSupport.registerTempDb} 가
 * <b>모든 테스트에</b> `fixtures/economy.v1.json` 을 물리므로, {@code economyService} 로 재면
 * 실경제(18칸·30/300)가 아니라 테스트용 곡선(6칸·7/70)을 재게 된다 — 초판이 실제로 그랬고
 * "시즌 보상의 0.02배"라는 무의미한 리포트가 나왔다. 경제 판정은 <b>발행 파일을 직접 읽는다</b>.
 * (`economyService` 가 config 를 읽는가는 {@link LeagueDailyRewardTest} 가 픽스처로 따로 본다 —
 * 두 질문을 한 파일에서 재면 상수 변이체가 산다.)
 */
class LeagueDailyRewardEconomyProbeTest {

    private static final String PUBLISHED = "../data/players/economy.v3.json";

    /** 발행 economy 의 트랙 곡선 — 라이브가 실제로 쓰는 값. */
    private static LeagueDailyReward publishedCurve() throws Exception {
        var league = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(new java.io.File(PUBLISHED)).path("league");
        var d = league.path("dailyReward");
        var big = new java.util.TreeSet<Integer>();
        d.path("bigSlots").forEach(n -> big.add(n.asInt()));
        return new LeagueDailyReward(d.path("slotsPerDay").asInt(), big,
                d.path("currency").asText(), d.path("small").asInt(), d.path("big").asInt());
    }

    /** 발행 economy 의 시즌 완주 보상(#251) — 서열 비교의 상대편. */
    private static int publishedSeasonGems(int rank) throws Exception {
        var gem = new com.fasterxml.jackson.databind.ObjectMapper()
                .readTree(new java.io.File(PUBLISHED)).path("league").path("gemReward");
        return gem.path("completion").asInt() + gem.path("rankBonus").path(String.valueOf(rank)).asInt(0);
    }

    private static long ceilingOf(LeagueDailyReward cfg) {
        long sum = 0;
        for (int slot = 1; slot <= cfg.slotsPerDay(); slot++) {
            sum += cfg.amountFor(slot);
        }
        return sum;
    }

    /** 한 시드의 하루 트랙 수입 — 승률 p 로 {@code slotsPerDay} 판을 치른 결과. */
    private static long dailyIncome(LeagueDailyReward cfg, double winRate, long seed) {
        SplittableRandom rng = new SplittableRandom(seed);
        long sum = 0;
        for (int slot = 1; slot <= cfg.slotsPerDay(); slot++) {
            if (rng.nextDouble() < winRate) {
                sum += cfg.amountFor(slot);
            }
        }
        return sum;
    }

    @Test
    void dailyTrackIncomeAcrossWinRatesAndSeeds() throws Exception {
        // 발행물(무배포 노브)을 그대로 읽는다 — 노브를 돌리면 이 리포트가 따라 움직여야 한다.
        LeagueDailyReward cfg = publishedCurve();
        int seeds = 500;
        long perfect = ceilingOf(cfg);

        System.out.println("\n===== #368 리그 매판 보상 트랙 — 경제 스윕 =====");
        System.out.printf("트랙: %d칸 · 대량 %s · 소량 %d %s / 대량 %d %s%n",
                cfg.slotsPerDay(), cfg.bigSlots(), cfg.small(), cfg.currency(), cfg.big(), cfg.currency());
        System.out.printf("하루 상한(전승) = %d %s%n", perfect, cfg.currency());
        System.out.println("승률 |    p50 |    평균 |    p90 |  최대 | 30일 평균");

        for (double winRate : new double[] {0.30, 0.45, 0.60, 0.75, 0.90, 1.00}) {
            List<Long> samples = new ArrayList<>(seeds);
            for (long seed = 0; seed < seeds; seed++) {
                samples.add(dailyIncome(cfg, winRate, seed));
            }
            samples.sort(Long::compare);
            long p50 = samples.get(seeds / 2);
            long p90 = samples.get((int) (seeds * 0.9));
            long max = samples.get(seeds - 1);
            double mean = samples.stream().mapToLong(Long::longValue).average().orElse(0);
            System.out.printf("%3.0f%% | %6d | %7.1f | %6d | %5d | %9.0f%n",
                    winRate * 100, p50, mean, p90, max, mean * 30);

            // 구조적 상한 — 어떤 시드에서도 전승 수입을 넘을 수 없다.
            assertThat(max).isLessThanOrEqualTo(perfect);
        }

        // 다른 수급원과 나란히 — "이 트랙이 젬 경제에서 얼마나 큰가"의 기준선.
        int seasonTop = publishedSeasonGems(1);
        int seasonFloor = publishedSeasonGems(99);
        System.out.printf("%n대조(발행): 시즌 완주 1등 %d Z · 4등 이하 %d Z (#251)%n", seasonTop, seasonFloor);
        System.out.printf("한 시즌(18라운드) = 트랙 하루치 한 판 — 전승 %d Z = 완주 최저의 %.2f 배 · 1등의 %.2f 배%n",
                perfect, perfect / (double) seasonFloor, perfect / (double) seasonTop);
        System.out.println("=================================================\n");
    }

    /**
     * <b>인플레 가드</b>: 트랙 하루 상한이 시즌 완주 보상(#251)을 넘지 않는다.
     *
     * <p>이유는 곡선의 <b>서열</b>이다 — 시즌을 끝내는 것이 하루 리그를 도는 것보다 커야 매판 보상이
     * 시즌 보상을 무의미하게 만들지 않는다. 넘기면 유저는 시즌을 끝낼 이유가 없어진다.
     * 이 관계가 깨지는 노브 조정은 <b>의도한 것이어야</b> 하고, 그때 이 계약이 먼저 깨진다.
     */
    @Test
    void dailyTrackCeilingStaysUnderSeasonCompletionReward() throws Exception {
        long perfectDay = ceilingOf(publishedCurve());
        // 시즌 완주 최저(4등 이하) 기준 — 가장 빡빡한 비교다.
        int seasonFloor = publishedSeasonGems(99);
        assertThat(perfectDay)
                .as("하루 전승 트랙(%d Z)이 시즌 완주 최저 보상(%d Z)을 넘으면 시즌을 끝낼 이유가 사라진다",
                        perfectDay, seasonFloor)
                .isLessThanOrEqualTo(seasonFloor);
    }

    /**
     * 스윕 시뮬레이터의 성질 — 전패면 0. <b>계약이 아니라 도구 검사다</b>(독립검증 minor-4).
     *
     * <p>이 클래스는 프로덕션 코드를 타지 않는다 — 발행 파일을 읽어 곡선을 <b>모델링</b>할 뿐이다.
     * "지급은 승리에만"의 진짜 계약은 실 지급 경로를 타는
     * {@link LeagueDailyRewardTest#everyLeagueMatchConsumesASlotButOnlyWinsPay} 이고, 그것이
     * "무승부도 지급" 변이체를 죽인다. 여기 이름을 계약처럼 지어 두면 다음 사람이 <b>이미 검증됐다고
     * 착각</b>한다.
     */
    @Test
    void sweepSimulatorYieldsZeroWhenNoMatchIsWon() throws Exception {
        assertThat(dailyIncome(publishedCurve(), 0.0, 1L)).isZero();
    }

    /** 발행물이 하루 상한 1,080 Z(hero 확정 ①)를 만든다 — 곡선이 바뀌면 여기가 먼저 깨진다. */
    @Test
    void publishedCurveGivesTheConfirmedDailyCeiling() throws Exception {
        assertThat(ceilingOf(publishedCurve())).isEqualTo(1080L);
    }

    @Test
    void everySlotIsCoveredByTheCurve() throws Exception {
        LeagueDailyReward cfg = publishedCurve();
        // 트랙 안의 모든 칸에 값이 있다(0 짜리 구멍이 없다) + 트랙 밖은 0.
        for (int slot = 1; slot <= cfg.slotsPerDay(); slot++) {
            assertThat(cfg.amountFor(slot)).as("칸 %d", slot).isPositive();
        }
        assertThat(cfg.amountFor(cfg.slotsPerDay() + 1)).isZero();
        assertThat(cfg.amountFor(0)).isZero();
    }
}
