package online.hmb.growth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.SplittableRandom;

/**
 * <b>3지선다 후보 결정</b>(#405 W2b) — 설계 SoT = {@code docs/plan-v5/growth-redesign.md} §2.5.
 *
 * <p>DB·시계·전역 난수가 없다. 입력이 같으면 출력이 같다 —
 * {@code (matchId, userId, playerId, level)} 로 만든 시드가 추첨을 완전히 결정하므로 <b>몇 번을
 * 다시 계산해도 같은 3개 + 같은 상승폭</b>이다. 그 성질이 없으면 "후보를 박제한다"는 말이 성립하지
 * 않는다(재계산할 때마다 다른 답이 나오면 박제본과 재현본이 갈라진다).
 *
 * <pre>
 *   w_i  = wBase
 *        + wPosition × positionBaseline[pos][i]
 *        + wEvents   × ê_i          // 그 경기에서 실제로 한 일
 *        + wBehavior × b̂_i          // 그 경기에서 맡은 역할(= 프롬프트가 AI 를 거쳐 변환된 값)
 *        + wResult   × (WIN ? resultTilt_i : 0)
 *   seed = sha256(matchId + userId + playerId + ":" + level)
 * </pre>
 *
 * <p><b>프롬프트를 키워드 매칭하지 않는다</b>(설계 §2.5 의 핵심 판단). 프롬프트는 AI 가 이미
 * {@code PlayerBehavior} 9 파라미터(0..1)로 변환해 {@code match_halves.*_input_json} 에 박제해 두었고,
 * 그 값을 쓰면 ①"맡은 역할대로 성장한다"가 문자열이 아니라 <b>실제 시뮬 입력</b>으로 성립하고
 * ②한국어·영어·오타·장난 프롬프트에 안 흔들리며 ③결정론이 유지된다.
 *
 * <p>⚠️ <b>설계와의 편차 하나 — 활약·역할 점수를 정규화한다.</b> 설계 공식은 {@code ê}·{@code b̂} 를
 * 원값으로 적었지만, 원값의 스케일이 서로 다르다: {@code eventScore} 는 <b>이벤트 횟수</b>에 비례해
 * 한 경기 패스 300회면 passing 항이 60 이 되어 {@code wBase}(1.0)·{@code wPosition}(≤0.6)을 통째로
 * 삼킨다 = 모든 카드가 "패스"만 뽑는다. 반면 {@code behaviorScore} 는 0..1 이라 같은 가중치를 곱해도
 * 영향이 100배 작다. 그래서 <b>둘 다 최대성분 1 로 정규화</b>해 벡터의 <b>모양</b>만 남긴다 —
 * "무엇을 많이 했나"의 순위는 보존되고 "몇 번 했나"의 절대량만 떨어진다. 가중치 노브
 * ({@code wEvents}·{@code wBehavior})가 그제야 서로 비교 가능한 축이 된다.
 */
public final class GrowthCandidates {

    private GrowthCandidates() {
    }

    /**
     * 후보 한 칸 — 스탯 · <b>그 자리에서 확정된</b> 상승폭 · <b>왜 이 후보인가</b>. 셋 다 박제된다.
     *
     * <p>{@code reason} 이 gain 과 같은 취급을 받는 이유는 같다: 미뤄서 골라도 화면이 안 바뀌어야
     * 한다. 나중에 재계산하면 그 사이 다음 경기를 치른 카드의 이유가 바뀌어 "슛 4회라서 나왔다던
     * 후보가 갑자기 태클 3회 때문"이 된다.
     */
    public record Choice(String stat, double gain, Reason reason) {
    }

    /**
     * <b>그 스탯의 가중에 가장 크게 기여한 축</b>. 서버는 <b>구조만</b> 내리고 문장은 만들지 않는다 —
     * 재화 표기(#232)와 같은 이유로, 문안이 서버 코드에 박히면 문구 하나 고치는 데 배포가 필요하다.
     *
     * <ul>
     *   <li>{@code EVENT}    — {@code {"type":"shot","count":4}} (그 경기에서 실제로 한 일)</li>
     *   <li>{@code BEHAVIOR} — {@code {"param":"shootTendency","value":0.82}} (프롬프트가 AI 를 거쳐
     *       변환된 역할 파라미터)</li>
     *   <li>{@code POSITION} — {@code {"position":"MF"}}</li>
     *   <li>{@code RESULT}   — {@code {"result":"WIN"}}</li>
     *   <li>{@code LEGACY}   — {@code {}} 소급 지급분. 매치 컨텍스트가 없으므로 <b>없는 이유를 지어내지
     *       않는다</b>(클라가 "이관 보상"으로 구분해 그린다).</li>
     *   <li>{@code BASE}     — {@code {}} 어느 축도 기여하지 않았다 = 균등 바닥({@code wBase})만으로
     *       뽑혔다. 기본 계수에선 {@code positionBaseline} 이 9종 모두 &gt;0 이라 실질적으로 도달하지
     *       않지만, 오버레이로 가중을 0 으로 만들면 나온다 — <b>그때 POSITION 이라고 말하면 거짓</b>이라
     *       자리를 비워 둔다.</li>
     * </ul>
     */
    public record Reason(String kind, Map<String, Object> detail) {

        public static final String EVENT = "EVENT";
        public static final String BEHAVIOR = "BEHAVIOR";
        public static final String POSITION = "POSITION";
        public static final String RESULT = "RESULT";
        public static final String LEGACY = "LEGACY";
        public static final String BASE = "BASE";
    }

    /**
     * 이유의 <b>세부를 채울 원자료</b>. 점수 벡터(정규화된 스탯별 합)만으로는 "슛 4회"를 복원할 수
     * 없어서 따로 받는다 — 벡터는 <b>얼마나</b>를, 이것은 <b>무엇을</b> 답한다.
     *
     * @param eventCounts 이벤트 타입별 횟수(유저 사이드만)
     * @param behavior    {@code PlayerBehavior} 9 파라미터(0..1)
     * @param legacy      소급 지급분이면 true — 매치 이유를 만들지 않는다
     */
    public record Evidence(Map<String, Long> eventCounts, Map<String, Double> behavior, boolean legacy) {

        public static Evidence ofMatch(Map<String, Long> eventCounts, Map<String, Double> behavior) {
            return new Evidence(eventCounts == null ? Map.of() : eventCounts,
                    behavior == null ? Map.of() : behavior, false);
        }

        /** 매치 컨텍스트 없음(설계 §2.7 소급 지급). */
        public static Evidence ofLegacy() {
            return new Evidence(Map.of(), Map.of(), true);
        }
    }

    /** 한 레벨업이 만드는 선택권 전체 — 후보 + 그것을 뽑은 시드(감사·재현). */
    public record Draw(String seed, List<Choice> choices) {

        public boolean isEmpty() {
            return choices.isEmpty();
        }
    }

    // ── 시드 ────────────────────────────────────────────────────────────

    /**
     * {@code sha256(matchId + userId + playerId + ":" + level)} 의 hex.
     *
     * <p>레벨을 시드에 넣는 이유: 한 경기에 레벨업이 여러 번 나면 <b>레벨마다 다른 후보</b>가 나와야
     * 한다. 안 넣으면 3연속 레벨업이 같은 3장을 세 번 준다.
     *
     * <p>소급 지급분({@code matchId} 없음)은 호출부가 고정 접두({@code "legacy"})를 넘긴다 —
     * 매치 컨텍스트가 없다는 사실 자체가 시드에 들어가야 나중에 같은 유저·같은 카드의 매치 지급분과
     * 충돌하지 않는다.
     */
    public static String seed(String source, String userId, String playerId, int level) {
        return sha256Hex(source + userId + playerId + ":" + level);
    }

    private static String sha256Hex(String material) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256")
                    .digest(material.getBytes(StandardCharsets.UTF_8));
            return HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    // ── 점수 벡터 (순수) ────────────────────────────────────────────────

    /**
     * 그 경기에서 <b>실제로 한 일</b> → 스탯 점수. {@code eventStatMap} 이 SoT 다.
     *
     * @param eventCounts 이벤트 타입별 횟수 — <b>유저 사이드만</b> 담겨 있어야 한다(봇과 playerId 가
     *                    겹치므로, 필터는 호출부가 이미 했다는 전제)
     */
    public static Map<String, Double> eventScore(GrowthTuning tuning, Map<String, Long> eventCounts) {
        Map<String, Double> out = zeroVector();
        tuning.candidate().eventStatMap().forEach((type, weights) -> {
            long count = eventCounts.getOrDefault(type, 0L);
            if (count == 0) {
                return;
            }
            weights.forEach((stat, w) -> out.computeIfPresent(stat, (k, v) -> v + w * count));
        });
        return out;
    }

    /**
     * 그 경기에서 <b>맡은 역할</b> → 스탯 점수. 입력은 AI 가 프롬프트를 변환해 박제한
     * {@code PlayerBehavior} 9 파라미터(0..1)다.
     */
    public static Map<String, Double> behaviorScore(GrowthTuning tuning, Map<String, Double> behavior) {
        Map<String, Double> out = zeroVector();
        tuning.candidate().behaviorStatMap().forEach((param, weights) -> {
            Double value = behavior.get(param);
            if (value == null || value == 0.0) {
                return;
            }
            weights.forEach((stat, w) -> out.computeIfPresent(stat, (k, v) -> v + w * value));
        });
        return out;
    }

    /**
     * 활약 보너스 원값(§2.4 {@code perfBonus}) = Σ {@code perfEventWeight[type] × 횟수}.
     * 상한({@code perfBonusCap})은 {@link GrowthMath#matchXp} 가 씌운다 — 호출부가 잊을 수 없게.
     */
    public static double perfBonus(GrowthTuning tuning, Map<String, Long> eventCounts) {
        double sum = 0.0;
        for (Map.Entry<String, Long> e : eventCounts.entrySet()) {
            Double w = tuning.xp().perfEventWeight().get(e.getKey());
            if (w != null) {
                sum += w * e.getValue();
            }
        }
        return sum;
    }

    // ── 추첨 ────────────────────────────────────────────────────────────

    /**
     * 가중 <b>비복원</b> 추첨 {@code candidate.count} 개.
     *
     * @param currentPre 현재 pre-잠재 스탯(= {@code clamp(base + add, startLo, ceiling)}). 감쇠 곡선과
     *                   천장 제외 판정이 둘 다 이 값을 본다.
     * @param level      상승폭의 레벨 페널티({@code levelPenaltyPerLv}, 기본 0)용
     * @param result     {@code WIN|DRAW|LOSS}. 소급 지급처럼 결과가 없으면 null.
     * @return 후보가 하나도 없으면(전 스탯 천장) <b>빈 Draw</b> — 호출부는 선택권을 만들지 않는다.
     *         빈 선택 대기를 만들면 유저가 영원히 못 지우는 뱃지가 남는다.
     */
    public static Draw draw(GrowthTuning tuning, String seed, String position, String grade, int star,
                            Map<String, Double> currentPre, Map<String, Double> eventScore,
                            Map<String, Double> behaviorScore, String result, int level,
                            Evidence evidence) {
        double ceiling = GrowthMath.ceiling(tuning, grade, star);
        Map<String, Double> events = normalizeToMax(eventScore);
        Map<String, Double> behaviors = normalizeToMax(behaviorScore);
        Map<String, Double> baseline = tuning.positionBaseline().getOrDefault(position, Map.of());
        GrowthTuning.Candidate cfg = tuning.candidate();
        boolean win = "WIN".equals(result);

        List<String> pool = new ArrayList<>();
        List<Double> weights = new ArrayList<>();
        for (String stat : GrowthTuning.STATS) {
            double current = currentPre.getOrDefault(stat, 0.0);
            if (cfg.excludeAtCeiling() && current >= ceiling) {
                continue;   // 천장에 닿은 스탯은 +0 을 뽑는 죽은 선택지다(설계 §2.3)
            }
            double w = cfg.wBase()
                    + cfg.wPosition() * baseline.getOrDefault(stat, 0.0)
                    + cfg.wEvents() * events.getOrDefault(stat, 0.0)
                    + cfg.wBehavior() * behaviors.getOrDefault(stat, 0.0)
                    + cfg.wResult() * (win ? cfg.resultTilt().getOrDefault(stat, 0.0) : 0.0);
            pool.add(stat);
            // 음수 가중은 "뽑히지 않는다"이지 "확률을 남에게서 뺏는다"가 아니다 — 0 에서 자른다.
            weights.add(Math.max(0.0, w));
        }

        SplittableRandom rng = rngFromSeed(seed);
        List<Choice> picked = new ArrayList<>();
        int want = Math.min(Math.max(0, cfg.count()), pool.size());
        while (picked.size() < want) {
            int index = drawIndex(rng, weights);
            String stat = pool.get(index);
            picked.add(new Choice(stat,
                    GrowthMath.gain(tuning, grade, star, currentPre.getOrDefault(stat, 0.0), level),
                    reasonFor(tuning, stat, position, baseline, events, behaviors, win, result, evidence)));
            pool.remove(index);
            weights.remove(index);
        }
        return new Draw(seed, List.copyOf(picked));
    }

    /**
     * 그 스탯의 가중을 <b>가장 크게 밀어올린 축</b> 하나. 이미 계산해 놓은 항들을 다시 재는 것뿐이라
     * 추가 상태가 없고, 따라서 <b>같은 입력이면 같은 이유</b>다(결정론 계약이 gain 과 함께 본다).
     *
     * <p>동점은 <b>고정 순서</b>로 깬다({@code EVENT → BEHAVIOR → POSITION → RESULT}) — 구체적인 근거가
     * 앞이다. 순서를 값에 맡기면(예: 맵 순회) 같은 시드가 실행마다 다른 이유를 말할 수 있다.
     */
    private static Reason reasonFor(GrowthTuning tuning, String stat, String position,
                                    Map<String, Double> baseline, Map<String, Double> events,
                                    Map<String, Double> behaviors, boolean win, String result,
                                    Evidence evidence) {
        if (evidence.legacy()) {
            return new Reason(Reason.LEGACY, Map.of());
        }
        GrowthTuning.Candidate cfg = tuning.candidate();
        double eventTerm = cfg.wEvents() * events.getOrDefault(stat, 0.0);
        double behaviorTerm = cfg.wBehavior() * behaviors.getOrDefault(stat, 0.0);
        double positionTerm = cfg.wPosition() * baseline.getOrDefault(stat, 0.0);
        double resultTerm = win ? cfg.wResult() * cfg.resultTilt().getOrDefault(stat, 0.0) : 0.0;

        double best = Math.max(Math.max(eventTerm, behaviorTerm), Math.max(positionTerm, resultTerm));
        if (best <= 0.0) {
            return new Reason(Reason.BASE, Map.of());
        }
        if (eventTerm == best) {
            Reason detailed = topEvent(tuning, stat, evidence.eventCounts());
            if (detailed != null) {
                return detailed;
            }
        }
        if (behaviorTerm == best) {
            Reason detailed = topBehavior(tuning, stat, evidence.behavior());
            if (detailed != null) {
                return detailed;
            }
        }
        if (positionTerm == best && position != null) {
            return new Reason(Reason.POSITION, Map.of("position", position));
        }
        if (resultTerm == best && result != null) {
            return new Reason(Reason.RESULT, Map.of("result", result));
        }
        return new Reason(Reason.BASE, Map.of());
    }

    /** 이 스탯에 가장 많이 기여한 <b>이벤트 타입</b>과 그 횟수. 원자료가 없으면 null(호출부가 다음 축으로). */
    private static Reason topEvent(GrowthTuning tuning, String stat, Map<String, Long> eventCounts) {
        String bestType = null;
        long bestCount = 0;
        double bestContribution = 0.0;
        // 열거는 EVENT_TYPES 순서 — 동점에서 실행마다 답이 바뀌지 않게 고정 순서로 훑는다.
        for (String type : GrowthTuning.EVENT_TYPES) {
            long count = eventCounts.getOrDefault(type, 0L);
            if (count == 0) {
                continue;
            }
            Map<String, Double> weights = tuning.candidate().eventStatMap().get(type);
            double w = weights == null ? 0.0 : weights.getOrDefault(stat, 0.0);
            double contribution = w * count;
            if (contribution > bestContribution) {
                bestContribution = contribution;
                bestType = type;
                bestCount = count;
            }
        }
        return bestType == null ? null
                : new Reason(Reason.EVENT, Map.of("type", bestType, "count", bestCount));
    }

    /** 이 스탯에 가장 많이 기여한 <b>behavior 파라미터</b>와 그 값. */
    private static Reason topBehavior(GrowthTuning tuning, String stat, Map<String, Double> behavior) {
        String bestParam = null;
        double bestValue = 0.0;
        double bestContribution = 0.0;
        for (String param : GrowthTuning.BEHAVIORS) {
            Double value = behavior.get(param);
            if (value == null || value <= 0.0) {
                continue;
            }
            Map<String, Double> weights = tuning.candidate().behaviorStatMap().get(param);
            double w = weights == null ? 0.0 : weights.getOrDefault(stat, 0.0);
            double contribution = w * value;
            if (contribution > bestContribution) {
                bestContribution = contribution;
                bestParam = param;
                bestValue = value;
            }
        }
        return bestParam == null ? null
                : new Reason(Reason.BEHAVIOR, Map.of("param", bestParam, "value", round2(bestValue)));
    }

    /** 화면에 그대로 나가는 값이라 자릿수를 고정한다(0.8200000001 방지). */
    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    /**
     * 가중 인덱스 1개. 총합이 0 이면(모든 가중이 0 으로 잘림) <b>첫 칸</b>을 준다 — 그래도 결정론이고,
     * 여기서 예외를 던지면 계수 오설정이 정산 전체를 죽인다.
     */
    private static int drawIndex(SplittableRandom rng, List<Double> weights) {
        double total = 0.0;
        for (double w : weights) {
            total += w;
        }
        if (total <= 0.0) {
            return 0;
        }
        double roll = rng.nextDouble() * total;
        double acc = 0.0;
        for (int i = 0; i < weights.size(); i++) {
            acc += weights.get(i);
            if (roll < acc) {
                return i;
            }
        }
        return weights.size() - 1;
    }

    /**
     * 최대성분 1 로 정규화(전부 0 이면 그대로 0). <b>합이 아니라 최대</b>로 나누는 이유: 합 정규화는
     * 성분이 몇 개 살아 있느냐에 따라 전체 크기가 흔들려(1개면 1.0, 9개면 0.11) 가중치 노브의 의미가
     * 표본 구성에 따라 달라진다. 최대 정규화는 "제일 많이 한 일 = 1"이라 노브가 안정적이다.
     */
    static Map<String, Double> normalizeToMax(Map<String, Double> vector) {
        double max = 0.0;
        for (double v : vector.values()) {
            max = Math.max(max, v);
        }
        if (max <= 0.0) {
            return vector;
        }
        Map<String, Double> out = new LinkedHashMap<>();
        double divisor = max;
        vector.forEach((k, v) -> out.put(k, v / divisor));
        return out;
    }

    private static Map<String, Double> zeroVector() {
        Map<String, Double> out = new LinkedHashMap<>();
        for (String stat : GrowthTuning.STATS) {
            out.put(stat, 0.0);
        }
        return out;
    }

    /** seed 문자열 → SHA-256 → 첫 8바이트 long → SplittableRandom (가챠·다이스와 같은 패턴). */
    static SplittableRandom rngFromSeed(String seed) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(seed.getBytes(StandardCharsets.UTF_8));
            long value = 0;
            for (int i = 0; i < 8; i++) {
                value = (value << 8) | (digest[i] & 0xFF);
            }
            return new SplittableRandom(value);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
