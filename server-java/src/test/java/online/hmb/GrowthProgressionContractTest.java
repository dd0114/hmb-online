package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.growth.GrowthMath;
import online.hmb.growth.GrowthTuning;
import org.junit.jupiter.api.Test;

/**
 * <b>육성 진행의 관계식 계약</b>(#405, 독립검증 BL-1 수습) — 설계 §2.2 의 "2단계 역전"이
 * <b>게임이 실제 쓰는 축(OVR)</b>에서 성립하는가.
 *
 * <p><b>왜 관계식인가</b>: 값을 리터럴로 박으면 밴드·천장·만렙을 조정할 때마다 계약을 같이 고쳐야
 * 하고, 그러면 계약이 구현을 따라다니느라 아무것도 못 잡는다. 여기서는 {@link GrowthTuning} 기본값과
 * {@link GrowthMath} 만으로 <b>직접 계산</b>해 <b>부등식</b>을 단언한다 — 누가 감쇠를 4.0/1.4 로
 * 되돌리면 세 쌍이 전부 음수가 되어 그 자리에서 걸린다(되돌리기 전 실측 −5.95 / −6.78 / −7.69).
 *
 * <p><b>측정 기준(중요 — 단위를 섞지 않는다)</b>: 양쪽 다 <b>밴드 중앙에서 출발한 카드</b>다.
 * 성장한 쪽은 {@code maxLevel−1} 픽을 포지션 핵심 4스탯에 균등 배분하고, 비교 대상은 2단계 위
 * 등급의 <b>미성장</b> 카드다. OVR = {@code Σ 스탯 × positionBaseline}(가중 합 = 1 이라
 * 미성장 카드의 OVR 은 곧 밴드 중앙값이다).
 * <p>⚠️ 설계 §2.2 초판이 <b>좌변 4스탯 / 우변 9스탯</b>으로 단위를 섞어 역전을 과대평가했다.
 * 같은 함정이 재발하지 않도록 이 계약은 <b>한쪽 계산기</b>로 양변을 만든다.
 *
 * <p>⚠️ <b>이 계약이 증명하지 않는 것</b>: 발행물(`players.v2.5.json`)의 실제 카드는 주스탯·trait
 * 바이어스(+3/+4)만큼 <b>미성장 쪽 OVR 이 더 높다</b>(등급 평균 OVR 이 밴드 중앙보다 +1.7~2.0).
 * 성장한 쪽은 핵심 4스탯이 이미 천장에 붙어 그 바이어스를 흡수하지 못하므로, <b>실제 로스터 기준
 * 마진은 여기 값보다 약 1.7 낮다</b>(실측 B>G +1.30 · S>D −0.11 · G>L −1.71). 즉 <b>발행물 기준으로는
 * S>D·G>L 이 아직 미달</b>이다 — 그 사실은 보고에 남겼고, 이 계약은 <b>설계 기준의 회귀 가드</b>다.
 */
class GrowthProgressionContractTest {

    private static final GrowthTuning TUNING = GrowthTuning.CODE_DEFAULTS;
    /** 핵심 스탯 수 — 설계 §2.2 의 "4스탯 집중". */
    private static final int FOCUS = 4;

    // ── 2단계 역전 ───────────────────────────────────────────────────────

    /**
     * <b>만렙까지 키운 카드는 2단계 위 미성장 카드를 이긴다</b> — 세 쌍 전부(B>G · S>D · G>L).
     * 이게 §2.2 의 존재 이유다: 안 겹치면 하위 등급을 키울 이유가 없다.
     */
    @Test
    void aMaxedCardBeatsAnUngrownCardTwoGradesAbove() {
        for (int i = 0; i + 2 < GrowthTuning.GRADES.size(); i++) {
            String lower = GrowthTuning.GRADES.get(i);
            String twoUp = GrowthTuning.GRADES.get(i + 2);
            assertThat(margin(lower, twoUp))
                    .as("%s 만렙(핵심 %d스탯 집중)이 미성장 %s 를 못 이긴다 — 하위 등급을 키울 이유가 사라진다",
                            lower, FOCUS, twoUp)
                    .isGreaterThan(0.0);
        }
    }

    /** 역전 폭은 <b>위로 갈수록 좁아진다</b>(설계 §2.2 "시작 격차 9 / 천장 격차 6"의 귀결). */
    @Test
    void theUpsetMarginNarrowsTowardTheTopOfTheLadder() {
        double bronze = margin("BRONZE", "GOLD");
        double silver = margin("SILVER", "DIA");
        double gold = margin("GOLD", "LEGEND");
        assertThat(bronze).isGreaterThan(silver);
        assertThat(silver).isGreaterThan(gold);
    }

    /**
     * <b>가장 약한 고리를 숨기지 않는다.</b> MF 는 포지션 baseline 이 평평해(핵심 4스탯 합 0.62,
     * GK 0.74) 집중 육성의 이득이 가장 작고, <b>G>L 한 쌍에서 아직 음수</b>다.
     *
     * <p>이 단언이 통과한다는 것은 <b>목표가 아직 미달이라는 뜻</b>이다 — 나중에 이걸 실제로 해결하면
     * 이 테스트가 깨지고, 그때 이 줄을 지우는 것이 올바른 반응이다. 상한을 함께 걸어 두어
     * (−3 보다 나빠지지 않는다) 조용히 더 나빠지는 것도 잡는다.
     */
    @Test
    void theMidfielderGapIsRecordedAsAKnownShortfall() {
        double mfGoldToLegend = marginFor("MF", "GOLD", "LEGEND");
        assertThat(mfGoldToLegend)
                .as("MF G>L 이 양수가 됐다면 목표가 달성된 것이다 — 이 '알려진 미달' 기록을 지워라")
                .isLessThan(0.0)
                .as("MF G>L 이 더 나빠졌다 — 감쇠·baseline 회귀를 의심해라")
                .isGreaterThan(-3.0);
    }

    // ── 방침 유지 (역전을 얻느라 깨지면 안 되는 것들) ─────────────────────

    /** <b>만렙끼리의 순서는 여전히 등급순</b>이다 — 뽑기 가치가 보존된다(설계 §2.2). */
    @Test
    void maxedCardsStillRankByGrade() {
        double previous = Double.NEGATIVE_INFINITY;
        for (String grade : GrowthTuning.GRADES) {
            double value = grownOvr(grade);
            assertThat(value).as("%s 만렙이 하위 등급 만렙보다 낮다 — 등급 서열이 무너졌다", grade)
                    .isGreaterThan(previous);
            previous = value;
        }
    }

    /**
     * <b>한 스탯 몰빵은 비효율</b>이다(설계 §2.3). 감쇠를 세게 풀면 이 방침이 깨질까 봐 같이 본다 —
     * 실제로는 <b>강화</b>된다(1스탯 총상승은 천장에 묶여 고정인데 9스탯 총합만 늘기 때문).
     */
    @Test
    void dumpingEverythingIntoOneStatStaysInefficient() {
        double spread = totalGain("GOLD", GrowthTuning.STATS.size());
        double dump = totalGain("GOLD", 1);
        assertThat(dump).as("몰빵이 균등 분산보다 총상승이 크면 '집중은 비효율' 방침이 뒤집힌다")
                .isLessThan(spread);
        assertThat(dump / spread).isLessThan(0.5);
    }

    /** 천장에 닿은 스탯은 더 오르지 않는다 — 역전을 만드느라 천장이 새면 안 된다. */
    @Test
    void growthNeverCrossesTheCeiling() {
        for (String grade : GrowthTuning.GRADES) {
            double ceiling = GrowthMath.ceiling(TUNING, grade, 1);
            Map<String, Double> card = grow(grade, "FW", FOCUS);
            for (double value : card.values()) {
                assertThat(value).isLessThanOrEqualTo(ceiling + 1e-9);
            }
        }
    }

    // ── 계산기 (설계 기준을 한 곳에서 만든다) ─────────────────────────────

    /** 2단계 역전 마진 — 포지션 평균. 한 포지션만 보면 표본이 그 포지션의 baseline 모양에 갇힌다. */
    private static double margin(String lower, String twoUp) {
        return GrowthTuning.POSITIONS.stream()
                .mapToDouble(position -> marginFor(position, lower, twoUp))
                .average().orElseThrow();
    }

    private static double marginFor(String position, String lower, String twoUp) {
        return ovr(grow(lower, position, FOCUS), position) - center(twoUp);
    }

    private static double grownOvr(String grade) {
        return GrowthTuning.POSITIONS.stream()
                .mapToDouble(position -> ovr(grow(grade, position, FOCUS), position))
                .average().orElseThrow();
    }

    private static double totalGain(String grade, int focus) {
        return GrowthTuning.POSITIONS.stream().mapToDouble(position -> {
            Map<String, Double> card = grow(grade, position, focus);
            return card.values().stream().mapToDouble(v -> v - center(grade)).sum();
        }).average().orElseThrow();
    }

    /**
     * 밴드 중앙에서 출발해 {@code maxLevel−1} 픽을 상위 {@code focus} 개 스탯에 <b>균등 배분</b>한다
     * (한 픽 = 한 레벨업 = {@link GrowthMath#gain} 한 번).
     */
    private static Map<String, Double> grow(String grade, String position, int focus) {
        Map<String, Double> card = new LinkedHashMap<>();
        for (String stat : GrowthTuning.STATS) {
            card.put(stat, center(grade));
        }
        List<String> targets = coreStats(position, focus);
        int picks = Math.max(0, TUNING.xp().maxLevel() - 1);
        for (int n = 0; n < picks; n++) {
            String stat = targets.get(n % targets.size());
            card.put(stat, card.get(stat) + GrowthMath.gain(TUNING, grade, 1, card.get(stat), 1));
        }
        return card;
    }

    /** 그 포지션이 실제로 쓰는 스탯 = {@code positionBaseline} 상위 N — 코드에 목록을 적지 않는다. */
    private static List<String> coreStats(String position, int focus) {
        return TUNING.positionBaseline().getOrDefault(position, Map.of()).entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue().reversed())
                .limit(focus)
                .map(Map.Entry::getKey)
                .toList();
    }

    private static double ovr(Map<String, Double> card, String position) {
        Map<String, Double> baseline = TUNING.positionBaseline().getOrDefault(position, Map.of());
        return card.entrySet().stream()
                .mapToDouble(e -> e.getValue() * baseline.getOrDefault(e.getKey(), 0.0))
                .sum();
    }

    /** 미성장 카드의 OVR = 밴드 중앙(가중 합이 1 이라 그대로 떨어진다). */
    private static double center(String grade) {
        GrowthTuning.Band band = GrowthMath.band(TUNING, grade);
        return (band.startLo() + band.startHi()) / 2.0;
    }
}
