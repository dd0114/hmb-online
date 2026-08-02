package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.growth.GrowthCandidates;
import online.hmb.growth.GrowthMath;
import online.hmb.growth.GrowthTuning;
import org.junit.jupiter.api.Test;

/**
 * <b>"RUNTIME 인데 아무도 안 읽는 노브" 가드</b>(#405, AC-G0 의 진짜 구멍).
 *
 * <p>{@code GrowthTuningRegistryTest.everyKnobIsOverridable} 은 <b>값이 저장·병합되는 것</b>만
 * 증명한다. 그건 "admin API 가 200 을 준다"까지고, <b>그 값을 누가 읽는가</b>는 한 마디도 하지
 * 않는다. 실제로 {@code bands.<GRADE>.startHi} 가 정확히 그 구멍으로 빠져나갔다 — RUNTIME 으로
 * 표기된 채 런타임 소비자가 <b>0</b>이었고, 운영자가 그 값을 바꾸면 "적용됐다"는 응답을 받고도
 * 아무 일도 일어나지 않았다.
 *
 * <p><b>방식 = 순수함수 차등 프로브.</b> 성장 계수를 읽는 순수 함수 전부
 * ({@link GrowthMath} · {@link GrowthCandidates})를 <b>고정 격자</b>에 태워 지문을 만들고,
 * 노브 <b>하나만</b> 바꾼 tuning 의 지문과 비교한다. 하나라도 안 바뀌면 그 노브는 소비자가 없다.
 * {@code everyKnobIsOverridable} 과 모양이 같고 <b>대상만 다르다</b>(config 트리 → 소비자).
 *
 * <p><b>격자가 곧 커버리지</b>다. 등급 5 · 성 1~4 · 포지션 4 · 이벤트 16종 · behavior 9종 ·
 * 결과 3종을 전부 밟는다 — 하나라도 빠지면 그 축의 노브가 "소비자 없음"으로 <b>잘못</b> 잡히거나
 * (거짓 실패) 반대로 검사가 공허해진다.
 */
class GrowthConsumerGuardTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    /**
     * 순수 함수에 소비자가 <b>없는 것이 정상</b>인 노브. 항목마다 어디서 읽히는지 적는다 —
     * <b>이 목록이 길어지는 것 자체가 경고</b>다(순수 계산 밖으로 계수가 새고 있다는 뜻).
     * <ul>
     *   <li>{@code star.copies.*} — 승급 필요 중복 수. 서비스 레이어({@code GrowthService.starUp})가
     *       DB 보유 수와 비교해 쓰는 값이라 순수 계산에 자리가 없다.
     *       소비 계약 = {@code GrowthApiTest}/{@code GrowthServiceTest} 의 승급 경로.</li>
     *   <li>{@code legacy.levelGrantCap} — 소급 지급 상한. 부팅 1회 백필
     *       ({@code GrowthLegacyBackfillService})이 DB 를 훑으며 쓴다.
     *       소비 계약 = {@code GrowthLegacyBackfillTest}.</li>
     * </ul>
     */
    private static final Set<String> SERVICE_LAYER_ONLY = Set.of(
            "star.copies.2", "star.copies.3", "star.copies.4", "legacy.levelGrantCap");

    @Test
    void everyRuntimeKnobHasAConsumer() {
        GrowthTuning base = GrowthTuning.CODE_DEFAULTS;
        String baseline = fingerprint(base);
        List<String> orphans = new ArrayList<>();

        for (String path : GrowthTuning.knobsWithScope(GrowthTuning.KnobScope.RUNTIME)) {
            if (SERVICE_LAYER_ONLY.contains(path)) {
                continue;
            }
            GrowthTuning mutated = base.withOverrides(
                    Map.of(path, mutate(GrowthTuning.specs().get(path), base.valueAt(path, MAPPER))), MAPPER);
            if (fingerprint(mutated).equals(baseline)) {
                orphans.add(path);
            }
        }

        assertThat(orphans).as("""
                        RUNTIME 으로 표기됐는데 성장 계산이 읽지 않는 노브다. admin 이 바꾸면 200 을
                        받고도 아무 일도 일어나지 않는다 = 스코프 표기가 거짓이다.
                        셋 중 하나를 해라 — (1) 소비자를 붙인다 (2) 발행 시점 값이면 KnobScope.PUBLISH
                        로 옮긴다 (3) 서비스 레이어에서만 읽히면 SERVICE_LAYER_ONLY 에 **근거와 함께**
                        추가한다(그 목록이 길어지면 그 자체가 경고다).
                        """)
                .isEmpty();
    }

    /** 프로브가 실제로 무언가를 재고 있는가 — 지문이 상수면 위 검사가 통째로 공허해진다. */
    @Test
    void theFingerprintActuallyMovesWhenTuningMoves() {
        GrowthTuning base = GrowthTuning.CODE_DEFAULTS;
        assertThat(fingerprint(base)).isNotEqualTo(
                fingerprint(base.withOverrides(Map.of("decay.gainMax", 1.0), MAPPER)));
        assertThat(fingerprint(base)).hasSizeGreaterThan(1000);
    }

    /**
     * 발행 시점 노브는 이 프로브의 대상이 아니다 — <b>정의상</b> 런타임 소비자가 없다.
     * 그 사실을 여기서도 한 번 더 확인해 둔다(누가 소비자를 붙이면 스코프가 거짓이 된다).
     */
    @Test
    void publishScopedKnobsAreInvisibleToEveryPureFunction() {
        GrowthTuning base = GrowthTuning.CODE_DEFAULTS;
        String baseline = fingerprint(base);
        for (String path : GrowthTuning.knobsWithScope(GrowthTuning.KnobScope.PUBLISH)) {
            GrowthTuning mutated = base.withOverrides(
                    Map.of(path, mutate(GrowthTuning.specs().get(path), base.valueAt(path, MAPPER))), MAPPER);
            assertThat(fingerprint(mutated))
                    .as("%s 는 PUBLISH 로 표기됐는데 런타임 계산이 읽는다 — 표기가 거짓이다", path)
                    .isEqualTo(baseline);
        }
    }

    // ── 프로브 ──────────────────────────────────────────────────────────

    /** 성장 계수를 읽는 <b>순수 함수 전부</b>를 고정 격자에 태운 지문. */
    private static String fingerprint(GrowthTuning t) {
        StringBuilder sb = new StringBuilder();

        // ① GrowthMath — 천장·감쇠·유효스탯·XP 곡선
        for (String grade : GrowthTuning.GRADES) {
            for (int star : GrowthTuning.STAR_LEVELS) {
                sb.append(GrowthMath.ceiling(t, grade, star)).append(';');
                for (double v : new double[]{30, 45, 55, 70, 83, 94}) {
                    sb.append(GrowthMath.gain(t, grade, star, v, 1)).append(',');
                    sb.append(GrowthMath.gain(t, grade, star, v, 7)).append(',');
                }
            }
            for (String minutes : GrowthTuning.MINUTES_KEYS) {
                for (String result : GrowthTuning.RESULT_KEYS) {
                    sb.append(GrowthMath.matchXp(t, grade, minutes, result, 0.1)).append(',');
                    // perfBonus 를 캡 위로 넣어 perfBonusCap 자체가 관측되게 한다.
                    sb.append(GrowthMath.matchXp(t, grade, minutes, result, 5.0)).append(',');
                }
            }
        }
        // 잠재까지 얹은 최종 클램프 — attrHardCap 이 실제로 무는 조합을 반드시 포함한다.
        for (double pct : new double[]{0, 40, 200}) {
            sb.append(GrowthMath.effectiveStat(t, 90, 5, pct)).append(',');
        }
        for (int level : new int[]{1, 2, 5, 39, 40}) {
            sb.append(GrowthMath.xpToNext(t, level)).append(',');
            GrowthMath.LevelState s = GrowthMath.applyXp(t, level, 0, 100_000);
            sb.append(s.level()).append('/').append(s.xp()).append('/').append(s.levelUps()).append(',');
        }

        // ② GrowthCandidates — 이벤트·behavior·활약보너스·후보 추첨
        Map<String, Long> events = allEvents();
        Map<String, Double> behavior = allBehaviors();
        sb.append(GrowthCandidates.eventScore(t, events)).append(';');
        sb.append(GrowthCandidates.behaviorScore(t, behavior)).append(';');
        sb.append(GrowthCandidates.perfBonus(t, events)).append(';');
        sb.append(GrowthCandidates.perfBonus(t, scaled(events))).append(';');   // 캡이 무는 쪽

        Map<String, Double> eventScore = GrowthCandidates.eventScore(t, events);
        Map<String, Double> behaviorScore = GrowthCandidates.behaviorScore(t, behavior);
        for (String position : GrowthTuning.POSITIONS) {
            for (String result : new String[]{"WIN", "LOSS"}) {
                // 두 표본: 여유 있는 카드 / 일부 스탯이 천장에 닿은 카드(excludeAtCeiling 관측용)
                for (Map<String, Double> current : List.of(midCard(), ceilingCard(t))) {
                    // 시드를 여러 개 밟는다 — 가중이 조금 움직여도 어느 한 시드에서는 뽑기가 뒤집힌다.
                    for (int seed = 0; seed < 12; seed++) {
                        sb.append(GrowthCandidates.draw(t, "probe-" + seed, position, "GOLD", 1,
                                        current, eventScore, behaviorScore, result, 3,
                                        GrowthCandidates.Evidence.ofMatch(events, behavior))
                                .choices()).append('|');
                    }
                }
            }
        }
        return sb.toString();
    }

    private static Map<String, Long> allEvents() {
        Map<String, Long> out = new LinkedHashMap<>();
        long n = 1;
        for (String type : GrowthTuning.EVENT_TYPES) {
            out.put(type, n++);   // 서로 다른 횟수 — 한 타입의 가중 변화가 합에 묻히지 않게
        }
        return out;
    }

    private static Map<String, Long> scaled(Map<String, Long> events) {
        Map<String, Long> out = new LinkedHashMap<>();
        events.forEach((k, v) -> out.put(k, v * 50));
        return out;
    }

    private static Map<String, Double> allBehaviors() {
        Map<String, Double> out = new LinkedHashMap<>();
        double v = 0.15;
        for (String param : GrowthTuning.BEHAVIORS) {
            out.put(param, Math.min(1.0, v));
            v += 0.08;
        }
        return out;
    }

    private static Map<String, Double> midCard() {
        Map<String, Double> out = new LinkedHashMap<>();
        double v = 52.0;
        for (String stat : GrowthTuning.STATS) {
            out.put(stat, v);
            v += 1.5;
        }
        return out;
    }

    /** 절반은 천장에 닿아 있는 카드 — {@code excludeAtCeiling} 과 천장 관련 노브를 관측시킨다. */
    private static Map<String, Double> ceilingCard(GrowthTuning t) {
        double ceiling = GrowthMath.ceiling(t, "GOLD", 1);
        Map<String, Double> out = new LinkedHashMap<>();
        int i = 0;
        for (String stat : GrowthTuning.STATS) {
            out.put(stat, i++ % 2 == 0 ? ceiling : 55.0);
        }
        return out;
    }

    /** 스펙 범위 안에서 지금 값과 반드시 다른 값 — 레지스트리 계약과 같은 규칙이다. */
    private static Object mutate(GrowthTuning.Spec spec, Object before) {
        return switch (spec.type()) {
            case BOOL -> !(before instanceof Boolean b) || !b;
            case INT -> {
                long current = before instanceof Number n ? n.longValue() : (long) Math.max(spec.min(), 0);
                long up = current + 1;
                yield up <= spec.max() ? up : current - 1;
            }
            case DOUBLE -> {
                double current = before instanceof Number n ? n.doubleValue() : spec.min();
                double up = current + 0.25;
                yield up <= spec.max() ? up : current - 0.25;
            }
        };
    }
}
