package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import online.hmb.match.OverhaulDetector;
import org.junit.jupiter.api.Test;

/**
 * 팀 지시 <b>대변경 감지</b> 지표 (#193 라운드2 라우팅).
 *
 * <p>지표 = 새 팀 지시가 언급하는 <b>서로 다른 전술 축의 개수</b>. 라운드2 맞대결에서 풀생성이 이긴 것은
 * <b>다축 대변경 K1</b> 하나(델타 3.13 vs 풀 4.75)뿐이고, 소변경 K2 는 <b>델타가 이겼다</b>(4.63 vs 3.25),
 * 돌발 3종(C1·C2·C3)도 델타 3.83~5.00 PASS. 이 다섯 문장은 <b>전부 old=""</b>(덱에 팀 지시가 없어
 * 매치 시점 지시가 신규 투입)라 어휘 유사도로는 구분 자체가 불가능했다 — K1 만 가르는 신호는
 * "얼마나 다른 낱말인가"가 아니라 <b>"몇 개의 축을 동시에 건드리는가"</b>다.
 *
 * <p>이 클래스는 그 <b>라운드2 실문장</b>들을 판정표로 박제한다. 지표를 바꾸면 여기서 먼저 깨진다.
 */
class OverhaulDetectorTest {

    /** 기본 임계(application.yml `hmb.match.delta.overhaul-axis-count`)와 같은 값 — 라우팅 판정 재현용. */
    private static final int DEFAULT_MIN_AXES = 3;

    // ── 라운드2 실문장 (판정표) ─────────────────────────────────────────────

    /** K1 = 다축 대변경. 풀생성 4.75 > 델타 3.13 — 유일하게 라우팅해야 하는 케이스. */
    private static final String K1 =
            "완전히 바꾼다. 초공격 전방압박, 라인 최대로 올리고 전원 압박. 풀백 오버랩 적극.";

    /** K2 = 한 축만 손보는 소변경. 델타 4.63 > 풀생성 3.25 — 라우팅하면 <b>품질이 떨어진다</b>. */
    private static final String K2 = "템포만 조금 올려라. 나머지는 유지.";

    /** C1 = 돌발(빈 지시). 축 0. */
    private static final String C1 = "아무것도 하지 마.";

    /** C2 = 돌발(비전술 어휘). 카탈로그 축에 안 걸린다. */
    private static final String C2 = "전원 무조건 앞으로 뛰쳐나가.";

    /** C3 = 돌발(개인 마킹 1축). */
    private static final String C3 = "상대 10번만 막아. 나머지는 신경 쓰지 마.";

    /** 라운드2 이전 하네스의 "수비 전환" 시나리오 — 다축이므로 대변경으로 잡혀야 한다. */
    private static final String DEFENSIVE_SWITCH =
            "수비적으로 전환. 라인 내리고 콤팩트하게, 역습 시 측면 빠르게";

    @Test
    void k1IsAMultiAxisOverhaul() {
        assertThat(OverhaulDetector.axes(K1)).containsExactlyInAnyOrder("press", "line", "overlap");
        assertThat(OverhaulDetector.isOverhaul(K1, DEFAULT_MIN_AXES)).isTrue();
    }

    @Test
    void k2TouchesOnlyTempoAndStaysOnTheDelta() {
        assertThat(OverhaulDetector.axes(K2)).containsExactly("tempo");
        assertThat(OverhaulDetector.isOverhaul(K2, DEFAULT_MIN_AXES)).isFalse();
    }

    /** 돌발 3종은 축이 0~1 — 전부 델타 유지(라운드2에서 델타가 PASS 했다). */
    @Test
    void surpriseInstructionsStayOnTheDelta() {
        assertThat(OverhaulDetector.axes(C1)).isEmpty();
        assertThat(OverhaulDetector.axes(C2)).isEmpty();
        assertThat(OverhaulDetector.axes(C3)).containsExactly("marking");

        assertThat(OverhaulDetector.isOverhaul(C1, DEFAULT_MIN_AXES)).isFalse();
        assertThat(OverhaulDetector.isOverhaul(C2, DEFAULT_MIN_AXES)).isFalse();
        assertThat(OverhaulDetector.isOverhaul(C3, DEFAULT_MIN_AXES)).isFalse();
    }

    @Test
    void defensiveSwitchIsAlsoAnOverhaul() {
        assertThat(OverhaulDetector.axes(DEFENSIVE_SWITCH))
                .containsExactlyInAnyOrder("line", "compact", "width");
        assertThat(OverhaulDetector.isOverhaul(DEFENSIVE_SWITCH, DEFAULT_MIN_AXES)).isTrue();
    }

    /** 판정표 전체를 한 번에 — 기본 임계에서 대변경은 K1·수비전환 둘뿐이다. */
    @Test
    void roundTwoVerdictTable() {
        assertThat(OverhaulDetector.axisCount(K1)).isEqualTo(3);
        assertThat(OverhaulDetector.axisCount(K2)).isEqualTo(1);
        assertThat(OverhaulDetector.axisCount(C1)).isEqualTo(0);
        assertThat(OverhaulDetector.axisCount(C2)).isEqualTo(0);
        assertThat(OverhaulDetector.axisCount(C3)).isEqualTo(1);
        assertThat(OverhaulDetector.axisCount(DEFENSIVE_SWITCH)).isEqualTo(3);
    }

    // ── 지표 자체의 성질 ──────────────────────────────────────────────────

    /** 한국어는 조사·어미가 붙는다 — 토큰 일치가 아니라 부분 문자열이라야 축이 잡힌다. */
    @Test
    void keywordsMatchInsideInflectedWords() {
        assertThat(OverhaulDetector.axes("전방압박을 강하게")).containsExactly("press");
        assertThat(OverhaulDetector.axes("라인은 올려라")).containsExactly("line");
        assertThat(OverhaulDetector.axes("슛보다 확실한 각")).containsExactly("shoot");
    }

    /** 같은 축을 몇 번 강조하든 1 — <b>반복 강도</b>가 아니라 <b>변경의 폭</b>을 재는 지표다. */
    @Test
    void repeatedMentionsOfOneAxisCountOnce() {
        assertThat(OverhaulDetector.axisCount("압박 압박 또 압박, 프레스 프레싱")).isEqualTo(1);
        assertThat(OverhaulDetector.isOverhaul("압박 압박 또 압박, 프레스 프레싱", DEFAULT_MIN_AXES)).isFalse();
    }

    /** 한 글자 키워드를 쓰지 않는 이유 — 무관한 낱말에 걸려 축을 헛세지 않는다. */
    @Test
    void unrelatedWordsDoNotTriggerAxes() {
        assertThat(OverhaulDetector.axes("그런 식으로 폭발적으로 해봐")).isEmpty(); // "런"·"폭" 오탐 없음
        assertThat(OverhaulDetector.axes("하지 마")).isEmpty();                     // "마"≠"마크"
    }

    @Test
    void nullAndBlankHaveNoAxes() {
        assertThat(OverhaulDetector.axes(null)).isEmpty();
        assertThat(OverhaulDetector.axes("   ")).isEmpty();
        assertThat(OverhaulDetector.isOverhaul(null, DEFAULT_MIN_AXES)).isFalse();
    }

    /**
     * 임계는 <b>단조</b>롭다: 클수록 엄격. 축 개수보다 큰 값이면 아무것도 안 걸리고(=라우팅만 끄기),
     * 0 이면 전부 걸린다(=항상 풀생성, 반대편 A/B).
     */
    @Test
    void thresholdIsInclusiveAndMonotone() {
        assertThat(OverhaulDetector.isOverhaul(K1, 3)).isTrue();   // 경계 포함(3축 ≥ 3)
        assertThat(OverhaulDetector.isOverhaul(K1, 4)).isFalse();
        assertThat(OverhaulDetector.isOverhaul(K2, 1)).isTrue();   // 임계를 낮추면 소변경도 걸린다
        assertThat(OverhaulDetector.isOverhaul(K1, 99)).isFalse(); // 라우팅 off
        assertThat(OverhaulDetector.isOverhaul(C1, 0)).isTrue();   // 전부 라우팅
    }

    /**
     * 축 카탈로그는 지시 카탈로그({@code packages/server/src/prompt/directives/})의 축을 <b>전부</b>
     * 덮어야 한다 — 카탈로그에 있는 지시를 감지기가 못 보면 라우팅이 그 축을 영영 놓친다.
     */
    @Test
    void everyDirectiveCatalogAxisIsRepresented() {
        assertThat(OverhaulDetector.axes("전방부터 강하게 압박")).contains("press");        // press-trigger
        assertThat(OverhaulDetector.axes("하이라인에 빠른 템포")).contains("line", "tempo"); // tempo-control
        assertThat(OverhaulDetector.axes("양쪽 풀백 적극적으로 오버랩")).contains("overlap"); // overlap
        assertThat(OverhaulDetector.axes("9번 계속 뒷공간 침투")).contains("run");           // forward-run
        assertThat(OverhaulDetector.axes("빌드업 생략하고 롱볼로 빠르게")).contains("pass");  // long-ball
        assertThat(OverhaulDetector.axes("메시랑 음바페 둘 다 마크해")).contains("marking");  // marking
    }
}
