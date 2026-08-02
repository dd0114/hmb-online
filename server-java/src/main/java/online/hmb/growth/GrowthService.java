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
import online.hmb.common.Josa;
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
 * <p><b>유효스탯 계산(#405 W2a 개편, 설계 §2.6)</b>:
 * <pre>
 *   ceiling_i    = bands[grade].growCeil + star.ceilBonus[star]        // 계수 = GrowthTuning
 *   prePotential_i = clamp(base_i + add_i, bands[grade].startLo, ceiling_i)
 *   eff_i        = min((prePotential_i + Σ잠재flat_i) × (1 + Σ잠재pct_i/100), attrHardCap)
 *   ovr          = Σ(eff_i × positionBaseline[pos]_i)
 *   완성도        = Σ add_i / Σ (ceiling_i − base_i)
 * </pre>
 *
 * <p><b>바뀐 것 둘</b>(구 모델 대비):
 * <ul>
 *   <li><b>{@code starFrac} 천장 게이트 제거</b> — 구 공식은
 *       {@code cap = base + starFrac[star] × (band.hi − base)} 라 1★ 카드가 밴드 여백의 25% 밖에
 *       못 썼다(실측 성장 여백 1.4). 승급은 이제 잠재 해금 + <b>소폭 천장 보너스</b>만 담당하고,
 *       승급 없이도 등급 성장 천장까지 간다. {@code economy.star.starFrac} 는 발행물에 남아 있지만
 *       <b>이 경로에서 더 이상 읽지 않는다</b>.</li>
 *   <li><b>전역 하드 상한 {@code attrHardCap}</b> 을 잠재 적용 <b>후</b>에 씌운다 — 지금까지 잠재에
 *       상한이 없어 100 을 넘을 수 있었던 <b>선존 결함</b>을 이참에 막는다.</li>
 * </ul>
 *
 * <p>⚠️ {@code add_i} 는 아직 <b>기존 {@code stat_levels_json} 의 정수 {@code lv}</b> 를 그대로 읽는다
 * (어댑터). 소수 상승폭 저장 형태와 3지선다·정산 개편은 W2b 소관이라, 이 웨이브만 적용해도 서버가
 * 그대로 뜨도록 스키마를 건드리지 않았다.
 */
@Service
public class GrowthService {

    private static final Logger log = LoggerFactory.getLogger(GrowthService.class);

    /**
     * shared PlayerAttributes 9종 — 순서 고정(직렬화·반복 안정).
     * SoT 는 {@link GrowthTuning#STATS} 다(계수 경로 전개가 같은 목록을 써야 한다).
     */
    static final List<String> ATTR_KEYS = GrowthTuning.STATS;

    /** 잠재 티어 서열(랙칫) — shared growth.ts POTENTIAL_TIERS 와 동일. */
    static final List<String> TIER_ORDER = List.of("RARE", "EPIC", "UNIQUE");

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final EconomyService economyService;
    private final WalletService walletService;
    private final GachaRandomSource randomSource;
    private final LiveGrowthConfigService growthConfig;

    public GrowthService(JdbcClient jdbcClient,
                         TxRunner txRunner,
                         ObjectMapper objectMapper,
                         EconomyService economyService,
                         WalletService walletService,
                         GachaRandomSource randomSource,
                         LiveGrowthConfigService growthConfig) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.economyService = economyService;
        this.walletService = walletService;
        this.randomSource = randomSource;
        this.growthConfig = growthConfig;
    }

    /**
     * 지금 유효한 성장 계수. <b>매 호출마다 다시 묻는다</b> — 값을 필드에 담아 두면 무배포 변경이
     * "재기동해야 반영되는" 것이 되어 이 기능의 목적이 사라진다(캐시는
     * {@link LiveGrowthConfigService} 안에 있다).
     */
    private GrowthTuning tuning() {
        return growthConfig.effective();
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

    // ⚠️ starCfg() 는 제거됐다 — 성 관련 계수(copies·천장 보너스)의 SoT 가 GrowthTuning 으로
    //    옮겨졌기 때문이다(economy.star 는 그 기본값의 출처로만 남는다). economy 에서 직접 읽는
    //    경로를 남겨 두면 무배포 오버레이가 그 경로만 조용히 못 덮는다(AC-G0 구멍).

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

    private EconomyService.Gems gemsCfg() {
        return economyService.get().map(EconomyService.Economy::gems)
                .orElseThrow(() -> new ApiException(HttpStatus.SERVICE_UNAVAILABLE, "GEMS_CONFIG_MISSING",
                        economyService.currency(EconomyService.CURRENCY_GEM).name()
                                + " 설정(economy.gems)이 로드되지 않았습니다"));
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

    /**
     * 순수 유효스탯 계산 — RNG 없음, DB 조회 결과만으로 결정론.
     * <b>모든 수치는 {@code tuning} 에서 온다</b>(하드코딩 0 — AC-G0).
     */
    private static Effective compute(PlayerBase pb, CardState card, Map<String, StatLevelState> levels,
                                     PotentialRow prow, GrowthTuning tuning,
                                     EconomyService.Potential pc) {
        GrowthTuning.Band band = GrowthMath.band(tuning, pb.grade());
        int lo = band.startLo();
        double ceiling = GrowthMath.ceiling(tuning, pb.grade(), card.star());
        double hardCap = tuning.attrHardCap();

        Map<String, Double> baseline = tuning.positionBaseline().getOrDefault(pb.position(), Map.of());

        Map<String, Double> attributes = new LinkedHashMap<>();
        Map<String, Double> prePotential = new LinkedHashMap<>();
        Map<String, Double> caps = new LinkedHashMap<>();
        double ovr = 0.0;
        double lvSum = 0.0;
        double capGapSum = 0.0;

        for (String stat : ATTR_KEYS) {
            double baseI = pb.attributes().getOrDefault(stat, 0);
            // ⚠️ 천장은 base 와 무관하다(구 starFrac 공식과의 결정적 차이) — 등급 천장 + 승급 보너스.
            double capI = ceiling;
            // add_i 어댑터: 기존 stat_levels_json 의 정수 lv 를 그대로 상승분으로 읽는다(W2b 가 교체).
            double addI = levels.getOrDefault(stat, StatLevelState.fresh()).lv();
            double preI = clamp(baseI + addI, lo, capI);

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
            // 전역 하드 상한은 **잠재 적용 후** 최종 클램프다 — 여기 없으면 잠재 %가 100 을 넘긴다
            // (선존 결함, 설계 §2.6).
            double effI = Math.min((preI + flatSum) * (1 + pctSum / 100.0), hardCap);

            attributes.put(stat, round2(effI));
            prePotential.put(stat, round2(preI));
            caps.put(stat, round2(capI));
            ovr += effI * baseline.getOrDefault(stat, 0.0);
            lvSum += addI;
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
        Effective e = compute(pb, card, levels, prow, tuning(), potentialCfg());
        return toCardEffectiveMap(playerId, e);
    }

    // ── 등급 변경 영향 사전 계산 (#207 §1.6-1) ─────────────────────────

    /**
     * <b>등급을 바꾸면 기보유 카드의 유효스탯이 얼마나 움직이는가</b>를 실제 계산해 돌려준다.
     * 어드민 카탈로그 API 가 <b>등급 하향 PATCH 를 막는 판정 근거</b>로 쓴다(추정이 아니라 실측).
     *
     * <p>왜 필요한가: 등급이 내려가면 <b>성장 천장</b>({@code bands[grade].growCeil}, #405 개편 전에는
     * {@code base + starFrac[star] × (band.hi − base)})이 함께 내려가고, <b>많이 키운 카드일수록 더
     * 크게</b> 깎인다 — 즉 <b>투자한 유저가 더 손해</b>다. 운영자가 그걸 모르고 등급을 내리는 일이
     * 없도록 호출부가 영향 규모를 먼저 보여주고 명시 확인을 받는다.
     *
     * <p>순수 읽기 — RNG·쓰기 없음. 카드 상태(성·스탯레벨·잠재)는 그대로 두고 <b>등급만</b> 바꿔
     * 같은 {@link #compute} 를 두 번 돌린 차이다. 그래서 여기 값과 실제 반영 후 값이 어긋날 수 없다
     * (별도 근사식을 두면 공식이 바뀔 때 조용히 갈라진다).
     *
     * <p>경제 설정이 없으면 계산 자체가 불가능하므로 <b>영향 미상</b>({@code computed=false})으로
     * 돌려준다 — 그 경우 호출부는 "영향 0"으로 오해하지 말고 보수적으로 다뤄야 한다.
     */
    public GradeChangeImpact gradeChangeImpact(String playerId, String newGrade) {
        PlayerBase pb = playerBase(playerId)
                .orElseThrow(() -> ApiException.notFound("선수를 찾을 수 없습니다: " + playerId));
        GrowthTuning tuning = tuning();
        boolean capLowered = GrowthMath.band(tuning, newGrade).growCeil()
                < GrowthMath.band(tuning, pb.grade()).growCeil();

        List<String> owners = jdbcClient.sql("SELECT user_id FROM user_players WHERE player_id = ? ORDER BY user_id")
                .param(playerId).query(String.class).list();

        if (pb.grade().equals(newGrade) || owners.isEmpty()) {
            return new GradeChangeImpact(playerId, pb.grade(), newGrade, capLowered,
                    owners.size(), 0.0, 0.0, true);
        }

        EconomyService.Potential pc;
        try {
            pc = potentialCfg();
        } catch (RuntimeException e) {
            log.warn("gradeChangeImpact: 경제 설정 부재로 영향 계산 불가 player={} → {}", playerId, e.toString());
            return new GradeChangeImpact(playerId, pb.grade(), newGrade, capLowered,
                    owners.size(), 0.0, 0.0, false);
        }

        PlayerBase hypothetical = new PlayerBase(pb.id(), pb.position(), newGrade, pb.attributes());
        double sum = 0.0;
        double worst = 0.0;
        for (String owner : owners) {
            CardState card = cardState(owner, playerId);
            Map<String, StatLevelState> levels = loadStatLevels(owner, playerId);
            PotentialRow prow = potentialRow(owner, playerId).orElse(PotentialRow.fresh());
            double before = compute(pb, card, levels, prow, tuning, pc).ovr();
            double after = compute(hypothetical, card, levels, prow, tuning, pc).ovr();
            double delta = after - before;
            sum += delta;
            worst = Math.min(worst, delta);
        }
        return new GradeChangeImpact(playerId, pb.grade(), newGrade, capLowered,
                owners.size(), round2(sum / owners.size()), round2(worst), true);
    }

    /**
     * @param capLowered   새 등급의 밴드 상한이 더 낮다 = 성장 캡이 내려간다(보유자가 0명이어도 참일 수 있다).
     * @param avgOvrDelta  보유자 전원의 유효 OVR 변화 평균(음수 = 손실).
     * @param worstOvrDelta 가장 크게 깎이는 카드 한 장의 변화(음수 = 손실).
     * @param computed     false = 경제 설정 부재로 델타를 계산하지 못했다(0 은 "영향 없음"이 아니다).
     */
    public record GradeChangeImpact(String playerId, String fromGrade, String toGrade, boolean capLowered,
                                    long affectedUsers, double avgOvrDelta, double worstOvrDelta,
                                    boolean computed) {
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
            Effective e = compute(pb, card, levels, prow, tuning(),
                    economyService.get().get().potential());
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
        // 승급 필요 중복 수는 이제 GrowthTuning 이 SoT 다(발행물 economy.star.copies 를 승계하되
        // 무배포 오버레이가 그 위에 얹힌다) — 계수를 economy 에서 직접 읽으면 AC-G0 에 구멍이 난다.
        GrowthTuning.Star starTuning = tuning().star();
        EconomyService.Potential pc = potentialCfg();
        return txRunner.run(() -> {
            CardState st = cardStateForUpdate(userId, playerId);
            // 최대 성은 상수가 아니라 **승급표에서 파생**한다 — 표에 없는 성으로는 올라갈 수 없으므로
            // copies 의 최대 키가 곧 상한이고, 표를 늘리면 상한도 따라온다(하드코딩 4 제거).
            int maxStar = starTuning.copies().keySet().stream().mapToInt(Integer::intValue).max().orElse(1);
            if (st.star() >= maxStar) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "STAR_MAX",
                        "이미 최대 성(" + maxStar + "★)입니다", Map.of("star", st.star()));
            }
            int targetStar = st.star() + 1;
            int copies = starTuning.copies().getOrDefault(targetStar, Integer.MAX_VALUE);
            // B1(#179 gverify): count = 총 보유(원본 포함). 소모 가능한 "중복"은 여분(count−1)뿐 —
            // 원본 1장은 절대 소모하지 않는다(승급으로 카드가 미보유가 되는 사고 방지). UI 문구("중복 −N")와 정합.
            int spareCopies = ownedCount(userId, playerId) - 1;
            if (spareCopies < copies) {
                throw insufficient("중복 카드가 부족합니다", "copies", copies, Math.max(0, spareCopies));
            }
            int updated = jdbcClient.sql("""
                            UPDATE user_players
                            SET count = count - ?, copies_used = copies_used + ?, star = star + 1
                            WHERE user_id = ? AND player_id = ? AND count >= ? + 1 AND star = ?
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

    /**
     * 전줄 동일 티어(V2.1-1): 모든 슬롯이 롤 결과 티어(resultTier)로 리롤된다 — 메이플식 "2·3줄 한 단계
     * 아래 + 이탈" 모델은 폐기. 티어업(승급) 시 전줄이 즉시 새 티어로 리롤되는 게 승급의 맛.
     */
    private static List<PotentialLine> rollLines(SplittableRandom rng, String resultTier, int lineCount,
                                                 String kind, EconomyService.Potential pc) {
        List<PotentialLine> lines = new ArrayList<>();
        Map<String, Integer> typeStatCount = new HashMap<>();

        for (int slot = 1; slot <= lineCount; slot++) {
            EconomyService.PotentialOption opt = pickOption(rng, pc.tables().getOrDefault(resultTier, List.of()),
                    kind, typeStatCount, pc.cashPremiumMult());
            String key = opt.type() + "|" + (opt.stat() == null ? "" : opt.stat());
            typeStatCount.merge(key, 1, Integer::sum);
            lines.add(new PotentialLine(slot, resultTier, opt.type(), opt.stat(), opt.value()));
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

    /**
     * 잠재 리롤 — <b>구매 단계 없이</b> 강화탭에서 바로(에픽 #247, hero 확정 2026-07-29).
     *
     * <p>예전엔 상점에서 다이스를 사서 {@code user_dice} 에 쌓아 두고 여기서 1개를 깎았다. 그
     * 재고가 없어지고 <b>롤이 지갑에서 직접 결제</b>한다 — 단가는 그대로(economy {@code dice}
     * 블록 재사용)라 롤당 재화 유출량이 같다(경제 영향 0, #212 확정 곡선 재계산 불필요).
     *
     * <p><b>결제와 롤은 같은 트랜잭션이다.</b> 떼어 놓으면 "돈은 나갔는데 잠재는 그대로"가
     * 생긴다 — 실패는 항상 둘 다 없던 일이 된다.
     *
     * <p>검사 순서는 <b>잠금 → 잔액 → 결제</b>. 못 하는 일에 먼저 돈을 받지 않는다.
     */
    public Map<String, Object> dice(String userId, String playerId, String kindRaw) {
        String kind = switch (String.valueOf(kindRaw)) {
            case "NORMAL" -> "NORMAL";
            case "CASH" -> "CASH";
            default -> throw ApiException.validation("kind는 NORMAL|CASH만 허용됩니다");
        };
        EconomyService.Potential pc = potentialCfg();
        EconomyService.Dice dc = diceCfg();
        boolean cash = "CASH".equals(kind);
        long cost = cash ? dc.cashGemCost() : dc.normalCost();
        return txRunner.run(() -> {
            PlayerBase pb = playerBase(playerId)
                    .orElseThrow(() -> ApiException.notFound("선수를 찾을 수 없습니다: " + playerId));
            CardState st = cardStateForUpdate(userId, playerId);
            if (st.star() < 2) {
                throw new ApiException(HttpStatus.BAD_REQUEST, "POTENTIAL_LOCKED",
                        "잠재능력은 2★부터 해금됩니다", Map.of("star", st.star()));
            }

            chargeRoll(userId, cash, cost);

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
            // #247: 재고(diceLeft)가 사라진 자리에 지갑이 온다 — 재화를 정하는 쪽이 그 재화의
            // 잔액도 준다(#232). 안 주면 클라가 롤마다 /api/me 를 다시 물어야 한다.
            out.put("wallet", Map.of("points", walletService.points(userId), "gems", walletService.gems(userId)));
            return out;
        });
    }

    /**
     * 롤 1회분 결제 (#247). 잔액이 모자라면 <b>4xx 로 끊고 아무것도 바꾸지 않는다</b> —
     * 호출자 트랜잭션 안이라 이후 롤도 함께 되돌아간다.
     *
     * <p>부족 문구의 재화 이름은 표기 메타에서 온다(#232) — 문구에 박으면 표기 변경이 배포가 된다.
     * 원장 사유는 {@code 'dice'} 그대로 유지한다: 소비의 <b>의미</b>(잠재 리롤)는 안 바뀌었고,
     * 사유를 갈아치우면 기존 원장과 집계가 갈라진다.
     */
    private void chargeRoll(String userId, boolean cash, long cost) {
        String refId = Ulid.next();
        String shortMsg = Josa.iga(economyService.currency(
                cash ? EconomyService.CURRENCY_GEM : EconomyService.CURRENCY_POINT).name()) + " 부족합니다";
        long balance = cash ? walletService.gems(userId) : walletService.points(userId);
        if (balance < cost) {
            throw new ApiException(HttpStatus.BAD_REQUEST,
                    cash ? "INSUFFICIENT_GEMS" : "INSUFFICIENT_POINTS", shortMsg,
                    Map.of("balance", balance, "cost", cost));
        }
        if (cash) {
            walletService.applyGems(userId, -cost, "dice", refId);
        } else {
            walletService.apply(userId, -cost, "dice", refId);
        }
    }

    /**
     * POST /api/shop/gems/topup — 젬 충전(목업, 실결제 없음). config 팩 검증 후 즉시 지급
     * (reason='gem_topup_mock', ref=매 호출 신규 ULID — 재요청도 항상 새로 지급).
     */
    public Map<String, Object> topupGems(String userId, String packId) {
        EconomyService.Gems cfg = gemsCfg();
        // #212: 젬 수급원은 가입 지급 + 리그 입상 둘뿐 — 목업 충전 수도꼭지는 config 로 잠근다.
        // (뽑기가 젬 결제로 바뀌었으므로 무제한 무료 충전이 살아있으면 경제가 붕괴한다.)
        if (!cfg.topupEnabled()) {
            throw new ApiException(HttpStatus.FORBIDDEN, "TOPUP_DISABLED",
                    economyService.currency(EconomyService.CURRENCY_GEM).name()
                            + " 충전은 현재 비활성화돼 있습니다", Map.of("packId", packId));
        }
        EconomyService.GemTopupPack pack = cfg.topupPacks().stream()
                .filter(p -> p.id().equals(packId))
                .findFirst()
                .orElseThrow(() -> new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                        "존재하지 않는 충전 팩입니다: " + packId, Map.of("packId", packId)));
        return txRunner.run(() -> {
            String refId = Ulid.next();
            walletService.applyGems(userId, pack.gems(), "gem_topup_mock", refId);
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("packId", packId);
            out.put("granted", pack.gems());
            out.put("wallet", Map.of("points", walletService.points(userId), "gems", walletService.gems(userId)));
            return out;
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
                            Set<String> subsOut, Set<String> subsIn, boolean userHome) {
        EconomyService.Growth gc = economyService.get().map(EconomyService.Economy::growth).orElse(null);
        if (gc == null) {
            log.warn("growth config absent — match {} finished without growth settlement", matchId);
            return;
        }
        // B2(#179 gverify): 봇 로스터가 같은 카탈로그를 쓰므로 playerId 가 겹친다 —
        // 유저 사이드 이벤트만 귀속(event.team 필터). 아니면 상대 동명 선수 행동으로 XP 가 적립된다.
        String userSide = userHome ? "home" : "away";
        Map<String, Map<String, Long>> eventsByPlayer = eventCountsByPlayer(matchId, userSide);
        String now = Instant.now().toString();
        List<String> roster = new ArrayList<>(starters);
        roster.addAll(bench);
        Map<String, Double> minutes = tuning().xp().minutesMult();
        for (String pid : roster) {
            // 출전 배율도 계수다 — 코드에 0.5/1.0 을 적어 두면 그 값만 무배포 조정 밖에 남는다.
            String minutesKey;
            if (starters.contains(pid)) {
                minutesKey = subsOut.contains(pid) ? "partial" : "starter";
            } else {
                minutesKey = subsIn.contains(pid) ? "partial" : "bench"; // 미출전 XP=0(V2-1)
            }
            double minutesMult = minutes.getOrDefault(minutesKey, 0.0);
            PlayerBase pb = playerBase(pid).orElse(null);
            if (pb == null) {
                continue;
            }
            Map<String, Integer> perStat = computeStatXpDeltas(pb, minutesMult,
                    eventsByPlayer.getOrDefault(pid, Map.of()), gc);
            // M1(#179 gverify): 리포트는 재계산하지 않는다 — 정산 시점 스냅샷(report_json)을 저장.
            double ovrBefore = ovrOf(userId, pid);
            List<String> levelUps = applyStatXp(matchId, userId, pid, perStat, gc, now);
            if (levelUps == null) {
                continue; // 이미 정산됨(멱등 no-op) — 기존 report_json 보존
            }
            double ovrAfter = ovrOf(userId, pid);
            persistReportSnapshot(matchId, userId, pid, perStat, levelUps, ovrBefore, ovrAfter);
        }
    }

    private double ovrOf(String userId, String playerId) {
        Object ovr = cardEffective(userId, playerId).get("ovr");
        return ovr instanceof Number n ? n.doubleValue() : 0.0;
    }

    private void persistReportSnapshot(String matchId, String userId, String playerId,
                                       Map<String, Integer> statXp, List<String> levelUps,
                                       double ovrBefore, double ovrAfter) {
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("statXp", statXp);
        snap.put("levelUps", levelUps);
        snap.put("ovrBefore", round2(ovrBefore));
        snap.put("ovrAfter", round2(ovrAfter));
        try {
            jdbcClient.sql("UPDATE growth_applied SET report_json = ? WHERE match_id = ? AND user_id = ? AND player_id = ?")
                    .params(objectMapper.writeValueAsString(snap), matchId, userId, playerId)
                    .update();
        } catch (Exception e) {
            log.warn("report snapshot persist failed for match={} player={}: {}", matchId, playerId, e.toString());
        }
    }

    /** xp_i = xpBase × (baselineByPosition[pos]_i + eventBonus_i) × minutesMult × gradeXpMult[grade]. */
    private Map<String, Integer> computeStatXpDeltas(PlayerBase pb, double minutesMult,
                                                      Map<String, Long> eventCounts, EconomyService.Growth gc) {
        // 포지션 baseline 은 OVR 과 **같은 표**를 쓴다(설계 §2.8.1 #29) — 두 곳이 갈라지면
        // "이 포지션은 무엇을 하는 선수인가"의 정의가 화면과 성장에서 달라진다.
        Map<String, Double> baseline = tuning().positionBaseline().getOrDefault(pb.position(), Map.of());
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

    /**
     * 이벤트 타입별 카운트(선수별) — match_halves(h1+h2) MatchLog.events 에서 파생.
     * userSide("home"|"away") 이벤트만 집계(B2 — 봇과 playerId 가 겹치므로 team 필터 필수).
     */
    private Map<String, Map<String, Long>> eventCountsByPlayer(String matchId, String userSide) {
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
                if (!userSide.equals(event.path("team").asText(""))) {
                    continue; // 상대 사이드(동명 playerId 포함) 이벤트는 귀속 금지 (B2)
                }
                String type = event.path("type").asText();
                out.computeIfAbsent(playerId, k -> new LinkedHashMap<>()).merge(type, 1L, Long::sum);
            }
        }
        return out;
    }

    /**
     * growth_applied 멱등 삽입 → 신규일 때만 stat_levels_json 갱신(레벨업 임계 지수 자동 반영).
     *
     * @return 이번 정산으로 레벨업한 스탯 키(없으면 빈 리스트). 이미 정산된 매치면 null(멱등 no-op).
     */
    private List<String> applyStatXp(String matchId, String userId, String playerId, Map<String, Integer> perStatDelta,
                                     EconomyService.Growth gc, String now) {
        int total = perStatDelta.values().stream().mapToInt(Integer::intValue).sum();
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO growth_applied(match_id, user_id, player_id, xp_delta, applied_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(matchId, userId, playerId, total, now)
                .update();
        if (inserted != 1) {
            return null; // 이미 정산됨 — 멱등 no-op
        }
        Map<String, StatLevelState> levels = loadStatLevels(userId, playerId);
        List<String> levelUps = new ArrayList<>();
        for (String stat : ATTR_KEYS) {
            int delta = perStatDelta.getOrDefault(stat, 0);
            if (delta <= 0) {
                continue;
            }
            StatLevelState before = levels.get(stat);
            StatLevelState after = applyForward(before, delta, gc);
            if (after.lv() > before.lv()) {
                levelUps.add(stat);
            }
            levels.put(stat, after);
        }
        int updated = jdbcClient.sql("UPDATE user_players SET stat_levels_json = ? WHERE user_id = ? AND player_id = ?")
                .params(writeStatLevelsJson(levels), userId, playerId)
                .update();
        if (updated != 1) {
            log.warn("stat_levels_json update affected {} rows for user={} player={}", updated, userId, playerId);
        }
        return levelUps;
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
        record AppliedRow(String playerId, int xpDelta, String reportJson) {
        }
        List<AppliedRow> rows = jdbcClient.sql("""
                        SELECT player_id, xp_delta, report_json FROM growth_applied
                        WHERE match_id = ? AND user_id = ? ORDER BY player_id
                        """)
                .params(matchId, userId)
                .query((rs, n) -> new AppliedRow(rs.getString("player_id"), rs.getInt("xp_delta"),
                        rs.getString("report_json")))
                .list();
        if (rows.isEmpty()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("matchId", matchId);
            out.put("entries", entries);
            return out;
        }
        // M1(#179 gverify): 정산 시점 스냅샷(report_json)이 있으면 그대로 반환 — 재계산 금지
        // (교체 mult 불일치·과거 리포트 드리프트·사이드 오귀속 전부 원천 차단).
        List<Applied> applied = new ArrayList<>();
        for (AppliedRow row : rows) {
            if (row.reportJson() != null) {
                try {
                    JsonNode snap = objectMapper.readTree(row.reportJson());
                    Map<String, Object> entry = new LinkedHashMap<>();
                    entry.put("playerId", row.playerId());
                    entry.put("name", playerName(row.playerId()));
                    entry.put("statXp", objectMapper.convertValue(snap.path("statXp"),
                            new TypeReference<Map<String, Integer>>() { }));
                    entry.put("levelUps", objectMapper.convertValue(snap.path("levelUps"),
                            new TypeReference<List<String>>() { }));
                    entry.put("ovrBefore", snap.path("ovrBefore").asDouble());
                    entry.put("ovrAfter", snap.path("ovrAfter").asDouble());
                    entries.add(entry);
                    continue;
                } catch (Exception e) {
                    log.warn("report snapshot parse failed for match={} player={} — 레거시 역산 폴백", matchId, row.playerId());
                }
            }
            applied.add(new Applied(row.playerId(), row.xpDelta()));
        }
        if (applied.isEmpty()) {
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("matchId", matchId);
            out.put("entries", entries);
            return out;
        }
        // ── 레거시 폴백(스냅샷 없는 구 정산분) — 근사 재계산. 유저 사이드는 home 근사(연습매치 항상 home).
        Map<String, Map<String, Long>> eventsByPlayer = eventCountsByPlayer(matchId, "home");
        Set<String> starters = snapshotStarters(matchId, userId);

        for (Applied a : applied) {
            PlayerBase pb = playerBase(a.playerId()).orElse(null);
            if (pb == null) {
                continue;
            }
            Map<String, Double> minutes = tuning().xp().minutesMult();
            double minutesMult = minutes.getOrDefault(
                    starters.contains(a.playerId()) ? "starter" : "bench", 0.0);
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
            EconomyService.Potential pc = economyService.get().map(EconomyService.Economy::potential)
                    .orElse(new EconomyService.Potential(Map.of(), Map.of(), Map.of(), Map.of(), 1.5, 1.0,
                            Map.of()));
            CardState card = cardState(userId, a.playerId());
            PotentialRow prow = potentialRow(userId, a.playerId()).orElse(PotentialRow.fresh());
            double ovrBefore = compute(pb, card, before, prow, tuning(), pc).ovr();
            double ovrAfter = compute(pb, card, after, prow, tuning(), pc).ovr();

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
