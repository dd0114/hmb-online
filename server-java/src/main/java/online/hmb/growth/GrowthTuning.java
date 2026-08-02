package online.hmb.growth;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.lang.reflect.RecordComponent;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.catalog.EconomyService;

/**
 * <b>성장 계수의 유일한 SoT</b>(에픽 #405 W2a) — 설계 SoT = {@code docs/plan-v5/growth-redesign.md} §2.8.
 *
 * <p><b>AC-G0</b>: 이 개편이 만드는 계수 중 admin API 로 조정 불가한 것이 <b>0개</b>여야 한다.
 * 그 AC 를 선언이 아니라 <b>기계</b>로 지키는 장치가 이 클래스의 {@link #KNOBS} 다:
 * <ul>
 *   <li>{@code KNOBS} = 오버레이 가능한 <b>경로 전수</b>. 맵형 노브도 키 집합이 유한하므로
 *       (등급 5 · 스탯 9 · 포지션 4 · behavior 9 · 이벤트 16 · 성 1~4) <b>전개해서</b> 열거한다 —
 *       "맵이니까 알아서 되겠지"는 검증할 수 없는 문장이라 계약이 되지 못한다.</li>
 *   <li>{@code GrowthTuningRegistryTest.everyKnobIsOverridable} 이 <b>모든 경로</b>에 실제로
 *       오버레이를 넣어 값이 바뀌는지 확인한다(하나라도 안 바뀌면 FAIL).</li>
 *   <li>{@code GrowthTuningRegistryTest.noKnobEscapesRegistry} 가 이 레코드 트리를 리플렉션으로 훑어
 *       {@code KNOBS} 미등재 잎이 있으면 FAIL 한다 — <b>새 계수를 추가하고 등록을 잊는 것</b>을 막는다.</li>
 * </ul>
 *
 * <p><b>기본값의 출처는 둘</b>이다:
 * <ul>
 *   <li><b>발행물 승계</b>({@link #defaults(EconomyService.Growth, EconomyService.Star)}) —
 *       {@code positionBaseline}(economy.growth.baselineByPosition) · {@code star.copies}(economy.star.copies) ·
 *       {@code xp.minutesMult}(economy.growth.minutesMult). 설계 §2.8.1 이 "현행 승계"로 표시한 항목이다.</li>
 *   <li><b>코드 기본값</b>({@link #CODE_DEFAULTS}) — 설계 §2.8.1 표에 새 값이 적힌 나머지 전부.
 *       ⚠️ 특히 {@code xp.gradeMult} 는 economy 의 현행값(레전드 3배)을 <b>승계하지 않는다</b> —
 *       설계 Q5 가 그 곡선을 뒤집는 것이 개편의 내용이기 때문이다.</li>
 * </ul>
 * 승계 항목도 발행물이 비어 있으면 코드 기본값이 남는다(이 리포의 last-known-good 폴백층 관례,
 * {@code EconomyService.DEFAULT_LEAGUE_GEM_REWARD} 와 같은 이유 — override 가 깔린 환경에서만
 * 조용히 값이 사라지는 사고를 막는다).
 *
 * <p><b>경로 표기 ↔ 저장 구조</b>: 문서·API 의 경로는 {@code bands.GOLD.growCeil} 인데 레코드는
 * {@code Bands(byGrade, primaryBias, traitBias)} 라 JSON 상으로는 {@code bands.byGrade.GOLD.growCeil} 이다.
 * 등급 이름과 {@code primaryBias}/{@code traitBias} 가 한 노드에 공존해야 해서 생긴 한 칸의 차이이고,
 * {@link #toJsonPath(String)}/{@link #toKnobPath(String)} <b>한 쌍</b>에만 그 사실이 적혀 있다.
 */
public record GrowthTuning(
        Bands bands,
        int attrHardCap,
        Decay decay,
        Xp xp,
        Candidate candidate,
        Map<String, Map<String, Double>> positionBaseline,
        Star star,
        Legacy legacy) {

    /** 시작 밴드 + 성장 천장(§2.2). {@code byGrade} 는 경로에서 한 칸이 생략된다 — 클래스 javadoc 참조. */
    public record Bands(Map<String, Band> byGrade, int primaryBias, int traitBias) {
    }

    /** 한 등급의 밴드 — 시작값 추첨 구간 [startLo, startHi] + 성장 천장 growCeil. */
    public record Band(int startLo, int startHi, int growCeil) {
    }

    /** 감쇠 곡선(§2.3) — 레벨업 1회당 상승폭. */
    public record Decay(double gainMax, double decayPow, double gainMin, double levelPenaltyPerLv) {
    }

    /** 경험치 곡선(§2.4). */
    public record Xp(int matchBase, Map<String, Double> minutesMult, Map<String, Double> resultMult,
                     Map<String, Double> gradeMult, double perfBonusCap,
                     Map<String, Double> perfEventWeight, int lvBase, double lvPow, int maxLevel) {
    }

    /** 3지선다 후보 추첨(§2.5). */
    public record Candidate(int count, double wBase, double wPosition, double wEvents, double wBehavior,
                            double wResult, Map<String, Map<String, Double>> behaviorStatMap,
                            Map<String, Map<String, Double>> eventStatMap,
                            Map<String, Double> resultTilt, boolean excludeAtCeiling) {
    }

    /** 승급(§2.6) — 잠재 해금은 그대로, 천장은 <b>보너스</b>로만 관여한다(게이트 아님). */
    public record Star(Map<Integer, Integer> ceilBonus, Map<Integer, Integer> copies) {
    }

    /** 라이브 이관(§2.7) — 소급 지급 상한. */
    public record Legacy(int levelGrantCap) {
    }

    // ── 유한 키 집합 (경로 전개의 근거) ───────────────────────────────────

    public static final List<String> GRADES = List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND");

    /** shared PlayerAttributes 9종 — 순서 고정(직렬화·반복 안정). */
    public static final List<String> STATS = List.of(
            "technical", "mental", "physical", "passing", "shooting",
            "tackling", "pace", "stamina", "positioning");

    public static final List<String> POSITIONS = List.of("FW", "MF", "DF", "GK");

    /** shared {@code PlayerBehavior} 9 파라미터 — 프롬프트가 AI 를 거쳐 변환된 실제 시뮬 입력. */
    public static final List<String> BEHAVIORS = List.of(
            "positioningFreedom", "forwardRunFreq", "widthTendency", "supportDepth",
            "pressAggression", "passRisk", "passDirectness", "dribbleTendency", "shootTendency");

    /** shared {@code MatchEventType} 전수. 일부는 가중 0 이지만 <b>열거는 전수</b>여야 조정 가능하다. */
    public static final List<String> EVENT_TYPES = List.of(
            "kickoff", "pass", "interception", "tackle", "clearance", "shot", "goal", "save",
            "foul", "offside", "free_kick", "penalty", "card", "substitution",
            "half_whistle", "full_whistle");

    public static final List<Integer> STAR_LEVELS = List.of(1, 2, 3, 4);
    /** 승급 필요 중복은 "그 성이 되기 위해" 필요한 수라 1★ 이 없다. */
    public static final List<Integer> COPY_STAR_LEVELS = List.of(2, 3, 4);
    public static final List<String> MINUTES_KEYS = List.of("starter", "partial", "bench");
    public static final List<String> RESULT_KEYS = List.of("WIN", "DRAW", "LOSS");

    // ── 코드 기본값 ─────────────────────────────────────────────────────

    private static Map<String, Band> defaultBands() {
        Map<String, Band> m = new LinkedHashMap<>();
        m.put("BRONZE", new Band(32, 42, 72));
        m.put("SILVER", new Band(41, 51, 78));
        m.put("GOLD", new Band(50, 60, 84));
        m.put("DIA", new Band(59, 69, 90));
        m.put("LEGEND", new Band(68, 78, 95));
        return Map.copyOf(m);
    }

    /**
     * behavior → 스탯 매핑(§2.5 표). <b>프롬프트를 키워드 매칭하지 않는다</b> — 프롬프트는 AI 가 이미
     * {@code PlayerBehavior} 9 파라미터로 변환해 {@code match_halves.*_input_json} 에 박제해 두었고,
     * 그 값을 쓰면 ①"맡은 역할대로 성장한다"가 문자열이 아니라 실제 시뮬 입력으로 성립하고
     * ②언어·오타·장난 프롬프트에 안 흔들리며 ③결정론이 유지된다.
     */
    private static Map<String, Map<String, Double>> defaultBehaviorStatMap() {
        Map<String, Map<String, Double>> m = new LinkedHashMap<>();
        m.put("shootTendency", Map.of("shooting", 0.6, "positioning", 0.2));
        m.put("passRisk", Map.of("passing", 0.5, "technical", 0.3));
        m.put("passDirectness", Map.of("passing", 0.5, "technical", 0.3));
        m.put("dribbleTendency", Map.of("technical", 0.5, "pace", 0.3));
        m.put("pressAggression", Map.of("tackling", 0.5, "stamina", 0.3));
        m.put("forwardRunFreq", Map.of("pace", 0.4, "stamina", 0.3, "positioning", 0.2));
        m.put("widthTendency", Map.of("pace", 0.4, "stamina", 0.3));
        m.put("supportDepth", Map.of("positioning", 0.4, "mental", 0.3));
        m.put("positioningFreedom", Map.of("mental", 0.4, "positioning", 0.3));
        return Map.copyOf(m);
    }

    /**
     * 이벤트 → 스탯 매핑. 현행 {@code economy.growth.eventStatMap} 을 옮기되 <b>죽은 키 {@code dribble}
     * 을 뺐다</b>(shared {@code MatchEventType} 에 없는 타입이라 영원히 0 이었다) — 설계 §2.5.
     * {@code clearance}(#314 A 로 신설된 실제 이벤트)·{@code foul}·{@code card} 를 더한다.
     */
    private static Map<String, Map<String, Double>> defaultEventStatMap() {
        Map<String, Map<String, Double>> m = new LinkedHashMap<>();
        m.put("goal", Map.of("shooting", 0.3, "positioning", 0.1));
        m.put("shot", Map.of("shooting", 0.2, "positioning", 0.1));
        m.put("pass", Map.of("passing", 0.2, "technical", 0.1));
        m.put("interception", Map.of("tackling", 0.2, "positioning", 0.1));
        m.put("tackle", Map.of("tackling", 0.2, "physical", 0.1));
        m.put("save", Map.of("positioning", 0.3, "mental", 0.1));
        m.put("clearance", Map.of("tackling", 0.15, "physical", 0.1));
        m.put("foul", Map.of("tackling", 0.1, "mental", 0.05));
        m.put("card", Map.of("mental", 0.1));
        return Map.copyOf(m);
    }

    /**
     * 활약 보너스 가중(§2.4 {@code perfBonus}). ⚠️ 설계가 값 표를 남기지 않은 항목이라 이 값들은
     * <b>여기서 정한 첫 기본값</b>이다 — 무배포 조정 대상이므로 실플레이 후 언제든 바뀐다.
     * 파울·카드가 음수인 것은 "활약"의 정의상 의도적이며, 합은 {@code perfBonusCap} 으로 잘린다.
     */
    private static Map<String, Double> defaultPerfEventWeight() {
        Map<String, Double> m = new LinkedHashMap<>();
        m.put("goal", 0.15);
        m.put("save", 0.10);
        m.put("shot", 0.03);
        m.put("tackle", 0.02);
        m.put("interception", 0.02);
        m.put("clearance", 0.01);
        m.put("pass", 0.002);
        m.put("foul", -0.02);
        m.put("card", -0.05);
        return Map.copyOf(m);
    }

    /**
     * 승리 가중(§2.5 {@code wResult × (WIN ? resultTilt_i : 0)}). ⚠️ 설계가 <b>이 벡터의 값 표를
     * 남기지 않았다</b> — {@code perfEventWeight} 와 같은 자리이므로 <b>여기서 정하는 첫 기본값</b>이고,
     * 무배포 조정 대상이라 실플레이 후 언제든 바뀐다.
     *
     * <p>왜 정신력 쪽인가: 승패는 <b>역할과 무관한</b> 축이다. 이긴 경기라고 슈팅·태클이 더 나와야 할
     * 이유는 없고(그건 이미 {@code eventScore}·{@code behaviorScore} 가 본다), 승리가 말해 주는 건
     * "이 선수가 이기는 경기를 버텼다"에 가깝다. 그래서 역할 축과 겹치지 않는 mental/positioning/stamina
     * 로만 기울인다 — 겹치게 두면 {@code wResult} 가 사실상 {@code wPosition} 의 배수가 되어
     * <b>노브 하나가 다른 노브의 그림자</b>가 된다(운영자가 조정할 수 없는 상태).
     */
    private static Map<String, Double> defaultResultTilt() {
        Map<String, Double> m = new LinkedHashMap<>();
        m.put("mental", 1.0);
        m.put("positioning", 0.4);
        m.put("stamina", 0.2);
        return Map.copyOf(m);
    }

    /**
     * 포지션 baseline 폴백 — 발행물({@code economy.growth.baselineByPosition})이 이기고, 없는 포지션만
     * 이 값이 메운다. 발행물에 실린 뒤에도 지우지 않는다(last-known-good 층).
     */
    private static Map<String, Map<String, Double>> defaultPositionBaseline() {
        Map<String, Map<String, Double>> m = new LinkedHashMap<>();
        m.put("FW", baseline(0.13, 0.05, 0.07, 0.10, 0.22, 0.02, 0.18, 0.08, 0.15));
        m.put("MF", baseline(0.16, 0.10, 0.04, 0.20, 0.08, 0.06, 0.10, 0.14, 0.12));
        m.put("DF", baseline(0.04, 0.12, 0.15, 0.10, 0.02, 0.22, 0.08, 0.09, 0.18));
        m.put("GK", baseline(0.04, 0.20, 0.14, 0.10, 0.02, 0.12, 0.06, 0.08, 0.24));
        return Map.copyOf(m);
    }

    /** STATS 순서대로 받는다 — 인자 순서가 곧 스탯 순서라 표가 세로로 정렬돼 읽힌다. */
    private static Map<String, Double> baseline(double technical, double mental, double physical,
                                                double passing, double shooting, double tackling,
                                                double pace, double stamina, double positioning) {
        Map<String, Double> m = new LinkedHashMap<>();
        m.put("technical", technical);
        m.put("mental", mental);
        m.put("physical", physical);
        m.put("passing", passing);
        m.put("shooting", shooting);
        m.put("tackling", tackling);
        m.put("pace", pace);
        m.put("stamina", stamina);
        m.put("positioning", positioning);
        return Map.copyOf(m);
    }

    /**
     * <b>순수 코드 기본값</b> — 발행물 승계 <b>전</b>의 값. 레지스트리 계약이 이 인스턴스를 훑으므로
     * 모든 열거 키가 실제로 채워져 있어야 한다(빈 맵이면 "잎이 없어서" 계약이 공허하게 통과한다).
     */
    public static final GrowthTuning CODE_DEFAULTS = new GrowthTuning(
            // ⚠️ primaryBias 3 · traitBias 4 — <b>설계 §2.8.1 표(5/6)가 아니라 실제 발행물</b>이다.
            // W1 이 players.v2.5 를 발행하며 밴드 폭을 16 → 11 로 줄였고, 5+6 = 11 = 폭 전체가 되면
            // 주스탯∩trait 스탯이 170/170(100%) 상한에 박혀 <b>롤과 무관한 상수</b>가 된다(카드 개성
            // 소실). 폭에 비례해 축소한 +3/+4 가 v2.4 의 특성을 복원한다 — 교집합 클램프 76.5%
            // (v2.4 79.4%) · 전체 23.6%(21.9%). 표가 낡았고 발행물이 맞다.
            new Bands(defaultBands(), 3, 4),
            99,
            new Decay(4.0, 1.4, 0.3, 0.0),
            new Xp(100,
                    Map.of("starter", 1.0, "partial", 0.5, "bench", 0.0),
                    Map.of("WIN", 1.2, "DRAW", 1.0, "LOSS", 0.85),
                    Map.of("BRONZE", 1.3, "SILVER", 1.2, "GOLD", 1.0, "DIA", 0.85, "LEGEND", 0.7),
                    0.5, defaultPerfEventWeight(), 100, 0.5, 40),
            new Candidate(3, 1.0, 2.5, 2.0, 2.0, 0.5,
                    defaultBehaviorStatMap(), defaultEventStatMap(), defaultResultTilt(), true),
            defaultPositionBaseline(),
            new Star(Map.of(1, 0, 2, 1, 3, 2, 4, 3), Map.of(2, 2, 3, 3, 4, 5)),
            new Legacy(39));

    /**
     * 발행물 승계 기본값. 설계 §2.8.1 이 "현행 승계"로 표시한 세 항목만 economy 가 이긴다 —
     * 나머지를 승계하면 <b>개편이 바꾸려던 곡선</b>(특히 {@code xp.gradeMult})이 그대로 남는다.
     *
     * <p>승계는 <b>1단계 키 단위</b>다: economy 가 준 포지션·성 키만 덮고 나머지는 코드값이 남는다.
     * 통짜 교체로 하면 발행물이 키 하나를 빠뜨렸을 때 그 항목이 조용히 사라진다.
     */
    public static GrowthTuning defaults(EconomyService.Growth growth, EconomyService.Star star) {
        GrowthTuning t = CODE_DEFAULTS;
        Map<String, Map<String, Double>> baselines = new LinkedHashMap<>(t.positionBaseline());
        Map<String, Double> minutes = new LinkedHashMap<>(t.xp().minutesMult());
        Map<Integer, Integer> copies = new LinkedHashMap<>(t.star().copies());
        if (growth != null) {
            if (growth.baselineByPosition() != null) {
                growth.baselineByPosition().forEach((pos, weights) -> {
                    if (weights != null && !weights.isEmpty()) {
                        baselines.put(pos, Map.copyOf(weights));
                    }
                });
            }
            if (growth.minutesMult() != null) {
                growth.minutesMult().forEach(minutes::put);
            }
        }
        if (star != null && star.copies() != null) {
            star.copies().forEach(copies::put);
        }
        return new GrowthTuning(t.bands(), t.attrHardCap(), t.decay(),
                new Xp(t.xp().matchBase(), Map.copyOf(minutes), t.xp().resultMult(), t.xp().gradeMult(),
                        t.xp().perfBonusCap(), t.xp().perfEventWeight(), t.xp().lvBase(), t.xp().lvPow(),
                        t.xp().maxLevel()),
                t.candidate(), Map.copyOf(baselines),
                new Star(t.star().ceilBonus(), Map.copyOf(copies)), t.legacy());
    }

    // ── 레지스트리 ──────────────────────────────────────────────────────

    /** 노브의 값 종류. 검증이 "200 인데 반영 안 됨"을 만들지 않으려면 타입을 먼저 본다. */
    public enum KnobType { INT, DOUBLE, BOOL }

    /**
     * <b>이 노브가 언제 효력을 갖는가.</b> 오버레이는 전부 저장·병합되지만, 그것이 곧 "지금 값이
     * 바뀐다"는 뜻은 아니다 — 그 차이를 표기하지 않으면 API 가 200 을 주고도 아무 일도 일어나지 않는
     * 노브가 생기고, 그건 이 기능이 만들 수 있는 가장 나쁜 거짓말이다.
     *
     * <ul>
     *   <li>{@code RUNTIME} — 서버 계산에 즉시(다음 조회·정산부터) 반영된다.</li>
     *   <li>{@code PUBLISH} — <b>카드 발행 시점</b>에만 쓰인다({@code data/players/generate.ts}).
     *       이미 발행된 카드의 스탯은 {@code players.v*.json} 산출물이라 바뀌지 않는다.
     *       지금은 발행 파이프라인이 이 값을 읽지 않으므로(발행물에 이미 구워져 있다) 실질적으로
     *       <b>#412(어드민 선수 등록·기본 스탯 API)가 승계할 인터페이스</b>다.</li>
     * </ul>
     */
    public enum KnobScope { RUNTIME, PUBLISH }

    /**
     * 노브 1개의 계약 — 경로·타입·허용 범위·효력 시점. 범위는 "이 값이면 게임이 성립한다"가 아니라
     * <b>명백한 오타를 막는 울타리</b>다(계수 튜닝의 자유도를 좁히지 않는다).
     */
    public record Spec(String path, KnobType type, double min, double max, KnobScope scope) {
    }

    private static final Map<String, Spec> SPECS = buildSpecs();

    /** 오버레이 가능한 경로 <b>전수</b>. 순서 고정(문서·API 출력 안정). */
    public static final List<String> KNOBS = List.copyOf(SPECS.keySet());

    public static Map<String, Spec> specs() {
        return SPECS;
    }

    private static Map<String, Spec> buildSpecs() {
        Map<String, Spec> m = new LinkedHashMap<>();
        // 1~3 밴드 (등급별 시작 하한·상한·성장 천장)
        for (String grade : GRADES) {
            put(m, "bands." + grade + ".startLo", KnobType.INT, 1, 99);
            put(m, "bands." + grade + ".startHi", KnobType.INT, 1, 99);
            put(m, "bands." + grade + ".growCeil", KnobType.INT, 1, 99);
        }
        // 4~5 발행 시점 바이어스 — RUNTIME 이 아니다(카드 스탯은 발행물에 이미 구워져 있다).
        put(m, "bands.primaryBias", KnobType.INT, 0, 50, KnobScope.PUBLISH);
        put(m, "bands.traitBias", KnobType.INT, 0, 50, KnobScope.PUBLISH);
        // 6
        put(m, "attrHardCap", KnobType.INT, 1, 99);
        // 7~10 감쇠
        put(m, "decay.gainMax", KnobType.DOUBLE, 0, 50);
        put(m, "decay.decayPow", KnobType.DOUBLE, 0, 10);
        put(m, "decay.gainMin", KnobType.DOUBLE, 0, 50);
        put(m, "decay.levelPenaltyPerLv", KnobType.DOUBLE, 0, 10);
        // 11~19 XP
        put(m, "xp.matchBase", KnobType.INT, 0, 1_000_000);
        for (String k : MINUTES_KEYS) {
            put(m, "xp.minutesMult." + k, KnobType.DOUBLE, 0, 10);
        }
        for (String k : RESULT_KEYS) {
            put(m, "xp.resultMult." + k, KnobType.DOUBLE, 0, 10);
        }
        for (String grade : GRADES) {
            put(m, "xp.gradeMult." + grade, KnobType.DOUBLE, 0, 10);
        }
        put(m, "xp.perfBonusCap", KnobType.DOUBLE, 0, 10);
        for (String ev : EVENT_TYPES) {
            put(m, "xp.perfEventWeight." + ev, KnobType.DOUBLE, -10, 10);
        }
        put(m, "xp.lvBase", KnobType.INT, 1, 1_000_000);
        put(m, "xp.lvPow", KnobType.DOUBLE, 0, 5);
        put(m, "xp.maxLevel", KnobType.INT, 1, 999);
        // 20~28 후보 추첨
        put(m, "candidate.count", KnobType.INT, 1, 9);
        put(m, "candidate.wBase", KnobType.DOUBLE, 0, 100);
        put(m, "candidate.wPosition", KnobType.DOUBLE, 0, 100);
        put(m, "candidate.wEvents", KnobType.DOUBLE, 0, 100);
        put(m, "candidate.wBehavior", KnobType.DOUBLE, 0, 100);
        put(m, "candidate.wResult", KnobType.DOUBLE, 0, 100);
        for (String behavior : BEHAVIORS) {
            for (String stat : STATS) {
                put(m, "candidate.behaviorStatMap." + behavior + "." + stat, KnobType.DOUBLE, -10, 10);
            }
        }
        for (String ev : EVENT_TYPES) {
            for (String stat : STATS) {
                put(m, "candidate.eventStatMap." + ev + "." + stat, KnobType.DOUBLE, -10, 10);
            }
        }
        for (String stat : STATS) {
            put(m, "candidate.resultTilt." + stat, KnobType.DOUBLE, -10, 10);
        }
        put(m, "candidate.excludeAtCeiling", KnobType.BOOL, 0, 1);
        // 29 포지션 baseline
        for (String pos : POSITIONS) {
            for (String stat : STATS) {
                put(m, "positionBaseline." + pos + "." + stat, KnobType.DOUBLE, 0, 10);
            }
        }
        // 30~31 승급
        for (int s : STAR_LEVELS) {
            put(m, "star.ceilBonus." + s, KnobType.INT, 0, 50);
        }
        for (int s : COPY_STAR_LEVELS) {
            put(m, "star.copies." + s, KnobType.INT, 1, 999);
        }
        // 32 이관
        put(m, "legacy.levelGrantCap", KnobType.INT, 0, 10_000);
        return Map.copyOf(new LinkedHashMap<>(m));
    }

    private static void put(Map<String, Spec> m, String path, KnobType type, double min, double max) {
        put(m, path, type, min, max, KnobScope.RUNTIME);
    }

    private static void put(Map<String, Spec> m, String path, KnobType type, double min, double max,
                            KnobScope scope) {
        m.put(path, new Spec(path, type, min, max, scope));
    }

    /** 효력 시점이 {@code scope} 인 경로 전수 — 계약과 API 가 같은 목록을 본다. */
    public static List<String> knobsWithScope(KnobScope scope) {
        return SPECS.values().stream().filter(s -> s.scope() == scope).map(Spec::path).toList();
    }

    // ── 경로 ↔ 저장 구조 ────────────────────────────────────────────────

    private static final String BANDS_PREFIX = "bands.";
    private static final String BANDS_NODE = "byGrade";

    /** 문서 경로({@code bands.GOLD.growCeil}) → 저장 경로({@code bands.byGrade.GOLD.growCeil}). */
    public static String toJsonPath(String knobPath) {
        if (knobPath.startsWith(BANDS_PREFIX)) {
            String rest = knobPath.substring(BANDS_PREFIX.length());
            int dot = rest.indexOf('.');
            String head = dot < 0 ? rest : rest.substring(0, dot);
            if (GRADES.contains(head)) {
                return BANDS_PREFIX + BANDS_NODE + "." + rest;
            }
        }
        return knobPath;
    }

    /** 저장 경로 → 문서 경로(위의 역). 두 함수는 반드시 짝으로 움직인다. */
    public static String toKnobPath(String jsonPath) {
        String prefix = BANDS_PREFIX + BANDS_NODE + ".";
        return jsonPath.startsWith(prefix) ? BANDS_PREFIX + jsonPath.substring(prefix.length()) : jsonPath;
    }

    // ── 오버레이 적용 ───────────────────────────────────────────────────

    /**
     * 경로 단위 병합 — 오버레이에 <b>적힌 경로만</b> 덮는다(나머지는 기본값 그대로).
     * 검증은 호출부(admin) 책임이다; 여기 도달한 값은 이미 경로·타입·범위를 통과했다.
     *
     * <p>구현이 Jackson 트리를 경유하는 이유: 레코드 트리를 손으로 재조립하면 계수를 하나 추가할
     * 때마다 이 함수도 고쳐야 하고, 고치는 것을 잊으면 <b>"등록은 됐는데 적용은 안 되는"</b> 노브가
     * 생긴다 — AC-G0 이 정확히 막으려는 상태다.
     */
    public GrowthTuning withOverrides(Map<String, Object> overrides, ObjectMapper objectMapper) {
        if (overrides == null || overrides.isEmpty()) {
            return this;
        }
        ObjectNode root = objectMapper.valueToTree(this);
        for (Map.Entry<String, Object> e : overrides.entrySet()) {
            String[] segments = toJsonPath(e.getKey()).split("\\.");
            ObjectNode node = root;
            for (int i = 0; i < segments.length - 1; i++) {
                JsonNode child = node.get(segments[i]);
                ObjectNode objectChild;
                if (child instanceof ObjectNode existing) {
                    objectChild = existing;
                } else {
                    objectChild = objectMapper.createObjectNode();
                    node.set(segments[i], objectChild);
                }
                node = objectChild;
            }
            node.set(segments[segments.length - 1], objectMapper.valueToTree(e.getValue()));
        }
        return objectMapper.convertValue(root, GrowthTuning.class);
    }

    /** 문서 경로가 가리키는 현재 값(없으면 null) — 화면·계약이 "정말 바뀌었나"를 물을 수 있게 한다. */
    public Object valueAt(String knobPath, ObjectMapper objectMapper) {
        JsonNode node = objectMapper.valueToTree(this);
        for (String segment : toJsonPath(knobPath).split("\\.")) {
            node = node.get(segment);
            if (node == null) {
                return null;
            }
        }
        if (node.isBoolean()) {
            return node.booleanValue();
        }
        return node.isNumber() ? node.numberValue() : node.asText();
    }

    // ── 리플렉션 잎 스캔 (레지스트리 계약이 쓴다) ─────────────────────────

    /**
     * 이 인스턴스의 <b>잎 노드 경로 전수</b>. {@code noKnobEscapesRegistry} 가 이 목록이
     * {@link #KNOBS} 에 포함되는지 본다 — 새 계수를 넣고 등록을 잊으면 그 자리에서 FAIL 한다.
     */
    public List<String> leafPaths() {
        List<String> out = new ArrayList<>();
        collectLeaves("", this, out);
        return out;
    }

    private static void collectLeaves(String prefix, Object value, List<String> out) {
        if (value == null) {
            return;
        }
        if (value instanceof Map<?, ?> map) {
            map.forEach((k, v) -> collectLeaves(join(prefix, String.valueOf(k)), v, out));
            return;
        }
        Class<?> type = value.getClass();
        if (type.isRecord()) {
            for (RecordComponent component : type.getRecordComponents()) {
                Object child;
                try {
                    child = component.getAccessor().invoke(value);
                } catch (ReflectiveOperationException e) {
                    throw new IllegalStateException("GrowthTuning 리플렉션 실패: " + component.getName(), e);
                }
                // Bands.byGrade 는 경로에서 한 칸이 생략된다(클래스 javadoc).
                String next = BANDS_NODE.equals(component.getName()) ? prefix : join(prefix, component.getName());
                collectLeaves(next, child, out);
            }
            return;
        }
        out.add(prefix);
    }

    private static String join(String prefix, String segment) {
        return prefix.isEmpty() ? segment : prefix + "." + segment;
    }
}
