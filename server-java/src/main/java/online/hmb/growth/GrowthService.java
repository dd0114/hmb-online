package online.hmb.growth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 성장 시스템 (에픽 #179 — 가챠 강화 ⊥ 경기 성장 이중 트랙, server 권위). SoT =
 * issues/2026-07-26-growth-dual-track.md §2~§4.
 *
 * <p><b>결정론(§8)</b>: RNG/시각 의존 없음 — 계수만. 성장·강화는 트랜잭션·멱등(growth_applied PK /
 * point_ledger 원장 / 조건부 UPDATE). 엔진·shared 계약 무변경 — server 가 숫자(유효스탯)만 계산해
 * 다음 매치 SelectData 에 주입한다. 과거 {@code matches.select_data_json} 스냅샷은 불변이므로
 * 기존 매치 리플레이는 bit-identical(성장 0 인 카드는 유효스탯 == 원본).
 *
 * <p><b>유효스탯 계산(§2)</b>:
 * <pre>
 *   band            = GRADE_BAND[effectiveGrade]  // [lo, hi]
 *   cap_i           = hi                            // 밴드 상한(전 능력치 공통, 오직 limit_break 로 상향)
 *   w_i             = normalize(baselineByPosition[pos])   // 방향 + OVR 가중치(합 1)
 *   g               = clamp(growth_level / levelsToComplete, 0, 1)  // 성장 진행도
 *   성장fill_i       = g × (cap_i - base_i) × (w_i / maxW)   // 방향 집중(플레이가 강점을 키움)
 *   강화fill_i       = enhance_level × enhanceStep × autoFillRatio  // 평탄(과금이 나머지를 메움)
 *   유효_i           = clamp(base_i + 성장fill_i + 강화fill_i, lo, hi)
 *   ovr             = Σ(유효_i × w_i)
 *   완성도           = clamp((ovr - ovrBase) / (cap_ovr - ovrBase), 0, 1)
 * </pre>
 * "과금만 = 미완성"(§2 불변식): 방향 집중된 성장은 강점만 채우고, 강화는 소량 평탄 fill 만 더한다.
 */
@Service
public class GrowthService {

    private static final Logger log = LoggerFactory.getLogger(GrowthService.class);

    /** shared growth.ts GRADE_ORDER 와 동일 — limit_break 단계가 baseGrade 를 위로 민다. */
    static final List<String> GRADE_ORDER = List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND");

    /** 등급 밴드 [lo, hi] (SoT §2). effectiveGrade 밴드 상한이 능력치 천장. */
    static final Map<String, int[]> GRADE_BAND = Map.of(
            "BRONZE", new int[]{40, 55},
            "SILVER", new int[]{50, 65},
            "GOLD", new int[]{60, 75},
            "DIA", new int[]{70, 85},
            "LEGEND", new int[]{80, 95});

    /** shared PlayerAttributes 9종 — 순서 고정(직렬화·반복 안정). */
    static final List<String> ATTR_KEYS = List.of(
            "technical", "mental", "physical", "passing", "shooting",
            "tackling", "pace", "stamina", "positioning");

    /** 강화 1회에 소모하는 동일선수 중복 수(SoT §3 "동일선수 중복 1"). */
    private static final int ENHANCE_COPIES = 1;

    /** 성장 정산 minutesMult — 풀출전/부분출전(교체 인·아웃). 구조 상수(반경기 = 0.5), 튜닝 아님. */
    private static final double MINUTES_FULL = 1.0;
    private static final double MINUTES_PARTIAL = 0.5;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final EconomyService economyService;
    private final WalletService walletService;

    public GrowthService(JdbcClient jdbcClient,
                         TxRunner txRunner,
                         ObjectMapper objectMapper,
                         EconomyService economyService,
                         WalletService walletService) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.economyService = economyService;
        this.walletService = walletService;
    }

    // ── 순수 계산 (테스트 직접 검증, DB 무관) ─────────────────────────────

    /** 카드 인스턴스의 성장·강화 파생 상태(user_players 컬럼). */
    public record CardState(int enhanceLevel, int limitBreak, int matchXp, int growthLevel) {
        static CardState fresh() {
            return new CardState(0, 0, 0, 0);
        }
    }

    /** 순수 계산 결과 — 유효스탯·천장·기준선 + OVR·완성도·effectiveGrade. */
    public record Effective(String baseGrade, String effectiveGrade,
                            Map<String, Integer> attributes, Map<String, Integer> caps,
                            Map<String, Integer> base, double ovr, double ovrBase,
                            double capOvr, double completion) {
    }

    /** effectiveGrade = min(LEGEND, baseGrade + limitBreak). shared growth.ts 와 동치. */
    public static String effectiveGrade(String baseGrade, int limitBreak) {
        int idx = GRADE_ORDER.indexOf(baseGrade);
        if (idx < 0) {
            return baseGrade;
        }
        return GRADE_ORDER.get(Math.min(GRADE_ORDER.size() - 1, idx + Math.max(0, limitBreak)));
    }

    /**
     * 순수 유효스탯 계산(§2). config(growth/enhance)와 순수 입력만으로 결정론적. RNG 없음.
     *
     * @param position GK|DF|MF|FW — baselineByPosition 키
     */
    static Effective compute(String baseGrade, Map<String, Integer> baseAttrs, String position,
                             CardState state, EconomyService.Growth growth, EconomyService.Enhance enhance) {
        String effGrade = effectiveGrade(baseGrade, state.limitBreak());
        int[] band = GRADE_BAND.getOrDefault(effGrade, new int[]{0, 100});
        int lo = band[0];
        int hi = band[1];

        Map<String, Double> w = normalizedWeights(position, growth);
        double maxW = w.values().stream().mapToDouble(Double::doubleValue).max().orElse(1.0);

        double levelsToComplete = Math.max(1e-9,
                (double) growth.completeMatches() * growth.xpBase() * growth.execMatchDefault()
                        / Math.max(1, growth.xpPerLevel()));
        double g = clamp((double) state.growthLevel() / levelsToComplete, 0.0, 1.0);

        double enhanceFill = state.enhanceLevel() * enhance.enhanceStep() * enhance.autoFillRatio();

        Map<String, Integer> effective = new LinkedHashMap<>();
        Map<String, Integer> caps = new LinkedHashMap<>();
        Map<String, Integer> baseClamped = new LinkedHashMap<>();
        double ovr = 0.0;
        double ovrBase = 0.0;
        for (String k : ATTR_KEYS) {
            int baseI = baseAttrs.getOrDefault(k, 0);
            double wi = w.getOrDefault(k, 0.0);
            double growthFill = g * Math.max(0, hi - baseI) * (wi / maxW);
            int eff = (int) Math.round(clamp(baseI + growthFill + enhanceFill, lo, hi));
            int baseInBand = (int) Math.round(clamp(baseI, lo, hi));
            effective.put(k, eff);
            caps.put(k, hi);
            baseClamped.put(k, baseInBand);
            ovr += eff * wi;
            ovrBase += baseInBand * wi;
        }
        double capOvr = hi; // caps 전부 hi + 가중치 합 1 → cap OVR = hi
        double denom = capOvr - ovrBase;
        double completion = denom <= 1e-9 ? 1.0 : clamp((ovr - ovrBase) / denom, 0.0, 1.0);

        return new Effective(baseGrade, effGrade, effective, caps, baseClamped,
                round2(ovr), round2(ovrBase), capOvr, round4(completion));
    }

    /** baselineByPosition[pos] 정규화(합 1). 없거나 합 0 이면 9종 균등. */
    private static Map<String, Double> normalizedWeights(String position, EconomyService.Growth growth) {
        Map<String, Double> raw = growth.baselineByPosition() == null
                ? null : growth.baselineByPosition().get(position);
        Map<String, Double> weights = new LinkedHashMap<>();
        double sum = 0.0;
        for (String k : ATTR_KEYS) {
            double v = raw == null ? 1.0 : Math.max(0.0, raw.getOrDefault(k, 0.0));
            weights.put(k, v);
            sum += v;
        }
        if (sum <= 1e-9) {
            for (String k : ATTR_KEYS) {
                weights.put(k, 1.0 / ATTR_KEYS.size());
            }
            return weights;
        }
        for (String k : ATTR_KEYS) {
            weights.put(k, weights.get(k) / sum);
        }
        return weights;
    }

    // ── DB 조회 계산 (카드 상세·SelectData 주입) ──────────────────────────

    private record PlayerBase(String id, String position, String grade, Map<String, Integer> attributes) {
    }

    private Optional<PlayerBase> playerBase(String playerId) {
        return jdbcClient.sql("SELECT id, position, grade, attributes_json FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> new PlayerBase(rs.getString("id"), rs.getString("position"),
                        rs.getString("grade"), parseAttrs(rs.getString("attributes_json"))))
                .optional();
    }

    private CardState cardState(String userId, String playerId) {
        return jdbcClient.sql("""
                        SELECT enhance_level, limit_break, match_xp, growth_level
                        FROM user_players WHERE user_id = ? AND player_id = ?
                        """)
                .params(userId, playerId)
                .query((rs, n) -> new CardState(rs.getInt("enhance_level"), rs.getInt("limit_break"),
                        rs.getInt("match_xp"), rs.getInt("growth_level")))
                .optional()
                .orElse(CardState.fresh());
    }

    private EconomyService.Growth growthCfg() {
        return economyService.get().map(EconomyService.Economy::growth)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "GROWTH_CONFIG_MISSING",
                        "성장 설정(economy.growth)이 로드되지 않았습니다"));
    }

    private EconomyService.Enhance enhanceCfg() {
        return economyService.get().map(EconomyService.Economy::enhance)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "ENHANCE_CONFIG_MISSING",
                        "강화 설정(economy.enhance)이 로드되지 않았습니다"));
    }

    /** GET /api/growth/card/{playerId} — CardEffective(base/attributes/caps/ovr/completion/grades). */
    public Map<String, Object> cardEffective(String userId, String playerId) {
        PlayerBase pb = playerBase(playerId)
                .orElseThrow(() -> ApiException.notFound("선수를 찾을 수 없습니다: " + playerId));
        Effective e = compute(pb.grade(), pb.attributes(), pb.position(), cardState(userId, playerId),
                growthCfg(), enhanceCfg());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("playerId", playerId);
        out.put("baseGrade", e.baseGrade());
        out.put("effectiveGrade", e.effectiveGrade());
        out.put("attributes", e.attributes());
        out.put("caps", e.caps());
        out.put("base", e.base());
        out.put("ovr", e.ovr());
        out.put("completion", e.completion());
        return out;
    }

    /**
     * SelectData 주입용 유효스탯(int 맵). user_players 성장·강화 반영. 성장 0 인 카드는 원본과 동일
     * (밴드 내 base 클램프 = no-op) → 무회귀. 카탈로그/성장 설정 부재 시 원본 그대로(폴백).
     */
    public Map<String, Object> effectiveAttributes(String userId, String playerId, Map<String, Object> fallback) {
        try {
            PlayerBase pb = playerBase(playerId).orElse(null);
            if (pb == null || economyService.get().map(EconomyService.Economy::growth).isEmpty()) {
                return fallback;
            }
            Effective e = compute(pb.grade(), pb.attributes(), pb.position(), cardState(userId, playerId),
                    economyService.get().get().growth(), economyService.get().get().enhance());
            Map<String, Object> out = new LinkedHashMap<>();
            e.attributes().forEach(out::put);
            return out;
        } catch (RuntimeException ex) {
            log.warn("effectiveAttributes fallback for user={} player={}: {}", userId, playerId, ex.toString());
            return fallback;
        }
    }

    // ── 강화 / 한계돌파 (§3, 멱등·원자적) ─────────────────────────────────

    /** limit_break 를 반영한 강화 상한 — 돌파 1단계마다 maxEnhance 만큼 재개방(0→5, 1→10, …). */
    private static int effectiveMaxEnhance(int limitBreak, EconomyService.Enhance ec) {
        return ec.maxEnhance() * (1 + Math.max(0, limitBreak));
    }

    public Map<String, Object> enhance(String userId, String playerId) {
        EconomyService.Enhance ec = enhanceCfg();
        return txRunner.run(() -> {
            CardState st = cardStateForUpdate(userId, playerId);
            int cap = effectiveMaxEnhance(st.limitBreak(), ec);
            if (st.enhanceLevel() >= cap) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "ENHANCE_MAX",
                        "강화가 상한(" + cap + ")에 도달했습니다 — 한계돌파가 필요합니다",
                        Map.of("enhanceLevel", st.enhanceLevel(), "cap", cap));
            }
            int owned = ownedCount(userId, playerId);
            if (owned < ENHANCE_COPIES) {
                throw insufficient("중복 카드가 부족합니다", "copies", ENHANCE_COPIES, owned);
            }
            long points = walletService.points(userId);
            if (points < ec.pointCost()) {
                throw insufficient("포인트가 부족합니다", "points", ec.pointCost(), points);
            }
            int newLevel = st.enhanceLevel() + 1;
            // 포인트 차감(원장 멱등: (user, 'enhance', playerId:newLevel) 유니크).
            walletService.apply(userId, -ec.pointCost(), "enhance", playerId + ":e" + newLevel);
            // 중복 소모 + 강화 레벨 상향(조건부 CAS — count/enhance_level 재확인).
            int updated = jdbcClient.sql("""
                            UPDATE user_players
                            SET count = count - ?, copies_used = copies_used + ?, enhance_level = enhance_level + 1
                            WHERE user_id = ? AND player_id = ? AND count >= ? AND enhance_level = ?
                            """)
                    .params(ENHANCE_COPIES, ENHANCE_COPIES, userId, playerId, ENHANCE_COPIES, st.enhanceLevel())
                    .update();
            if (updated != 1) {
                throw new ApiException(HttpStatus.CONFLICT, "ENHANCE_CONFLICT", "강화 처리 경합 — 다시 시도하세요");
            }
            return enhanceResult(userId, playerId, false, ENHANCE_COPIES, ec.pointCost());
        });
    }

    public Map<String, Object> limitBreak(String userId, String playerId) {
        EconomyService.Enhance ec = enhanceCfg();
        return txRunner.run(() -> {
            CardState st = cardStateForUpdate(userId, playerId);
            if (st.limitBreak() >= ec.maxLimitBreak()) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "LIMITBREAK_MAX",
                        "한계돌파가 최종 단계(" + ec.maxLimitBreak() + ")입니다",
                        Map.of("limitBreak", st.limitBreak(), "max", ec.maxLimitBreak()));
            }
            int owned = ownedCount(userId, playerId);
            if (owned < ec.limitBreakCopies()) {
                throw insufficient("중복 카드가 부족합니다", "copies", ec.limitBreakCopies(), owned);
            }
            int updated = jdbcClient.sql("""
                            UPDATE user_players
                            SET count = count - ?, copies_used = copies_used + ?, limit_break = limit_break + 1
                            WHERE user_id = ? AND player_id = ? AND count >= ? AND limit_break = ?
                            """)
                    .params(ec.limitBreakCopies(), ec.limitBreakCopies(), userId, playerId,
                            ec.limitBreakCopies(), st.limitBreak())
                    .update();
            if (updated != 1) {
                throw new ApiException(HttpStatus.CONFLICT, "LIMITBREAK_CONFLICT", "돌파 처리 경합 — 다시 시도하세요");
            }
            return enhanceResult(userId, playerId, true, ec.limitBreakCopies(), 0);
        });
    }

    /** EnhanceResult(shared) — 실행 후 상태 + 소모 재료. */
    private Map<String, Object> enhanceResult(String userId, String playerId, boolean promoted,
                                              int copies, int points) {
        PlayerBase pb = playerBase(playerId).orElseThrow();
        CardState st = cardState(userId, playerId);
        Effective e = compute(pb.grade(), pb.attributes(), pb.position(), st, growthCfg(), enhanceCfg());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("playerId", playerId);
        out.put("enhanceLevel", st.enhanceLevel());
        out.put("limitBreak", st.limitBreak());
        out.put("effectiveGrade", e.effectiveGrade());
        out.put("ovr", e.ovr());
        out.put("promoted", promoted);
        out.put("spent", Map.of("copies", copies, "points", points));
        return out;
    }

    private CardState cardStateForUpdate(String userId, String playerId) {
        return jdbcClient.sql("""
                        SELECT enhance_level, limit_break, match_xp, growth_level
                        FROM user_players WHERE user_id = ? AND player_id = ?
                        """)
                .params(userId, playerId)
                .query((rs, n) -> new CardState(rs.getInt("enhance_level"), rs.getInt("limit_break"),
                        rs.getInt("match_xp"), rs.getInt("growth_level")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("보유하지 않은 선수입니다: " + playerId));
    }

    private int ownedCount(String userId, String playerId) {
        return jdbcClient.sql("SELECT count FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId).query(Integer.class).optional().orElse(0);
    }

    private static ApiException insufficient(String message, String kind, Number need, Number have) {
        return new ApiException(HttpStatus.BAD_REQUEST, "INSUFFICIENT_MATERIALS", message,
                Map.of("kind", kind, "need", need, "have", have));
    }

    // ── 성장 정산 (§4, FINISHED 트랜잭션 내 멱등) ─────────────────────────

    /**
     * 매치 정산 — 기용 선수별 Δxp 적립(growth_applied PK 멱등). {@link online.hmb.match.MatchOrchestrator}
     * finishMatch 트랜잭션 안에서 1회 호출. 같은 매치 재정산은 growth_applied 중복 삽입이 무시돼 no-op.
     *
     * @param starters 스냅샷 선발 playerId
     * @param bench    스냅샷 벤치 playerId
     * @param subsOut  교체 아웃 playerId, subsIn 교체 인 playerId
     */
    public void settleMatch(String matchId, String userId,
                            List<String> starters, List<String> bench,
                            Set<String> subsOut, Set<String> subsIn) {
        EconomyService.Growth gc = economyService.get().map(EconomyService.Economy::growth).orElse(null);
        EconomyService.Enhance ec = economyService.get().map(EconomyService.Economy::enhance).orElse(null);
        if (gc == null || ec == null) {
            log.warn("growth config absent — match {} finished without growth settlement", matchId);
            return;
        }
        String now = Instant.now().toString();
        List<String> roster = new ArrayList<>(starters);
        roster.addAll(bench);
        for (String pid : roster) {
            double minutes;
            if (starters.contains(pid)) {
                minutes = subsOut.contains(pid) ? MINUTES_PARTIAL : MINUTES_FULL;
            } else {
                minutes = subsIn.contains(pid) ? MINUTES_PARTIAL : gc.benchGrowthMult(); // 미출전 벤치
            }
            int delta = computeXpDelta(userId, pid, minutes, gc, ec);
            applyXp(matchId, userId, pid, delta, gc, now);
        }
    }

    /**
     * Δxp = xpBase × minutesMult × execMatch × personaMult × conditionMult × gapDecay(1-완성도).
     * (전체 배율 곱은 speedMaxMult 로 상한 — 과금/컨디션 상방 대비 forward-safe.)
     *
     * <p>G2 기본값: execMatch=execMatchDefault(서번트 미연동 폴백, §4), personaMult/conditionMult=1.0
     * (성격·컨디션 세부 배율은 후속 트랙 — 데이터 도메인 config 확장 필요). gapDecay 는 현재 유효스탯
     * (증분 전)의 완성도에서 파생돼 천장 근접 시 성장 감속.
     */
    private int computeXpDelta(String userId, String playerId, double minutesMult,
                               EconomyService.Growth gc, EconomyService.Enhance ec) {
        PlayerBase pb = playerBase(playerId).orElse(null);
        double gapDecay = 1.0;
        if (pb != null) {
            Effective e = compute(pb.grade(), pb.attributes(), pb.position(), cardState(userId, playerId), gc, ec);
            gapDecay = clamp(1.0 - e.completion(), 0.0, 1.0);
        }
        double execMatch = gc.execMatchDefault();
        double personaMult = 1.0;
        double conditionMult = 1.0;
        double product = minutesMult * execMatch * personaMult * conditionMult * gapDecay;
        product = Math.min(product, gc.speedMaxMult());
        return (int) Math.round(gc.xpBase() * product);
    }

    /** growth_applied 멱등 삽입 → 신규일 때만 match_xp 증가·growth_level·growth_vec 갱신. */
    private void applyXp(String matchId, String userId, String playerId, int delta,
                         EconomyService.Growth gc, String now) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO growth_applied(match_id, user_id, player_id, xp_delta, applied_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(matchId, userId, playerId, delta, now)
                .update();
        if (inserted != 1) {
            return; // 이미 정산됨 — 멱등 no-op
        }
        String vec = growthVecJson(playerId);
        jdbcClient.sql("""
                        UPDATE user_players
                        SET match_xp = match_xp + ?,
                            growth_level = (match_xp + ?) / ?,
                            growth_vec_json = ?
                        WHERE user_id = ? AND player_id = ?
                        """)
                .params(delta, delta, Math.max(1, gc.xpPerLevel()), vec, userId, playerId)
                .update();
    }

    /** 성장 방향 벡터(정규화 가중치) JSON — topAttrs 파생 캐시. */
    private String growthVecJson(String playerId) {
        PlayerBase pb = playerBase(playerId).orElse(null);
        if (pb == null) {
            return null;
        }
        Map<String, Double> w = normalizedWeights(pb.position(), growthCfg());
        try {
            return objectMapper.writeValueAsString(w);
        } catch (Exception e) {
            return null;
        }
    }

    // ── 성장 리포트 (§4 → ResultPage S1) ──────────────────────────────────

    /**
     * GET /api/growth/report/{matchId} — MatchGrowthReport(shared). growth_applied(이 매치·유저) 를
     * 현재 user_players 상태와 결합해 ovrBefore/After·leveledUp·topAttrs 를 결정론 재계산(read-only).
     */
    public Map<String, Object> growthReport(String userId, String matchId) {
        EconomyService.Growth gc = growthCfg();
        EconomyService.Enhance ec = enhanceCfg();
        List<Map<String, Object>> entries = new ArrayList<>();
        record Applied(String playerId, int xpDelta) {
        }
        List<Applied> applied = jdbcClient.sql("""
                        SELECT player_id, xp_delta FROM growth_applied
                        WHERE match_id = ? AND user_id = ? ORDER BY player_id
                        """)
                .params(matchId, userId)
                .query((rs, n) -> new Applied(rs.getString("player_id"), rs.getInt("xp_delta")))
                .list();
        for (Applied a : applied) {
            PlayerBase pb = playerBase(a.playerId()).orElse(null);
            if (pb == null) {
                continue;
            }
            CardState after = cardState(userId, a.playerId());
            int xpBefore = Math.max(0, after.matchXp() - a.xpDelta());
            int levelBefore = xpBefore / Math.max(1, gc.xpPerLevel());
            CardState before = new CardState(after.enhanceLevel(), after.limitBreak(), xpBefore, levelBefore);
            Effective effAfter = compute(pb.grade(), pb.attributes(), pb.position(), after, gc, ec);
            Effective effBefore = compute(pb.grade(), pb.attributes(), pb.position(), before, gc, ec);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("playerId", a.playerId());
            entry.put("name", playerName(a.playerId()));
            entry.put("xpDelta", a.xpDelta());
            entry.put("ovrBefore", effBefore.ovr());
            entry.put("ovrAfter", effAfter.ovr());
            entry.put("leveledUp", after.growthLevel() > levelBefore);
            entry.put("topAttrs", topAttrs(pb.position(), gc));
            entries.add(entry);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("matchId", matchId);
        out.put("entries", entries);
        return out;
    }

    /** 방향 w 상위 3개 능력치 라벨(성장 집중 방향). */
    private List<String> topAttrs(String position, EconomyService.Growth gc) {
        Map<String, Double> w = normalizedWeights(position, gc);
        return w.entrySet().stream()
                .sorted(Map.Entry.<String, Double>comparingByValue(Comparator.reverseOrder()))
                .limit(3)
                .map(Map.Entry::getKey)
                .toList();
    }

    private String playerName(String playerId) {
        return jdbcClient.sql("SELECT name FROM players WHERE id = ?")
                .param(playerId).query(String.class).optional().orElse(playerId);
    }

    // ── 헬퍼 ──────────────────────────────────────────────────────────────

    private Map<String, Integer> parseAttrs(String json) {
        try {
            Map<String, Object> raw = objectMapper.readValue(json, new TypeReference<Map<String, Object>>() {
            });
            Map<String, Integer> out = new LinkedHashMap<>();
            raw.forEach((k, v) -> {
                if (v instanceof Number num) {
                    out.put(k, num.intValue());
                }
            });
            return out;
        } catch (Exception e) {
            throw new IllegalStateException("players.attributes_json 파싱 실패: " + e.getMessage(), e);
        }
    }

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }
}
