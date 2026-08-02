package online.hmb.growth;

/**
 * <b>성장 계수 순수 함수</b>(에픽 #405 W2a) — 설계 §2.3(감쇠)·§2.4(XP)·§2.6(천장).
 *
 * <p>DB·RNG·시계가 없다. 전부 {@link GrowthTuning} 만 보고 답하므로 <b>계수를 바꾸면 답이 바뀐다</b>는
 * 사실이 그대로 계약이 된다(변이체 킬 — {@code decay.gainMax=0} 이면 상승폭 0,
 * {@code xp.maxLevel=1} 이면 레벨업 없음).
 *
 * <p>⚠️ 이 웨이브(W2a)는 <b>계수와 인프라</b>만 한다. 정산(카드 XP 적립)·3지선다 후보 생성이
 * 이 함수들을 소비하는 것은 W2b 다 — 여기서는 <b>같은 값을 두 곳이 다르게 계산하는 일이 없도록</b>
 * 공식의 자리를 먼저 하나로 고정해 둔다.
 */
public final class GrowthMath {

    private GrowthMath() {
    }

    /** 성장 천장(§2.6) = 등급 천장 + 승급 보너스. <b>승급 없이도 등급 천장까지 간다</b>(게이트 제거). */
    public static double ceiling(GrowthTuning tuning, String grade, int star) {
        GrowthTuning.Band band = band(tuning, grade);
        int bonus = tuning.star().ceilBonus().getOrDefault(star, 0);
        return Math.min(band.growCeil() + bonus, tuning.attrHardCap());
    }

    /** 등급 밴드. 모르는 등급은 <b>가장 좁은 해석</b>(전 구간)으로 — 클램프가 사라지는 쪽이 아니다. */
    public static GrowthTuning.Band band(GrowthTuning tuning, String grade) {
        GrowthTuning.Band band = tuning.bands().byGrade().get(grade);
        return band != null ? band : new GrowthTuning.Band(0, tuning.attrHardCap(), tuning.attrHardCap());
    }

    /**
     * 레벨업 1회의 상승폭(§2.3).
     *
     * <pre>
     *   r    = clamp((v − startLo) / (ceiling − startLo), 0, 1)
     *   gain = clamp(max(gainMin, gainMax × (1 − r)^decayPow − levelPenaltyPerLv × level),
     *                0, min(gainMax, ceiling − v))
     * </pre>
     *
     * <p><b>왜 {@code gainMin} 위에 상한을 한 번 더 씌우나</b>: 바닥값만 있으면
     * {@code gainMax = 0}(= "성장 끄기") 오버레이가 <b>바닥값 0.3 을 되살려</b> "API 는 200 인데
     * 반영은 안 됨"이 된다. 천장까지 남은 여백보다 크게 오르지 않는 것도 같은 이유로 여기서 자른다 —
     * 클램프를 호출부에 맡기면 호출부마다 다르게 자른다.
     */
    public static double gain(GrowthTuning tuning, String grade, int star, double current, int level) {
        GrowthTuning.Band band = band(tuning, grade);
        double ceiling = ceiling(tuning, grade, star);
        double span = ceiling - band.startLo();
        double ratio = span <= 0 ? 1.0 : clamp((current - band.startLo()) / span, 0.0, 1.0);
        GrowthTuning.Decay decay = tuning.decay();
        double raw = decay.gainMax() * Math.pow(1.0 - ratio, decay.decayPow())
                - decay.levelPenaltyPerLv() * level;
        double headroom = Math.max(0.0, ceiling - current);
        double upper = Math.max(0.0, Math.min(decay.gainMax(), headroom));
        return clamp(Math.max(decay.gainMin(), raw), 0.0, upper);
    }

    /** 다음 레벨까지 필요한 XP(§2.4) = round(lvBase × level^lvPow). level 은 1부터. */
    public static int xpToNext(GrowthTuning tuning, int level) {
        int effectiveLevel = Math.max(1, level);
        return (int) Math.max(1, Math.round(tuning.xp().lvBase() * Math.pow(effectiveLevel, tuning.xp().lvPow())));
    }

    /**
     * 경기 1회의 카드 XP(§2.4) =
     * {@code matchBase × minutesMult × resultMult × gradeMult × (1 + min(perfBonus, perfBonusCap))}.
     *
     * @param minutesKey {@code starter|partial|bench}
     * @param result     {@code WIN|DRAW|LOSS}
     * @param perfBonus  활약 보너스 원값(캡은 여기서 씌운다 — 호출부가 잊을 수 없게)
     */
    public static double matchXp(GrowthTuning tuning, String grade, String minutesKey, String result,
                                 double perfBonus) {
        GrowthTuning.Xp xp = tuning.xp();
        double minutes = xp.minutesMult().getOrDefault(minutesKey, 0.0);
        double resultMult = xp.resultMult().getOrDefault(result, 1.0);
        double gradeMult = xp.gradeMult().getOrDefault(grade, 1.0);
        double bonus = clamp(perfBonus, 0.0, xp.perfBonusCap());
        return xp.matchBase() * minutes * resultMult * gradeMult * (1.0 + bonus);
    }

    /** 카드 레벨 상태(레벨 1 부터, 만렙에서는 XP 를 쌓지 않는다). */
    public record LevelState(int level, int xp, int levelUps) {
    }

    /**
     * XP 적립 → 레벨업 계산(§2.4). <b>만렙에 닿으면 잉여 XP 는 버린다</b> — 남겨 두면 만렙 상한을
     * 나중에 올리는 순간 과거 잉여가 한꺼번에 터져 레벨이 폭증한다(그건 운영이 예측할 수 없는 변화다).
     */
    public static LevelState applyXp(GrowthTuning tuning, int level, int xp, double gained) {
        int maxLevel = Math.max(1, tuning.xp().maxLevel());
        int currentLevel = Math.max(1, level);
        if (currentLevel >= maxLevel) {
            return new LevelState(maxLevel, 0, 0);
        }
        long pool = Math.max(0, xp) + Math.round(Math.max(0.0, gained));
        int levelUps = 0;
        while (currentLevel < maxLevel && pool >= xpToNext(tuning, currentLevel)) {
            pool -= xpToNext(tuning, currentLevel);
            currentLevel++;
            levelUps++;
        }
        int remaining = currentLevel >= maxLevel ? 0 : (int) Math.min(Integer.MAX_VALUE, pool);
        return new LevelState(currentLevel, remaining, levelUps);
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }
}
