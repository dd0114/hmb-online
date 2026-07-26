package online.hmb.growth;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.SplittableRandom;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.meta.WalletService;
import online.hmb.shop.GachaRandomSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 성장 시스템 — 메이플 피벗 V2 (에픽 #179, hero 확정 2026-07-26 안 ㄴ). SoT =
 * issues/2026-07-26-growth-dual-track.md §V2, 조사 = docs/research/maple-growth-model.md.
 *
 * <p><b>3축</b>: ①스탯 성장(경기·스탯별 Lv 지수) ②성★(중복=천장 개방) ③잠재능력(3줄·티어·다이스, 메이플 이식).
 * 구 강화(enhance)/한계돌파(limit_break→등급승급) 모델은 폐기 — 등급 승급 없음(프레임색 불변).
 *
 * <p><b>결정론(§8)</b>: 스탯 XP·성★ 승급 = RNG 없음(계수만). 다이스 롤만 RNG(SecureRandom seed →
 * dice_rolls 저장, 가챠 패턴 복제 — 같은 seed 재실행 = 같은 결과, 감사·재현 가능). 전부 트랜잭션·멱등
 * (growth_applied PK / CAS UPDATE / point_ledger 원장). 엔진·shared 계약 무변경 — server 가 유효스탯을
 * 계산해 다음 매치 SelectData 에 주입한다. {@code matches.select_data_json} 스냅샷 불변 → 과거 리플레이
 * bit-identical(성장·잠재 0 인 카드는 유효스탯 == 원본).
 *
 * <p><b>유효스탯 계산(V2-2)</b>:
 * <pre>
 *   cap_i(star)  = base_i + starFrac[star] × (band.hi − base_i)
 *   prePotential_i = clamp(base_i + statLv_i, band.lo, cap_i(star))     // statLv_i = 레벨 수(=+1/Lv 누적)
 *   eff_i        = (prePotential_i + Σ잠재flat_i) × (1 + Σ잠재pct_i/100)
 *   ovr          = Σ(eff_i × baselineByPosition[pos]_i)
 *   완성도        = Σ statLv_i / Σ (cap_i(star) − base_i)
 * </pre>
 */
@Service
public class GrowthService {

    private static final Logger log = LoggerFactory.getLogger(GrowthService.class);

    /** 등급 밴드 [lo, hi] — 기존 유지(V2-1: 등급 승급 없음, 성이 밴드 내 천장만 개방). */
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

    /** 잠재 티어 서열(랙칫) — shared growth.ts POTENTIAL_TIERS 와 동일. */
    static final List<String> TIER_ORDER = List.of("RARE", "EPIC", "UNIQUE");

    private static final double MINUTES_STARTER_KEY_MISSING = 1.0;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final EconomyService economyService;
    private final WalletService walletService;
    private final GachaRandomSource randomSource;

    public GrowthService(JdbcClient jdbcClient,
                         TxRunner txRunner,
                         ObjectMapper objectMapper,
                         EconomyService economyService,
                         WalletService walletService,
                         GachaRandomSource randomSource) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.economyService = economyService;
        this.walletService = walletService;
        this.randomSource = randomSource;
    }

    // ── 순수 계산 자료구조 ───────────────────────────────────────────────

    public record StatLevelState(int lv, int xp) {
        static StatLevelState fresh() {
            return new StatLevelState(0, 0);
        }
    }

    private record PlayerBase(String id, String position, String grade, Map<String, Integer> attributes) {
    }

    private record CardState(int star) {
        static CardState fresh() {
            return new CardState(1);
        }
    }

    private record PotentialLine(int slot, String tier, String type, String stat, double value) {
        Map<String, Object> toMap() {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("slot", slot);
            m.put("tier", tier);
            m.put("type", type);
            if (stat != null) {
                m.put("stat", stat);
            }
            m.put("value", value);
            return m;
        }
    }

    private record PotentialRow(String tier, List<PotentialLine> lines, int rollsSinceTierUp) {
        static PotentialRow fresh() {
            return new PotentialRow("RARE", List.of(), 0);
        }
    }

    /** 순수 계산 결과 — CardEffective(shared) 를 그대로 채울 수 있는 형태. */
    private record Effective(String grade, int star, Map<String, Double> attributes,
                             Map<String, Double> prePotential, Map<String, Integer> base,
                             Map<String, Double> caps, Map<String, StatLevelState> statLevels,
                             boolean potentialUnlocked, String potentialTier, String potentialMaxTier,
                             List<PotentialLine> potentialLines, int rollsSinceTierUp, int ceilingAt,
                             double ovr, double completion) {
    }

    // ── config 조회 (없으면 503) ────────────────────────────────────────

    private EconomyService.Growth growthCfg() {
        return economyService.get().map(EconomyService.Economy::growth)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "GROWTH_CONFIG_MISSING",
                        "성장 설정(economy.growth)이 로드되지 않았습니다"));
    }

    private EconomyService.Star starCfg() {
        return economyService.get().map(EconomyService.Economy::star)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "STAR_CONFIG_MISSING",
                        "성 설정(economy.star)이 로드되지 않았습니다"));
    }

    private EconomyService.Potential potentialCfg() {
        return economyService.get().map(EconomyService.Economy::potential)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "POTENTIAL_CONFIG_MISSING",
                        "잠재 설정(economy.potential)이 로드되지 않았습니다"));
    }

    private EconomyService.Dice diceCfg() {
        return economyService.get().map(EconomyService.Economy::dice)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "DICE_CONFIG_MISSING",
                        "다이스 설정(economy.dice)이 로드되지 않았습니다"));
    }

    // ── 유효스탯 계산 (순수, DB 무관 부분 static) ───────────────────────

    private static double clamp(double v, double lo, double hi) {
        return Math.max(lo, Math.min(hi, v));
    }

    private static double round2(double v) {
        return Math.round(v * 100.0) / 100.0;
    }

    private static double round4(double v) {
        return Math.round(v * 10000.0) / 10000.0;
    }

    static int tierRank(String tier) {
        int idx = TIER_ORDER.indexOf(tier);
        return idx < 0 ? 0 : idx;
    }

    static String nextTier(String tier) {
        int idx = tierRank(tier);
        return idx >= TIER_ORDER.size() - 1 ? tier : TIER_ORDER.get(idx + 1);
    }

    /** 2·3줄 기본 티어 = 한 단계 아래(레어는 바닥이라 그대로). */
    static String oneBelow(String tier) {
        int idx = tierRank(tier);
        return idx <= 0 ? tier : TIER_ORDER.get(idx - 1);
    }

    static String maxTier(String grade, int star, EconomyService.Potential pc) {
        String gradeCap = pc.gradeTierCap().getOrDefault(grade, "RARE");
        int starKey = Math.max(2, star); // star<2 는 잠금 상태 — 참고용으로 2★ 캡 기준 계산
        String starCap = pc.starTierCap().getOrDefault(starKey, "RARE");
        return tierRank(gradeCap) <= tierRank(starCap) ? gradeCap : starCap;
    }

    /** rareToEpic / epicToUnique 확률. UNIQUE(최종 티어)는 승급 대상 없음 → empty. */
    static Optional<Double> tierUpProb(String tier, EconomyService.Potential pc) {
        String key = switch (tier) {
            case "RARE" -> "rareToEpic";
            case "EPIC" -> "epicToUnique";
            default -> null;
        };
        if (key == null) {
            return Optional.empty();
        }
        Double p = pc.tierUp().get(key);
        return (p == null || p <= 0) ? Optional.empty() : Optional.of(p);
    }

    private static int ceilingAt(String tier, EconomyService.Potential pc) {
        return tierUpProb(tier, pc)
                .map(p -> (int) Math.ceil(pc.ceilingMult() / p))
                .orElse(Integer.MAX_VALUE);
    }

    /** xpToNext(lv) = xpLvBase × xpLvGrowth^lv (V2-2, 지수 임계). */
    static int xpToNext(int lv, EconomyService.Growth gc) {
        return (int) Math.max(1, Math.round(gc.xpLvBase() * Math.pow(gc.xpLvGrowth(), lv)));
    }

    /** 순수 유효스탯 계산 — RNG 없음, DB 조회 결과만으로 결정론. */
    private static Effective compute(PlayerBase pb, CardState card, Map<String, StatLevelState> levels,
                                     PotentialRow prow, EconomyService.Growth gc, EconomyService.Star sc,
                                     EconomyService.Potential pc) {
        int[] band = GRADE_BAND.getOrDefault(pb.grade(), new int[]{0, 100});
        int lo = band[0];
        int hi = band[1];
        double starFrac = sc.starFrac().getOrDefault(card.star(), 1.0);

        Map<String, Double> baseline = gc.baselineByPosition().getOrDefault(pb.position(), Map.of());

        Map<String, Double> attributes = new LinkedHashMap<>();
        Map<String, Double> prePotential = new LinkedHashMap<>();
        Map<String, Double> caps = new LinkedHashMap<>();
        double ovr = 0.0;
        double lvSum = 0.0;
        double capGapSum = 0.0;

        for (String stat : ATTR_KEYS) {
            double baseI = pb.attributes().getOrDefault(stat, 0);
            double capI = baseI + starFrac * (hi - baseI);
            int lv = levels.getOrDefault(stat, StatLevelState.fresh()).lv();
            double preI = clamp(baseI + lv, lo, capI);

            double flatSum = 0.0;
            double pctSum = 0.0;
            for (PotentialLine line : prow.lines()) {
                if (!stat.equals(line.stat())) {
                    continue;
                }
                if ("STAT_FLAT".equals(line.type())) {
                    flatSum += line.value();
                } else if ("STAT_PCT".equals(line.type())) {
                    pctSum += line.value();
                }
            }
            double effI = (preI + flatSum) * (1 + pctSum / 100.0);

            attributes.put(stat, round2(effI));
            prePotential.put(stat, round2(preI));
            caps.put(stat, round2(capI));
            ovr += effI * baseline.getOrDefault(stat, 0.0);
            lvSum += lv;
            capGapSum += Math.max(0, capI - baseI);
        }

        boolean unlocked = card.star() >= 2;
        String maxTier = maxTier(pb.grade(), card.star(), pc);
        double completion = capGapSum <= 1e-9 ? 1.0 : clamp(lvSum / capGapSum, 0.0, 1.0);

        Map<String, Integer> baseInt = new LinkedHashMap<>(pb.attributes());
        return new Effective(pb.grade(), card.star(), attributes, prePotential, baseInt, caps, levels,
                unlocked, prow.tier(), maxTier, prow.lines(), prow.rollsSinceTierUp(),
                ceilingAt(prow.tier(), pc), round2(ovr), round4(completion));
    }

    // ── DB 조회 헬퍼 ─────────────────────────────────────────────────────

    private Optional<PlayerBase> playerBase(String playerId) {
        return jdbcClient.sql("SELECT id, position, grade, attributes_json FROM players WHERE id = ?")
                .param(playerId)
                .query((rs, n) -> new PlayerBase(rs.getString("id"), rs.getString("position"),
                        rs.getString("grade"), parseAttrs(rs.getString("attributes_json"))))
                .optional();
    }

    private CardState cardState(String userId, String playerId) {
        return jdbcClient.sql("SELECT star FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId)
                .query((rs, n) -> new CardState(rs.getInt("star")))
                .optional()
                .orElse(CardState.fresh());
    }

    private CardState cardStateForUpdate(String userId, String playerId) {
        return jdbcClient.sql("SELECT star FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId)
                .query((rs, n) -> new CardState(rs.getInt("star")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("보유하지 않은 선수입니다: " + playerId));
    }

    private Map<String, StatLevelState> loadStatLevels(String userId, String playerId) {
        String json = jdbcClient.sql("SELECT stat_levels_json FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId).query(String.class).optional().orElse(null);
        Map<String, StatLevelState> out = new LinkedHashMap<>();
        Map<String, Map<String, Integer>> parsed = json == null ? Map.of() : readStatLevelsJson(json);
        for (String stat : ATTR_KEYS) {
            Map<String, Integer> lvXp = parsed.get(stat);
            out.put(stat, lvXp == null
                    ? StatLevelState.fresh()
                    : new StatLevelState(lvXp.getOrDefault("lv", 0), lvXp.getOrDefault("xp", 0)));
        }
        return out;
    }

    private Map<String, Map<String, Integer>> readStatLevelsJson(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Map<String, Integer>>>() {
            });
        } catch (Exception e) {
            return Map.of();
        }
    }

    private String writeStatLevelsJson(Map<String, StatLevelState> levels) {
        try {
            Map<String, Object> out = new LinkedHashMap<>();
            levels.forEach((k, v) -> out.put(k, Map.of("lv", v.lv(), "xp", v.xp())));
            return objectMapper.writeValueAsString(out);
        } catch (Exception e) {
            throw new IllegalStateException("stat_levels_json 직렬화 실패: " + e.getMessage(), e);
        }
    }

    private Optional<PotentialRow> potentialRow(String userId, String playerId) {
        return jdbcClient.sql("""
                        SELECT tier, lines_json, rolls_since_tierup FROM card_potentials
                        WHERE user_id = ? AND player_id = ?
                        """)
                .params(userId, playerId)
                .query((rs, n) -> new PotentialRow(rs.getString("tier"),
                        readLinesJson(rs.getString("lines_json")), rs.getInt("rolls_since_tierup")))
                .optional();
    }

    private List<PotentialLine> readLinesJson(String json) {
        if (json == null || json.isBlank()) {
            return List.of();
        }
        try {
            List<Map<String, Object>> raw = objectMapper.readValue(json,
                    new TypeReference<List<Map<String, Object>>>() {
                    });
            List<PotentialLine> lines = new ArrayList<>();
            for (Map<String, Object> m : raw) {
                lines.add(new PotentialLine(
                        ((Number) m.get("slot")).intValue(),
                        (String) m.get("tier"),
                        (String) m.get("type"),
                        (String) m.get("stat"),
                        ((Number) m.get("value")).doubleValue()));
            }
            return lines;
        } catch (Exception e) {
            return List.of();
        }
    }

    private String writeLinesJson(List<PotentialLine> lines) {
        try {
            return objectMapper.writeValueAsString(lines.stream().map(PotentialLine::toMap).toList());
        } catch (Exception e) {
            throw new IllegalStateException("lines_json 직렬화 실패: " + e.getMessage(), e);
        }
    }

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

    // ── GET /api/growth/card/{playerId} ────────────────────────────────

    public Map<String, Object> cardEffective(String userId, String playerId) {
        PlayerBase pb = playerBase(playerId)
                .orElseThrow(() -> ApiException.notFound("선수를 찾을 수 없습니다: " + playerId));
        CardState card = cardState(userId, playerId);
        Map<String, StatLevelState> levels = loadStatLevels(userId, playerId);
        PotentialRow prow = potentialRow(userId, playerId).orElse(PotentialRow.fresh());
        Effective e = compute(pb, card, levels, prow, growthCfg(), starCfg(), potentialCfg());
        return toCardEffectiveMap(playerId, e);
    }

    private Map<String, Object> toCardEffectiveMap(String playerId, Effective e) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("playerId", playerId);
        out.put("grade", e.grade());
        out.put("star", e.star());
        out.put("attributes", e.attributes());
        out.put("prePotential", e.prePotential());
        out.put("base", e.base());
        out.put("caps", e.caps());
        Map<String, Object> statLevels = new LinkedHashMap<>();
        e.statLevels().forEach((k, v) -> statLevels.put(k, Map.of("lv", v.lv(), "xp", v.xp())));
        out.put("statLevels", statLevels);
        Map<String, Object> potential = new LinkedHashMap<>();
        potential.put("unlocked", e.potentialUnlocked());
        potential.put("tier", e.potentialTier());
        potential.put("maxTier", e.potentialMaxTier());
        potential.put("lines", e.potentialLines().stream().map(PotentialLine::toMap).toList());
        potential.put("rollsSinceTierUp", e.rollsSinceTierUp());
        potential.put("ceilingAt", e.ceilingAt());
        out.put("potential", potential);
        out.put("ovr", e.ovr());
        out.put("completion", e.completion());
        return out;
    }

    /**
     * SelectData 주입용 유효스탯(int-ish 맵). 성장·성·잠재 0 인 카드는 원본과 동일(무회귀) → 리플레이
     * bit-identical. 카탈로그/성장 설정 부재 시 원본 그대로(폴백).
     */
    public Map<String, Object> effectiveAttributes(String userId, String playerId, Map<String, Object> fallback) {
        try {
            Optional<PlayerBase> pbOpt = playerBase(playerId);
            if (pbOpt.isEmpty() || economyService.get().map(EconomyService.Economy::growth).isEmpty()
                    || economyService.get().map(EconomyService.Economy::star).isEmpty()
                    || economyService.get().map(EconomyService.Economy::potential).isEmpty()) {
                return fallback;
            }
            PlayerBase pb = pbOpt.get();
            CardState card = cardState(userId, playerId);
            Map<String, StatLevelState> levels = loadStatLevels(userId, playerId);
            PotentialRow prow = potentialRow(userId, playerId).orElse(PotentialRow.fresh());
            Effective e = compute(pb, card, levels, prow, economyService.get().get().growth(),
                    economyService.get().get().star(), economyService.get().get().potential());
            Map<String, Object> out = new LinkedHashMap<>();
            e.attributes().forEach(out::put);
            return out;
        } catch (RuntimeException ex) {
            log.warn("effectiveAttributes fallback for user={} player={}: {}", userId, playerId, ex.toString());
            return fallback;
        }
    }

    // ── POST /api/growth/star ───────────────────────────────────────────

    public Map<String, Object> starUp(String userId, String playerId) {
        EconomyService.Star sc = starCfg();
        EconomyService.Potential pc = potentialCfg();
        return txRunner.run(() -> {
            CardState st = cardStateForUpdate(userId, playerId);
            if (st.star() >= 4) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "STAR_MAX", "이미 최대 성(4★)입니다",
                        Map.of("star", st.star()));
            }
            int targetStar = st.star() + 1;
            int copies = sc.copies().getOrDefault(targetStar, Integer.MAX_VALUE);
            int owned = ownedCount(userId, playerId);
            if (owned < copies) {
                throw insufficient("중복 카드가 부족합니다", "copies", copies, owned);
            }
            int updated = jdbcClient.sql("""
                            UPDATE user_players
                            SET count = count - ?, copies_used = copies_used + ?, star = star + 1
                            WHERE user_id = ? AND player_id = ? AND count >= ? AND star = ?
                            """)
                    .params(copies, copies, userId, playerId, copies, st.star())
                    .update();
            if (updated != 1) {
                throw new ApiException(HttpStatus.CONFLICT, "STAR_CONFLICT", "성 승급 처리 경합 — 다시 시도하세요");
            }
            boolean unlocked = targetStar == 2;
            if (unlocked) {
                jdbcClient.sql("""
                                INSERT OR IGNORE INTO card_potentials(user_id, player_id, tier, lines_json,
                                    rolls_since_tierup, updated_at)
                                VALUES (?, ?, 'RARE', '[]', 0, ?)
                                """)
                        .params(userId, playerId, Instant.now().toString())
                        .update();
            }
            PlayerBase pb = playerBase(playerId).orElseThrow();
            String maxTier = maxTier(pb.grade(), targetStar, pc);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("playerId", playerId);
            out.put("star", targetStar);
            out.put("spentCopies", copies);
            out.put("potentialUnlocked", unlocked);
            out.put("maxTier", maxTier);
            return out;
        });
    }

    private int ownedCount(String userId, String playerId) {
        return jdbcClient.sql("SELECT count FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId).query(Integer.class).optional().orElse(0);
    }

    private static ApiException insufficient(String message, String kind, Number need, Number have) {
        return new ApiException(HttpStatus.BAD_REQUEST, "INSUFFICIENT_MATERIALS", message,
                Map.of("kind", kind, "need", need, "have", have));
    }

    // ── POST /api/growth/dice — 잠재 리롤/승급 (RNG: seed 저장, 가챠 패턴 복제) ─────

    /** 다이스 롤 순수 결과 — DiceRollResult(shared) 를 채울 수 있는 형태. RNG 는 seed 로만 주입(재현 가능). */
    record DiceOutcome(String tierBefore, String tierAfter, boolean tierUp, boolean byCeiling,
                       List<PotentialLine> lines, int rollsSinceTierUp, int ceilingAt) {
    }

    /**
     * 순수 함수 — 같은 (seed, tierBefore, rollsBefore, kind, grade, star, config) 는 항상 같은 결과
     * (AC-V3 시드 재현). 노말 다이스만 rollsSinceTierUp 을 증가·리셋한다(카운터 = 천장 진행도).
     */
    static DiceOutcome rollFromSeed(String seed, String tierBefore, int rollsBefore, String kind,
                                    String grade, int star, EconomyService.Potential pc) {
        SplittableRandom rng = rngFromSeed(seed);
        int lineCount = pc.linesByGrade().getOrDefault(grade, 1);
        String cardMaxTier = maxTier(grade, star, pc);
        boolean canPromote = tierRank(tierBefore) < tierRank(cardMaxTier);

        boolean tierUp = false;
        boolean byCeiling = false;
        int rollsAfter = rollsBefore;
        String tierAfter = tierBefore;
        int ceilingAtOut = ceilingAt(tierBefore, pc);

        if ("NORMAL".equals(kind) && canPromote) {
            Optional<Double> pOpt = tierUpProb(tierBefore, pc);
            if (pOpt.isPresent()) {
                double p = pOpt.get();
                ceilingAtOut = (int) Math.ceil(pc.ceilingMult() / p);
                if (rollsBefore + 1 >= ceilingAtOut) {
                    tierUp = true;
                    byCeiling = true;
                } else if (rng.nextDouble() < p) {
                    tierUp = true;
                }
            }
            if (tierUp) {
                tierAfter = nextTier(tierBefore);
                rollsAfter = 0;
            } else {
                rollsAfter = rollsBefore + 1;
            }
        }

        List<PotentialLine> lines = rollLines(rng, tierAfter, lineCount, kind, pc);
        return new DiceOutcome(tierBefore, tierAfter, tierUp, byCeiling, lines, rollsAfter, ceilingAtOut);
    }

    private static List<PotentialLine> rollLines(SplittableRandom rng, String resultTier, int lineCount,
                                                 String kind, EconomyService.Potential pc) {
        List<PotentialLine> lines = new ArrayList<>();
        Map<String, Integer> typeStatCount = new HashMap<>();
        double breakoutP = pc.breakout().getOrDefault("cash".equals(kind) ? "cash" : "normal", 0.0);

        for (int slot = 1; slot <= lineCount; slot++) {
            String slotTier = slot == 1 ? resultTier : oneBelow(resultTier);
            if (slot > 1 && !slotTier.equals(resultTier) && rng.nextDouble() < breakoutP) {
                slotTier = resultTier; // 이탈: 낮은 줄이 동일 티어로
            }
            EconomyService.PotentialOption opt = pickOption(rng, pc.tables().getOrDefault(slotTier, List.of()),
                    kind, typeStatCount, pc.cashPremiumMult());
            String key = opt.type() + "|" + (opt.stat() == null ? "" : opt.stat());
            typeStatCount.merge(key, 1, Integer::sum);
            lines.add(new PotentialLine(slot, slotTier, opt.type(), opt.stat(), opt.value()));
        }
        return lines;
    }

    /** 가중 추첨(캐시=premium 옵션 weight×cashPremiumMult). 동일(type,stat) 이미 2줄이면 후보 제외. */
    private static EconomyService.PotentialOption pickOption(SplittableRandom rng,
            List<EconomyService.PotentialOption> candidates, String kind,
            Map<String, Integer> typeStatCount, double cashPremiumMult) {
        List<EconomyService.PotentialOption> pool = candidates.stream()
                .filter(c -> typeStatCount.getOrDefault(c.type() + "|" + (c.stat() == null ? "" : c.stat()), 0) < 2)
                .toList();
        if (pool.isEmpty()) {
            pool = candidates; // 안전망(테이블이 극소인 경우)
        }
        boolean cash = "CASH".equals(kind);
        double total = 0.0;
        double[] weights = new double[pool.size()];
        for (int i = 0; i < pool.size(); i++) {
            EconomyService.PotentialOption c = pool.get(i);
            double w = c.weight() * (cash && c.premium() ? cashPremiumMult : 1.0);
            weights[i] = w;
            total += w;
        }
        if (total <= 0) {
            return pool.get(0);
        }
        double roll = rng.nextDouble() * total;
        double acc = 0.0;
        for (int i = 0; i < pool.size(); i++) {
            acc += weights[i];
            if (roll < acc) {
                return pool.get(i);
            }
        }
        return pool.get(pool.size() - 1);
    }

    /** seed 문자열 → SHA-256 → 첫 8바이트 long → SplittableRandom (GachaService 패턴 복제, 결정론). */
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

    /**
     * 저장된 seed 로 다이스 롤 결과를 재현(감사 — GachaService.previewDraw 패턴 복제, AC-V3). 순수 함수라
     * DB 상태 무관 — 같은 인자는 항상 같은 결과(결정론). 테스트가 랙칫·천장·시드 재현을 직접 검증할 때도 쓴다.
     */
    public Map<String, Object> previewDiceRoll(String seed, String tierBefore, int rollsBefore, String kind,
                                               String grade, int star) {
        DiceOutcome o = rollFromSeed(seed, tierBefore, rollsBefore, kind, grade, star, potentialCfg());
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("tierBefore", o.tierBefore());
        out.put("tierAfter", o.tierAfter());
        out.put("tierUp", o.tierUp());
        out.put("byCeiling", o.byCeiling());
        out.put("lines", o.lines().stream().map(PotentialLine::toMap).toList());
        out.put("rollsSinceTierUp", o.rollsSinceTierUp());
        out.put("ceilingAt", o.ceilingAt());
        return out;
    }

    public Map<String, Object> dice(String userId, String playerId, String kindRaw) {
        String kind = switch (String.valueOf(kindRaw)) {
            case "NORMAL" -> "NORMAL";
            case "CASH" -> "CASH";
            default -> throw ApiException.validation("kind는 NORMAL|CASH만 허용됩니다");
        };
        EconomyService.Potential pc = potentialCfg();
        return txRunner.run(() -> {
            PlayerBase pb = playerBase(playerId)
                    .orElseThrow(() -> ApiException.notFound("선수를 찾을 수 없습니다: " + playerId));
            CardState st = cardStateForUpdate(userId, playerId);
            if (st.star() < 2) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "POTENTIAL_LOCKED",
                        "잠재능력은 2★부터 해금됩니다", Map.of("star", st.star()));
            }

            ensureUserDiceRow(userId);
            String diceCol = "NORMAL".equals(kind) ? "normal" : "cash";
            int consumed = jdbcClient.sql(
                            "UPDATE user_dice SET " + diceCol + " = " + diceCol + " - 1 "
                                    + "WHERE user_id = ? AND " + diceCol + " >= 1")
                    .params(userId)
                    .update();
            if (consumed != 1) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "INSUFFICIENT_DICE", "다이스가 부족합니다",
                        Map.of("kind", kind, "need", 1));
            }

            PotentialRow prow = potentialRow(userId, playerId).orElse(PotentialRow.fresh());
            String seed = randomSource.newSeed();
            DiceOutcome outcome = rollFromSeed(seed, prow.tier(), prow.rollsSinceTierUp(), kind,
                    pb.grade(), st.star(), pc);

            String now = Instant.now().toString();
            String linesJson = writeLinesJson(outcome.lines());
            jdbcClient.sql("""
                            INSERT INTO card_potentials(user_id, player_id, tier, lines_json,
                                rolls_since_tierup, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                            ON CONFLICT(user_id, player_id) DO UPDATE SET
                                tier = excluded.tier, lines_json = excluded.lines_json,
                                rolls_since_tierup = excluded.rolls_since_tierup, updated_at = excluded.updated_at
                            """)
                    .params(userId, playerId, outcome.tierAfter(), linesJson, outcome.rollsSinceTierUp(), now)
                    .update();

            jdbcClient.sql("""
                            INSERT INTO dice_rolls(id, user_id, player_id, kind, seed, tier_before, tier_after,
                                lines_json, created_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                            """)
                    .params(Ulid.next(), userId, playerId, kind, seed, outcome.tierBefore(), outcome.tierAfter(),
                            linesJson, now)
                    .update();

            int diceLeft = jdbcClient.sql("SELECT " + diceCol + " FROM user_dice WHERE user_id = ?")
                    .param(userId).query(Integer.class).single();

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("playerId", playerId);
            out.put("kind", kind);
            out.put("tierBefore", outcome.tierBefore());
            out.put("tierAfter", outcome.tierAfter());
            out.put("tierUp", outcome.tierUp());
            out.put("byCeiling", outcome.byCeiling());
            out.put("lines", outcome.lines().stream().map(PotentialLine::toMap).toList());
            out.put("rollsSinceTierUp", outcome.rollsSinceTierUp());
            out.put("ceilingAt", outcome.ceilingAt() == Integer.MAX_VALUE ? 999999 : outcome.ceilingAt());
            out.put("diceLeft", diceLeft);
            return out;
        });
    }

    private void ensureUserDiceRow(String userId) {
        jdbcClient.sql("INSERT OR IGNORE INTO user_dice(user_id, normal, cash) VALUES (?, 0, 0)")
                .param(userId).update();
    }

    // ── POST /api/shop/dice — 다이스 구매(포인트, 목업) ─────────────────

    public Map<String, Object> buyDice(String userId, String kindRaw, int count) {
        String kind = switch (String.valueOf(kindRaw)) {
            case "NORMAL" -> "NORMAL";
            case "CASH" -> "CASH";
            default -> throw ApiException.validation("kind는 NORMAL|CASH만 허용됩니다");
        };
        if (count <= 0) {
            throw ApiException.validation("count는 1 이상이어야 합니다");
        }
        EconomyService.Dice dc = diceCfg();
        int unitCost = "NORMAL".equals(kind) ? dc.normalCost() : dc.cashCost();
        long cost = (long) unitCost * count;
        String col = "NORMAL".equals(kind) ? "normal" : "cash";
        return txRunner.run(() -> {
            long balance = walletService.points(userId);
            if (balance < cost) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "INSUFFICIENT_POINTS", "포인트가 부족합니다",
                        Map.of("balance", balance, "cost", cost));
            }
            String refId = Ulid.next();
            walletService.apply(userId, -cost, "dice", refId);
            ensureUserDiceRow(userId);
            jdbcClient.sql("UPDATE user_dice SET " + col + " = " + col + " + ? WHERE user_id = ?")
                    .params(count, userId).update();
            Map<String, Object> row = jdbcClient.sql("SELECT normal, cash FROM user_dice WHERE user_id = ?")
                    .param(userId)
                    .query((rs, n) -> Map.<String, Object>of("normal", rs.getInt("normal"), "cash", rs.getInt("cash")))
                    .single();
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("kind", kind);
            out.put("count", count);
            out.put("dice", row); // DiceBuyResult(shared): {normal, cash} 중첩
            out.put("wallet", Map.of("points", walletService.points(userId)));
            return out;
        });
    }

    /** GET /api/growth/dice — DiceBalance(shared) {normal, cash}. 페이지 로드 시 잔액 조회(웹 새로고침 대응). */
    public Map<String, Object> diceBalance(String userId) {
        return txRunner.run(() -> {
            ensureUserDiceRow(userId);
            return jdbcClient.sql("SELECT normal, cash FROM user_dice WHERE user_id = ?")
                    .param(userId)
                    .query((rs, n) -> Map.<String, Object>of("normal", rs.getInt("normal"), "cash", rs.getInt("cash")))
                    .single();
        });
    }

    // ── 성장 정산 (V2-2, 매치 정산 트랜잭션 내 멱등) ─────────────────────

    /**
     * 매치 정산 — 기용 선수별 스탯 XP 적립(growth_applied PK 멱등). MatchOrchestrator finishMatch
     * 트랜잭션 안에서 1회 호출. 같은 매치 재정산은 growth_applied 중복 삽입이 무시돼 no-op.
     *
     * @param starters 스냅샷 선발 playerId, bench 스냅샷 벤치 playerId
     * @param subsOut  교체 아웃 playerId, subsIn 교체 인 playerId
     */
    public void settleMatch(String matchId, String userId,
                            List<String> starters, List<String> bench,
                            Set<String> subsOut, Set<String> subsIn) {
        EconomyService.Growth gc = economyService.get().map(EconomyService.Economy::growth).orElse(null);
        if (gc == null) {
            log.warn("growth config absent — match {} finished without growth settlement", matchId);
            return;
        }
        Map<String, Map<String, Long>> eventsByPlayer = eventCountsByPlayer(matchId);
        String now = Instant.now().toString();
        List<String> roster = new ArrayList<>(starters);
        roster.addAll(bench);
        for (String pid : roster) {
            double minutesMult;
            if (starters.contains(pid)) {
                minutesMult = subsOut.contains(pid)
                        ? gc.minutesMult().getOrDefault("partial", 0.5)
                        : gc.minutesMult().getOrDefault("starter", MINUTES_STARTER_KEY_MISSING);
            } else {
                minutesMult = subsIn.contains(pid)
                        ? gc.minutesMult().getOrDefault("partial", 0.5)
                        : gc.minutesMult().getOrDefault("bench", 0.0); // 미출전 XP=0(V2-1)
            }
            PlayerBase pb = playerBase(pid).orElse(null);
            if (pb == null) {
                continue;
            }
            Map<String, Integer> perStat = computeStatXpDeltas(pb, minutesMult,
                    eventsByPlayer.getOrDefault(pid, Map.of()), gc);
            applyStatXp(matchId, userId, pid, perStat, gc, now);
        }
    }

    /** xp_i = xpBase × (baselineByPosition[pos]_i + eventBonus_i) × minutesMult × gradeXpMult[grade]. */
    private Map<String, Integer> computeStatXpDeltas(PlayerBase pb, double minutesMult,
                                                      Map<String, Long> eventCounts, EconomyService.Growth gc) {
        Map<String, Double> baseline = gc.baselineByPosition().getOrDefault(pb.position(), Map.of());
        double gradeMult = gc.gradeXpMult().getOrDefault(pb.grade(), 1.0);
        Map<String, Integer> out = new LinkedHashMap<>();
        for (String stat : ATTR_KEYS) {
            double baselineW = baseline.getOrDefault(stat, 0.0);
            double eventBonus = 0.0;
            for (Map.Entry<String, Long> ev : eventCounts.entrySet()) {
                Map<String, Double> statWeights = gc.eventStatMap().get(ev.getKey());
                if (statWeights == null) {
                    continue;
                }
                Double w = statWeights.get(stat);
                if (w != null) {
                    eventBonus += w * ev.getValue();
                }
            }
            double xp = gc.xpBase() * (baselineW + eventBonus) * minutesMult * gradeMult;
            out.put(stat, (int) Math.round(xp));
        }
        return out;
    }

    /** 이벤트 타입별 카운트(선수별) — match_halves(h1+h2) MatchLog.events 에서 파생(플레이어 태그 이벤트 전부). */
    private Map<String, Map<String, Long>> eventCountsByPlayer(String matchId) {
        Map<String, Map<String, Long>> out = new LinkedHashMap<>();
        for (int half = 1; half <= 2; half++) {
            String logJson = jdbcClient.sql(
                            "SELECT match_log_json FROM match_halves WHERE match_id = ? AND half = ?")
                    .params(matchId, half)
                    .query(String.class)
                    .optional()
                    .orElse(null);
            if (logJson == null) {
                continue;
            }
            JsonNode root;
            try {
                root = objectMapper.readTree(logJson);
            } catch (Exception e) {
                continue;
            }
            for (JsonNode event : root.path("events")) {
                String playerId = event.path("playerId").asText("");
                if (playerId.isEmpty()) {
                    continue;
                }
                String type = event.path("type").asText();
                out.computeIfAbsent(playerId, k -> new LinkedHashMap<>()).merge(type, 1L, Long::sum);
            }
        }
        return out;
    }

    /** growth_applied 멱등 삽입 → 신규일 때만 stat_levels_json 갱신(레벨업 임계 지수 자동 반영). */
    private void applyStatXp(String matchId, String userId, String playerId, Map<String, Integer> perStatDelta,
                             EconomyService.Growth gc, String now) {
        int total = perStatDelta.values().stream().mapToInt(Integer::intValue).sum();
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO growth_applied(match_id, user_id, player_id, xp_delta, applied_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(matchId, userId, playerId, total, now)
                .update();
        if (inserted != 1) {
            return; // 이미 정산됨 — 멱등 no-op
        }
        Map<String, StatLevelState> levels = loadStatLevels(userId, playerId);
        for (String stat : ATTR_KEYS) {
            int delta = perStatDelta.getOrDefault(stat, 0);
            if (delta <= 0) {
                continue;
            }
            levels.put(stat, applyForward(levels.get(stat), delta, gc));
        }
        int updated = jdbcClient.sql("UPDATE user_players SET stat_levels_json = ? WHERE user_id = ? AND player_id = ?")
                .params(writeStatLevelsJson(levels), userId, playerId)
                .update();
        if (updated != 1) {
            log.warn("stat_levels_json update affected {} rows for user={} player={}", updated, userId, playerId);
        }
    }

    private static StatLevelState applyForward(StatLevelState state, int delta, EconomyService.Growth gc) {
        int lv = state.lv();
        int xp = state.xp() + delta;
        while (xp >= xpToNext(lv, gc)) {
            xp -= xpToNext(lv, gc);
            lv++;
        }
        return new StatLevelState(lv, xp);
    }

    /** total = Σ_{n=0}^{lv-1} xpToNext(n) + xp — (lv,xp) ↔ 누적 xp 상호 변환(리포트 역산용, 정확 가역). */
    private static long cumulativeXp(StatLevelState s, EconomyService.Growth gc) {
        long total = s.xp();
        for (int n = 0; n < s.lv(); n++) {
            total += xpToNext(n, gc);
        }
        return total;
    }

    private static StatLevelState stateFromCumulative(long total, EconomyService.Growth gc) {
        long remaining = Math.max(0, total);
        int lv = 0;
        while (remaining >= xpToNext(lv, gc)) {
            remaining -= xpToNext(lv, gc);
            lv++;
        }
        return new StatLevelState(lv, (int) remaining);
    }

    // ── GET /api/growth/report/{matchId} ────────────────────────────────

    /**
     * MatchGrowthReport(shared) — growth_applied(이 매치·유저) 대상으로 스탯 XP·레벨업을 재현한다.
     * 매치 로그(불변)로 Δstat 을 새로 계산 → 현재 상태에서 그 Δ 만큼 역산(누적 xp 차감)해 before 를 얻는다.
     * (동일 카드가 이후 매치들로 더 성장했다면 근사 — 이 매치 정산 직후 조회(S1 ResultPage)를 전제로 정확.)
     */
    public Map<String, Object> growthReport(String userId, String matchId) {
        EconomyService.Growth gc = growthCfg();
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
        if (applied.isEmpty()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("matchId", matchId);
            out.put("entries", entries);
            return out;
        }
        Map<String, Map<String, Long>> eventsByPlayer = eventCountsByPlayer(matchId);
        Set<String> starters = snapshotStarters(matchId, userId);
        Set<String> subsOutSet = Set.of(); // 정확 minutesMult 는 정산시점 고정 — report 는 표시용 근사(현재 선발여부 기준)

        for (Applied a : applied) {
            PlayerBase pb = playerBase(a.playerId()).orElse(null);
            if (pb == null) {
                continue;
            }
            double minutesMult = starters.contains(a.playerId())
                    ? gc.minutesMult().getOrDefault("starter", 1.0)
                    : gc.minutesMult().getOrDefault("bench", 0.0);
            Map<String, Integer> perStat = computeStatXpDeltas(pb, minutesMult,
                    eventsByPlayer.getOrDefault(a.playerId(), Map.of()), gc);

            Map<String, StatLevelState> after = loadStatLevels(userId, a.playerId());
            Map<String, StatLevelState> before = new LinkedHashMap<>();
            List<String> levelUps = new ArrayList<>();
            Map<String, Integer> statXp = new LinkedHashMap<>();
            for (String stat : ATTR_KEYS) {
                int delta = perStat.getOrDefault(stat, 0);
                statXp.put(stat, delta);
                StatLevelState afterState = after.get(stat);
                long cumAfter = cumulativeXp(afterState, gc);
                long cumBefore = Math.max(0, cumAfter - delta);
                StatLevelState beforeState = stateFromCumulative(cumBefore, gc);
                before.put(stat, beforeState);
                if (afterState.lv() > beforeState.lv()) {
                    levelUps.add(stat);
                }
            }
            EconomyService.Star sc = economyService.get().map(EconomyService.Economy::star)
                    .orElse(new EconomyService.Star(Map.of(), Map.of()));
            EconomyService.Potential pc = economyService.get().map(EconomyService.Economy::potential)
                    .orElse(new EconomyService.Potential(Map.of(), Map.of(), Map.of(), Map.of(), 1.5, Map.of(), 1.0,
                            Map.of()));
            CardState card = cardState(userId, a.playerId());
            PotentialRow prow = potentialRow(userId, a.playerId()).orElse(PotentialRow.fresh());
            double ovrBefore = compute(pb, card, before, prow, gc, sc, pc).ovr();
            double ovrAfter = compute(pb, card, after, prow, gc, sc, pc).ovr();

            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("playerId", a.playerId());
            entry.put("name", playerName(a.playerId()));
            entry.put("statXp", statXp);
            entry.put("levelUps", levelUps);
            entry.put("ovrBefore", ovrBefore);
            entry.put("ovrAfter", ovrAfter);
            entries.add(entry);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("matchId", matchId);
        out.put("entries", entries);
        return out;
    }

    private Set<String> snapshotStarters(String matchId, String userId) {
        String deckJson = jdbcClient.sql("SELECT user_deck_json FROM matches WHERE id = ? AND user_id = ?")
                .params(matchId, userId).query(String.class).optional().orElse(null);
        if (deckJson == null) {
            return Set.of();
        }
        Set<String> starters = new java.util.HashSet<>();
        try {
            objectMapper.readTree(deckJson).path("starters")
                    .forEach(s -> starters.add(s.path("playerId").asText()));
        } catch (Exception ignored) {
            // no-op — 빈 집합 반환
        }
        return starters;
    }

    private String playerName(String playerId) {
        return jdbcClient.sql("SELECT name FROM players WHERE id = ?")
                .param(playerId).query(String.class).optional().orElse(playerId);
    }
}
