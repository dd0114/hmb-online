package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.growth.GrowthTuning;
import org.junit.jupiter.api.Test;

/**
 * <b>AC-G0 집행</b>(#405, 설계 §2.8.2) — "새 계수 중 admin API 로 조정 불가한 것 0개"를 선언이 아니라
 * 기계로 지킨다. Spring 없이 도는 순수 계약이라 계수를 하나 추가할 때마다 즉시 답이 온다.
 *
 * <p>여기서 <b>기대값을 {@link GrowthTuning} 상수에서 다시 읽어오지 않는다</b>. 그렇게 쓰면 상수가
 * 바뀔 때 계약이 같이 따라가 아무것도 잡지 못한다 — 단언은 <b>구조적 항등식</b>("경로 P 를 덮으면
 * P 의 값이 그 값이 된다")이거나 <b>리터럴로 박은 설계값</b>이다.
 */
class GrowthTuningRegistryTest {

    private static final ObjectMapper MAPPER = new ObjectMapper();

    // ── 1. 모든 노브가 실제로 오버레이된다 ───────────────────────────────

    /**
     * {@code KNOBS} <b>전 경로</b>에 오버레이를 넣고 값이 실제로 바뀌는지 본다. 하나라도 안 바뀌면
     * FAIL — 그 노브는 "API 는 200 인데 반영은 안 되는" 노브다(이 기능이 만들 수 있는 최악의 상태).
     */
    @Test
    void everyKnobIsOverridable() {
        GrowthTuning base = GrowthTuning.CODE_DEFAULTS;
        List<String> notApplied = new ArrayList<>();
        List<String> unchanged = new ArrayList<>();

        for (String path : GrowthTuning.KNOBS) {
            Object before = base.valueAt(path, MAPPER);
            Object mutated = mutate(GrowthTuning.specs().get(path), before);
            GrowthTuning after = base.withOverrides(Map.of(path, mutated), MAPPER);
            Object actual = after.valueAt(path, MAPPER);

            if (!sameValue(actual, mutated)) {
                notApplied.add(path + " (넣은 값 " + mutated + " → 읽힌 값 " + actual + ")");
            } else if (sameValue(actual, before)) {
                unchanged.add(path);
            }
        }

        assertThat(GrowthTuning.KNOBS).as("레지스트리가 비면 이 검사가 공허해진다").isNotEmpty();
        assertThat(notApplied).as("오버레이가 반영되지 않는 노브 — admin API 가 200 을 주고도 값이 안 바뀐다")
                .isEmpty();
        assertThat(unchanged).as("변이값이 원래 값과 같아 검사가 공허해진 노브(테스트 결함)").isEmpty();
    }

    /** 한 경로를 덮어도 <b>다른 경로는 그대로</b>다 — 전체 교체가 아니라 경로 단위 병합이라는 계약. */
    @Test
    void overridingOneKnobLeavesTheRestAlone() {
        GrowthTuning base = GrowthTuning.CODE_DEFAULTS;
        GrowthTuning after = base.withOverrides(Map.of("bands.GOLD.growCeil", 70), MAPPER);

        assertThat(after.valueAt("bands.GOLD.growCeil", MAPPER)).isEqualTo(70);
        for (String path : GrowthTuning.KNOBS) {
            if (path.equals("bands.GOLD.growCeil")) {
                continue;
            }
            assertThat(sameValue(after.valueAt(path, MAPPER), base.valueAt(path, MAPPER)))
                    .as("경로 %s 가 같이 움직였다 — 병합이 아니라 재조립이 되고 있다", path)
                    .isTrue();
        }
    }

    /** 빈 오버레이 = 기본값 그대로(= 롤백의 정의). */
    @Test
    void emptyOverlayIsIdentity() {
        GrowthTuning base = GrowthTuning.CODE_DEFAULTS;
        assertThat(base.withOverrides(Map.of(), MAPPER)).isEqualTo(base);
    }

    // ── 2. 레지스트리를 빠져나가는 계수가 없다 ───────────────────────────

    /**
     * 레코드 트리를 리플렉션으로 훑어 {@code KNOBS} 미등재 잎이 있으면 FAIL.
     * <b>새 계수를 넣고 등록을 잊는 것</b>을 그 자리에서 막는다 — 등록되지 않은 계수는 곧
     * "배포해야만 바뀌는 값"이고 그게 AC-G0 위반이다.
     */
    @Test
    void noKnobEscapesRegistry() {
        List<String> leaves = GrowthTuning.CODE_DEFAULTS.leafPaths();
        assertThat(leaves).as("잎이 하나도 없으면 이 검사가 공허해진다").isNotEmpty();
        assertThat(GrowthTuning.KNOBS)
                .as("GrowthTuning 에는 있는데 KNOBS 에 없는 계수가 있다 — 그 값은 배포해야만 바뀐다")
                .containsAll(leaves);
    }

    /** 반대 방향 — 등록만 되고 트리에 자리가 없는 유령 경로가 없어야 한다(맵 노브는 예외). */
    @Test
    void registryHasNoDuplicatesAndEveryScalarKnobHasASpec() {
        assertThat(GrowthTuning.KNOBS).doesNotHaveDuplicates();
        for (String path : GrowthTuning.KNOBS) {
            GrowthTuning.Spec spec = GrowthTuning.specs().get(path);
            assertThat(spec).as("스펙 없는 노브: %s", path).isNotNull();
            assertThat(spec.scope()).as("효력 시점이 없는 노브: %s", path).isNotNull();
        }
    }

    /**
     * <b>발행 시점 노브는 카드 추첨에만 쓰이는 셋 뿐</b>이다 — 바이어스 둘 + <b>시작 밴드 상한</b>
     * ({@code startHi} × 5등급). 목록을 리터럴로 박는 이유: 새 계수를 무심코 {@code PUBLISH} 로 달면
     * "저장은 되는데 아무 일도 안 일어나는" 노브가 조용히 늘어난다 — 그 판단은 매번 명시적이어야
     * 한다(늘릴 땐 이 줄을 같이 고친다).
     *
     * <p>⚠️ {@code startHi} 는 원래 {@code RUNTIME} 이었는데 <b>런타임 소비자가 0</b>이었다
     * (독립검증). 카드 스탯 추첨은 발행 시점({@code data/players/generate.ts})에 끝나고, 런타임이
     * 읽는 밴드 값은 {@code startLo}(유효스탯 하한 클램프 + 감쇠 비율 {@code r} 의 분모)와
     * {@code growCeil} 뿐이다. 스코프 표기가 거짓이면 운영자는 "적용됐다"고 읽는다.
     * 그 구멍을 구조적으로 막는 것이 {@code GrowthConsumerGuardTest} 다.
     */
    @Test
    void onlyGenerationTimeKnobsArePublishScoped() {
        List<String> expectedPublish = new ArrayList<>(List.of("bands.primaryBias", "bands.traitBias"));
        for (String grade : GrowthTuning.GRADES) {
            expectedPublish.add("bands." + grade + ".startHi");
        }
        assertThat(GrowthTuning.knobsWithScope(GrowthTuning.KnobScope.PUBLISH))
                .containsExactlyInAnyOrderElementsOf(expectedPublish);
        assertThat(GrowthTuning.knobsWithScope(GrowthTuning.KnobScope.RUNTIME))
                .hasSize(GrowthTuning.KNOBS.size() - expectedPublish.size());
    }

    /** 문서 경로 ↔ 저장 경로 변환은 <b>짝</b>으로만 옳다 — 한쪽만 고치면 조용히 어긋난다. */
    @Test
    void knobPathAndJsonPathRoundTrip() {
        for (String path : GrowthTuning.KNOBS) {
            assertThat(GrowthTuning.toKnobPath(GrowthTuning.toJsonPath(path))).isEqualTo(path);
        }
        assertThat(GrowthTuning.toJsonPath("bands.GOLD.growCeil")).isEqualTo("bands.byGrade.GOLD.growCeil");
        assertThat(GrowthTuning.toJsonPath("bands.primaryBias")).isEqualTo("bands.primaryBias");
    }

    // ── 3. 설계값 앵커 (리터럴 고정) ─────────────────────────────────────

    /**
     * 설계 §2.2~§2.6 이 hero 컨펌으로 확정한 값들을 <b>리터럴로</b> 박는다. 상수에서 다시 읽어오면
     * 값이 바뀔 때 계약도 같이 따라가 아무 것도 못 잡는다 — 여기가 "기본값이 조용히 드리프트하지
     * 않는다"를 지키는 유일한 자리다. (값을 <b>의도적으로</b> 바꿀 땐 이 테스트도 같이 고친다.)
     */
    @Test
    void shippedDefaultsMatchTheConfirmedDesign() {
        GrowthTuning t = GrowthTuning.CODE_DEFAULTS;
        Map<String, Object> expected = new LinkedHashMap<>();
        expected.put("bands.BRONZE.startLo", 32);
        expected.put("bands.BRONZE.startHi", 42);
        expected.put("bands.BRONZE.growCeil", 72);
        expected.put("bands.SILVER.growCeil", 78);
        expected.put("bands.GOLD.startLo", 50);
        expected.put("bands.GOLD.growCeil", 84);
        expected.put("bands.DIA.growCeil", 90);
        expected.put("bands.LEGEND.startLo", 68);
        expected.put("bands.LEGEND.growCeil", 95);
        // ⚠️ 설계 표는 5/6 이지만 **발행물이 맞다**: W1 이 밴드 폭을 16→11 로 줄이며 비례 축소했다
        //    (5+6 = 폭 전체 → 주스탯∩trait 가 상한에 박혀 상수가 된다). 클램프 76.5% 로 v2.4 복원.
        expected.put("bands.primaryBias", 3);
        expected.put("bands.traitBias", 4);
        expected.put("attrHardCap", 99);
        // ⚠️ 설계 §2.3 의 4.0/1.4 를 **재보정**한 값이다(독립검증 BL-1) — 그 값으로는 §2.2 의
        //    "2단계 역전"이 OVR 축에서 세 쌍 전부 미달이었다. 근거는 GrowthTuning 의 주석과
        //    GrowthProgressionContractTest(관계식 계약).
        expected.put("decay.gainMax", 6.5);
        expected.put("decay.decayPow", 0.8);
        expected.put("decay.gainMin", 0.3);
        expected.put("decay.levelPenaltyPerLv", 0.0);
        expected.put("xp.matchBase", 100);
        expected.put("xp.resultMult.WIN", 1.2);
        expected.put("xp.resultMult.LOSS", 0.85);
        // ⚠️ 등급 배수는 economy 현행(레전드 3배)을 **뒤집은** 값이다(설계 Q5) — 승계하지 않는다.
        expected.put("xp.gradeMult.BRONZE", 1.3);
        expected.put("xp.gradeMult.LEGEND", 0.7);
        expected.put("xp.lvBase", 100);
        expected.put("xp.lvPow", 0.5);
        expected.put("xp.maxLevel", 40);
        expected.put("candidate.count", 3);
        expected.put("candidate.wBase", 1.0);
        expected.put("candidate.wPosition", 2.5);
        expected.put("candidate.wEvents", 2.0);
        expected.put("candidate.wBehavior", 2.0);
        expected.put("candidate.wResult", 0.5);
        expected.put("candidate.behaviorStatMap.shootTendency.shooting", 0.6);
        expected.put("candidate.excludeAtCeiling", true);
        expected.put("star.ceilBonus.1", 0);
        expected.put("star.ceilBonus.4", 3);
        expected.put("legacy.levelGrantCap", 39);

        for (Map.Entry<String, Object> e : expected.entrySet()) {
            assertThat(sameValue(t.valueAt(e.getKey(), MAPPER), e.getValue()))
                    .as("%s: 기대 %s / 실제 %s", e.getKey(), e.getValue(), t.valueAt(e.getKey(), MAPPER))
                    .isTrue();
        }
    }

    /** 죽은 이벤트 키({@code dribble})는 새 표에 없다 — 있으면 영원히 0 인 계수를 운영자가 만진다. */
    @Test
    void deadEventKeyIsGone() {
        assertThat(GrowthTuning.CODE_DEFAULTS.candidate().eventStatMap()).doesNotContainKey("dribble");
        assertThat(GrowthTuning.KNOBS).noneMatch(p -> p.contains(".dribble."));
        assertThat(GrowthTuning.CODE_DEFAULTS.candidate().eventStatMap()).containsKey("clearance");
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 스펙 범위 안에서 <b>지금 값과 반드시 다른</b> 값을 만든다. */
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

    private static boolean sameValue(Object a, Object b) {
        if (a instanceof Number x && b instanceof Number y) {
            return Double.compare(x.doubleValue(), y.doubleValue()) == 0;
        }
        return java.util.Objects.equals(a, b);
    }
}
