package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.growth.GrowthCandidates;
import online.hmb.growth.GrowthTuning;
import org.junit.jupiter.api.Test;

/**
 * <b>3지선다 후보의 결정론과 감쇠</b>(#405 W2b, 설계 §2.5·§2.3) — Spring 없이 도는 순수 계약.
 *
 * <p>결정론이 없으면 "후보를 박제한다"는 말이 성립하지 않는다: 박제본과 재현본이 갈라지면
 * 감사도 롤백도 불가능하고, 정산 재실행이 다른 답을 준다.
 *
 * <p>여기 기대값은 {@code GrowthTuning} 에서 다시 읽어오지 않는다 — 전부 <b>구조적 성질</b>
 * (같다 · 다르다 · 크다 · 없다)이라 계수가 바뀌어도 유효하다.
 */
class GrowthCandidateDeterminismTest {

    private static final GrowthTuning T = GrowthTuning.CODE_DEFAULTS;

    private static final String MATCH = "01JMATCH0000000000000000";
    private static final String USER = "01JUSER00000000000000000";
    private static final String PLAYER = "P010";

    /** GOLD 카드가 시작 밴드 근처에 있는 상태(감쇠 곡선의 왼쪽). */
    private static Map<String, Double> flatStats(double value) {
        Map<String, Double> m = new LinkedHashMap<>();
        for (String stat : GrowthTuning.STATS) {
            m.put(stat, value);
        }
        return m;
    }

    private static Map<String, Double> zero() {
        return flatStats(0.0);
    }

    private GrowthCandidates.Draw drawAt(int level, Map<String, Double> stats) {
        String seed = GrowthCandidates.seed(MATCH, USER, PLAYER, level);
        return GrowthCandidates.draw(T, seed, "MF", "GOLD", 1, stats, zero(), zero(), "WIN", level);
    }

    // ── 계약 1: 결정론 ───────────────────────────────────────────────────

    /** 같은 {@code (matchId, userId, playerId, level)} 은 몇 번을 다시 계산해도 같은 3개 + 같은 gain. */
    @Test
    void sameKeyAlwaysProducesTheSameThreeCandidatesAndGains() {
        Map<String, Double> stats = flatStats(55.0);
        for (int level = 1; level <= 5; level++) {
            GrowthCandidates.Draw first = drawAt(level, stats);
            GrowthCandidates.Draw again = drawAt(level, stats);
            assertThat(again.choices()).as("level=%d", level).isEqualTo(first.choices());
            assertThat(first.choices()).hasSize(3);
        }
    }

    /**
     * <b>레벨이 시드에 들어간다</b> — 안 들어가면 한 경기의 3연속 레벨업이 같은 3장을 세 번 준다.
     * 전 레벨이 동일할 확률은 무시할 수 없지만(9C3=84), 다섯 레벨이 <b>전부</b> 같으면 시드가
     * 레벨을 안 보고 있다는 뜻이다.
     */
    @Test
    void differentLevelsGetDifferentDraws() {
        Map<String, Double> stats = flatStats(55.0);
        List<List<GrowthCandidates.Choice>> draws = List.of(
                drawAt(1, stats).choices(), drawAt(2, stats).choices(), drawAt(3, stats).choices(),
                drawAt(4, stats).choices(), drawAt(5, stats).choices());
        assertThat(draws.stream().distinct().count())
                .as("레벨이 달라도 후보가 전부 같다 — 시드에 level 이 안 들어갔다")
                .isGreaterThan(1);
    }

    /** 다른 유저·다른 카드는 다른 시드를 받는다(같은 매치라도). */
    @Test
    void seedSeparatesUsersCardsAndSources() {
        String a = GrowthCandidates.seed(MATCH, USER, PLAYER, 1);
        assertThat(a).isNotEqualTo(GrowthCandidates.seed(MATCH, USER, "P011", 1));
        assertThat(a).isNotEqualTo(GrowthCandidates.seed(MATCH, "other-user", PLAYER, 1));
        assertThat(a).isNotEqualTo(GrowthCandidates.seed("legacy:", USER, PLAYER, 1));
    }

    // ── 계약 4: 감쇠 · 천장 제외 ─────────────────────────────────────────

    /** 높은 스탯의 gain 이 낮은 스탯의 gain 보다 작다(감쇠의 방향). */
    @Test
    void higherStatsEarnSmallerGains() {
        double low = onlyGainOf(flatStats(55.0));
        double mid = onlyGainOf(flatStats(70.0));
        double high = onlyGainOf(flatStats(83.0));
        assertThat(low).isGreaterThan(mid);
        assertThat(mid).isGreaterThan(high);
    }

    private double onlyGainOf(Map<String, Double> stats) {
        return drawAt(1, stats).choices().get(0).gain();
    }

    /**
     * <b>천장에 닿은 스탯은 후보에 없다</b>(+0 을 뽑는 죽은 선택지 방지, 설계 §2.3).
     * 한 스탯만 천장으로 밀고 전 레벨을 훑는다 — 어느 시드에서도 나오면 안 된다.
     */
    @Test
    void ceilingReachedStatsNeverAppearAsCandidates() {
        Map<String, Double> stats = flatStats(55.0);
        stats.put("shooting", 84.0);   // GOLD growCeil
        for (int level = 1; level <= 40; level++) {
            assertThat(drawAt(level, stats).choices().stream().map(GrowthCandidates.Choice::stat))
                    .as("level=%d", level)
                    .doesNotContain("shooting");
        }
    }

    /** 전 스탯이 천장이면 <b>선택권 자체를 만들지 않는다</b> — 빈 대기 뱃지는 지울 수 없다. */
    @Test
    void allStatsAtCeilingYieldsNoDrawAtAll() {
        assertThat(drawAt(1, flatStats(99.0)).isEmpty()).isTrue();
    }

    // ── 가중이 실제로 후보 분포를 움직인다 ───────────────────────────────

    /**
     * <b>어떤 스탯도 확률 0 이 아니다</b>({@code wBase}). 역할·활약이 한쪽으로 완전히 쏠려도
     * 나머지 스탯이 영원히 안 나오면 그건 3지선다가 아니라 지목이다.
     */
    @Test
    void everyStatCanStillAppearDespiteAStronglyTiltedRole() {
        Map<String, Double> stats = flatStats(55.0);
        Map<String, Double> eventScore = zero();
        eventScore.put("shooting", 100.0);   // 극단적으로 슈팅만 한 경기
        java.util.Set<String> seen = new java.util.HashSet<>();
        for (int level = 1; level <= 200; level++) {
            String seed = GrowthCandidates.seed(MATCH, USER, PLAYER, level);
            GrowthCandidates.draw(T, seed, "MF", "GOLD", 1, stats, eventScore, zero(), "WIN", 1)
                    .choices().forEach(c -> seen.add(c.stat()));
        }
        assertThat(seen).as("wBase 가 있는데도 안 나오는 스탯이 있다").hasSize(GrowthTuning.STATS.size());
    }

    /** 그래도 <b>기울기는 있다</b> — 슈팅만 한 경기에서 shooting 이 평균보다 자주 나온다. */
    @Test
    void aTiltedRoleActuallyRaisesThatStatsFrequency() {
        Map<String, Double> stats = flatStats(55.0);
        Map<String, Double> tilted = zero();
        tilted.put("shooting", 100.0);
        assertThat(frequency(stats, tilted, "shooting"))
                .as("활약 가중이 후보 분포를 못 움직이면 wEvents 는 소비되지 않는 노브다")
                .isGreaterThan(frequency(stats, zero(), "shooting"));
    }

    private int frequency(Map<String, Double> stats, Map<String, Double> eventScore, String stat) {
        int hits = 0;
        for (int level = 1; level <= 300; level++) {
            String seed = GrowthCandidates.seed(MATCH, USER, PLAYER, level);
            if (GrowthCandidates.draw(T, seed, "MF", "GOLD", 1, stats, eventScore, zero(), "WIN", 1)
                    .choices().stream().anyMatch(c -> c.stat().equals(stat))) {
                hits++;
            }
        }
        return hits;
    }
}
