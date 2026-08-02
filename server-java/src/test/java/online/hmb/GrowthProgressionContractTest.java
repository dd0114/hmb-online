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
 * <p>🚨 <b>이 계약은 확정 판정 기준이 아니다.</b> 확정 기준은 <b>발행물 실측 · 실제 3지선다 추첨 ·
 * OVR 최선 선택 · 39픽 · 1★</b> 이고 그 기준으로는 <b>세 쌍 전부 통과</b>한다
 * (실측 <b>B>G +3.51 · S>D +2.34 · G>L +1.08</b>). 그 가드는
 * {@link GrowthShippedProgressionTest} 다 — <b>헤드라인 목표의 판정은 그쪽을 봐라.</b>
 *
 * <p>여기 계산기는 <b>밴드 중앙 + 핵심 4스탯 균등 배분</b>이라는 <b>대조군</b>이다. 그 배분 가정은
 * 설계 §2.2 가 <b>"배분 가정이 틀렸다"며 폐기</b>한 것이고(유저는 매 레벨 뽑힌 3개 중에서 고르지,
 * 핵심 4스탯에 균등 배분하지 않는다), 같은 계산기로 재면 마진이 훨씬 얇게 나온다
 * (<b>대조군 값: B>G +2.80 · S>D +1.57 · G>L +0.22</b>, 포지션 평균). <b>지우지 않고 남기는 이유</b>는
 * 그 차이 자체가 정보이기 때문이다 — 배분 가정 하나가 마진을 1~2 OVR 씩 깎는다.
 *
 * <p>⚠️ <b>수치를 인용할 땐 어느 계산기인지 반드시 같이 써라.</b> 이 에픽에서 같은 종류의 혼동이
 * 세 번 났다(설계 §2.2 초판의 좌변 4스탯/우변 9스탯 · 성장쪽 발행물/미성장쪽 밴드중앙 · 그리고
 * 폐기된 배분 가정을 확정 기준으로 오독한 것).
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
     * <b>대조군 안에서 가장 약한 고리</b> — MF 는 포지션 baseline 이 평평해(핵심 4스탯 합 0.62,
     * GK 0.74) "핵심 4스탯 균등 배분" 가정의 이득을 가장 적게 받고, 그 가정 하에서 G>L 이 음수다.
     *
     * <p>🚨 <b>이것은 "목표 미달"이 아니다.</b> 확정 기준(발행물 · 실제 추첨 · OVR 최선)에서는 MF 를
     * 포함해 세 쌍이 전부 통과한다 — {@link GrowthShippedProgressionTest} 가 그 가드다. 여기 음수는
     * <b>폐기된 배분 가정이 얼마나 불리한 근사인가</b>를 보여 주는 값이고, 그래서 값이 조용히 더
     * 나빠지는 것만 감시한다(하한 −3).
     */
    @Test
    void theMidfielderIsTheWeakestLinkUnderTheDiscardedAllocationAssumption() {
        double mfGoldToLegend = marginFor("MF", "GOLD", "LEGEND");
        assertThat(mfGoldToLegend)
                .as("대조군에서 MF G>L 이 양수가 됐다 — 근사가 좋아진 것이니 이 기록을 갱신해라")
                .isLessThan(0.0)
                .as("대조군 MF G>L 이 더 나빠졌다 — 감쇠·baseline 회귀를 의심해라")
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
