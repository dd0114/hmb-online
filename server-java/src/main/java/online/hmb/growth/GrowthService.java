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

    /**
     * 카드의 성장 상태. {@code level}/{@code xp} 는 #405 W2b 가 추가한 <b>카드 단위</b> 축이다 —
     * 구 모델의 스탯별 XP 풀 9개를 대체한다(설계 §2.1).
     */
    private record CardState(int star, int level, int xp) {
        static CardState fresh() {
            return new CardState(1, 1, 0);
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
                             Map<String, Double> caps, Map<String, Double> statAdd,
                             boolean potentialUnlocked, String potentialTier, String potentialMaxTier,
                             List<PotentialLine> potentialLines, int rollsSinceTierUp, int ceilingAt,
                             double ovr, double completion) {
    }

    // ── config 조회 (없으면 503) ────────────────────────────────────────

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

    /**
     * 순수 유효스탯 계산 — RNG 없음, DB 조회 결과만으로 결정론.
     * <b>모든 수치는 {@code tuning} 에서 온다</b>(하드코딩 0 — AC-G0).
     */
    private static Effective compute(PlayerBase pb, CardState card, Map<String, Double> add,
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
            // #405 W2b: 상승분은 **유저가 고른 3지선다의 gain 누적**(stat_add_json, 소수)이다.
            // W2a 의 "정수 lv 를 읽는 어댑터"는 여기서 은퇴했다 — 자동 상승 경로가 사라졌으므로
            // stat_levels_json 은 소급 이관의 입력이자 롤백 근거로만 남는다(설계 §2.1·§2.7).
            double addI = add.getOrDefault(stat, 0.0);
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
        Map<String, Double> addOut = new LinkedHashMap<>();
        for (String stat : ATTR_KEYS) {
            addOut.put(stat, round2(add.getOrDefault(stat, 0.0)));
        }
        return new Effective(pb.grade(), card.star(), attributes, prePotential, baseInt, caps, addOut,
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

    private static final String CARD_STATE_SQL =
            "SELECT star, card_level, card_xp FROM user_players WHERE user_id = ? AND player_id = ?";

    private Optional<CardState> cardStateOpt(String userId, String playerId) {
        return jdbcClient.sql(CARD_STATE_SQL)
                .params(userId, playerId)
                .query((rs, n) -> new CardState(rs.getInt("star"), Math.max(1, rs.getInt("card_level")),
                        rs.getInt("card_xp")))
                .optional();
    }

    private CardState cardState(String userId, String playerId) {
        return cardStateOpt(userId, playerId).orElse(CardState.fresh());
    }

    private CardState cardStateForUpdate(String userId, String playerId) {
        return cardStateOpt(userId, playerId)
                .orElseThrow(() -> ApiException.notFound("보유하지 않은 선수입니다: " + playerId));
    }

    /**
     * 상승분 누적({@code stat_add_json}) — 9종 전부 채워서 돌려준다(없는 키는 0.0).
     * <b>소수</b>인 이유는 감쇠 곡선(§2.3)이 상승폭을 소수로 주기 때문이다.
     */
    private Map<String, Double> loadStatAdd(String userId, String playerId) {
        String json = jdbcClient.sql("SELECT stat_add_json FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId).query(String.class).optional().orElse(null);
        return parseStatAdd(json);
    }

    private Map<String, Double> parseStatAdd(String json) {
        Map<String, Double> out = new LinkedHashMap<>();
        for (String stat : ATTR_KEYS) {
            out.put(stat, 0.0);
        }
        if (json == null || json.isBlank()) {
            return out;
        }
        try {
            Map<String, Object> raw = objectMapper.readValue(json, new TypeReference<Map<String, Object>>() { });
            raw.forEach((k, v) -> {
                if (v instanceof Number num && out.containsKey(k)) {
                    out.put(k, num.doubleValue());
                }
            });
        } catch (Exception e) {
            // 파싱 불가는 "성장 0"으로 눕히지 않는다 — 그러면 유저 자산이 조용히 사라진다.
            throw new IllegalStateException("stat_add_json 파싱 실패: " + json, e);
        }
        return out;
    }

    private String writeStatAdd(Map<String, Double> add) {
        try {
            Map<String, Object> out = new LinkedHashMap<>();
            add.forEach((k, v) -> out.put(k, round2(v)));
            return objectMapper.writeValueAsString(out);
        } catch (Exception e) {
            throw new IllegalStateException("stat_add_json 직렬화 실패: " + e.getMessage(), e);
        }
    }

    /**
     * 현재 pre-잠재 스탯 = {@code clamp(base + add, startLo, ceiling)}.
     * 감쇠 곡선과 천장 제외 판정이 <b>같은 값</b>을 봐야 하므로 자리를 하나로 고정한다.
     */
    private static Map<String, Double> prePotential(GrowthTuning tuning, PlayerBase pb, int star,
                                                    Map<String, Double> add) {
        GrowthTuning.Band band = GrowthMath.band(tuning, pb.grade());
        double ceiling = GrowthMath.ceiling(tuning, pb.grade(), star);
        Map<String, Double> out = new LinkedHashMap<>();
        for (String stat : ATTR_KEYS) {
            double baseI = pb.attributes().getOrDefault(stat, 0);
            out.put(stat, clamp(baseI + add.getOrDefault(stat, 0.0), band.startLo(), ceiling));
        }
        return out;
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
        GrowthTuning tuning = tuning();
        CardState card = cardState(userId, playerId);
        Map<String, Double> add = loadStatAdd(userId, playerId);
        PotentialRow prow = potentialRow(userId, playerId).orElse(PotentialRow.fresh());
        Effective e = compute(pb, card, add, prow, tuning, potentialCfg());
        Map<String, Object> out = toCardEffectiveMap(playerId, e);
        // #405 W2b additive (설계 §3, E1 #403 공유 계약) — 구 클라는 무시하면 그만이다.
        out.put("cardLevel", card.level());
        out.put("cardXp", card.xp());
        out.put("xpToNext", card.level() >= tuning.xp().maxLevel()
                ? 0 : GrowthMath.xpToNext(tuning, card.level()));
        out.put("maxLevel", tuning.xp().maxLevel());
        out.put("pendingChoices", pendingChoices(userId, playerId));
        // 구 모델의 스탯별 레벨 — 이제 <b>유효스탯에 관여하지 않는다</b>(소급 이관의 입력이자
        // 롤백 근거로만 남는다). 화면이 "성장 이력"을 보여줄 수 있도록 계속 싣는다.
        Map<String, Object> statLevels = new LinkedHashMap<>();
        loadStatLevels(userId, playerId).forEach((k, v) -> statLevels.put(k, Map.of("lv", v.lv(), "xp", v.xp())));
        out.put("statLevels", statLevels);
        return out;
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
            Map<String, Double> add = loadStatAdd(owner, playerId);
            PotentialRow prow = potentialRow(owner, playerId).orElse(PotentialRow.fresh());
            double before = compute(pb, card, add, prow, tuning, pc).ovr();
            double after = compute(hypothetical, card, add, prow, tuning, pc).ovr();
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
        out.put("statAdd", e.statAdd());
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
            Map<String, Double> add = loadStatAdd(userId, playerId);
            PotentialRow prow = potentialRow(userId, playerId).orElse(PotentialRow.fresh());
            Effective e = compute(pb, card, add, prow, tuning(),
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
     * <b>매치 정산 — 카드 XP 적립 + 레벨업마다 3지선다 선택권 생성</b>(#405 W2b, 설계 §2.4·§2.5).
     * MatchOrchestrator finishMatch 트랜잭션 안에서 1회 호출.
     *
     * <pre>
     *   matchXp     = xp.matchBase × minutesMult × resultMult × gradeMult × (1 + perfBonus)
     *   xpToNext(L) = round(xp.lvBase × L^xp.lvPow)
     * </pre>
     *
     * <p><b>스탯은 여기서 오르지 않는다.</b> 구 모델(V10)은 정산이 스탯별 XP 를 적립해 자동으로
     * 레벨업시켰고, 그것을 걷어내는 것이 이 개편의 내용이다 — 상승은 오직 유저의 선택
     * ({@link #applyChoice})으로만 일어난다. 계약 =
     * {@code GrowthCardLevelSettlementTest.settlementAloneRaisesNoStat}.
     *
     * <p>멱등은 그대로 {@code growth_applied}(PK match/user/player). 재정산은 INSERT 가 무시돼
     * XP·선택권이 늘지 않는다. 선택권 쪽에도 UNIQUE(user,player,level) 백스톱이 따로 있다 —
     * 앱의 check-then-act 는 경합을 못 막기 때문이다.
     *
     * <p>{@code report_json} 에 <b>정산에 쓴 계수 리비전</b>을 박제한다(설계 §2.8.3) — 성장 계수는
     * 매치 pin 을 하지 않으므로, 어떤 값으로 정산했는지는 이 필드만이 답할 수 있다.
     *
     * @param starters 스냅샷 선발 playerId, bench 스냅샷 벤치 playerId
     * @param subsOut  교체 아웃 playerId, subsIn 교체 인 playerId
     * @param result   {@code WIN|DRAW|LOSS} — 유저 관점(어웨이 리그경기면 유저 골=away)
     */
    public void settleMatch(String matchId, String userId,
                            List<String> starters, List<String> bench,
                            Set<String> subsOut, Set<String> subsIn, boolean userHome, String result) {
        GrowthTuning tuning = tuning();
        // B2(#179 gverify): 봇 로스터가 같은 카탈로그를 쓰므로 playerId 가 겹친다 —
        // 유저 사이드 이벤트만 귀속(event.team 필터). 아니면 상대 동명 선수 행동으로 XP 가 적립된다.
        String userSide = userHome ? "home" : "away";
        Map<String, Map<String, Long>> eventsByPlayer = eventCountsByPlayer(matchId, userSide);
        Map<String, Map<String, Double>> behaviorByPlayer = behaviorsByPlayer(matchId, userSide);
        String revisionId = growthConfig.currentRevisionId();
        String now = Instant.now().toString();
        List<String> roster = new ArrayList<>(starters);
        roster.addAll(bench);
        for (String pid : roster) {
            // 출전 배율도 계수다 — 코드에 0.5/1.0 을 적어 두면 그 값만 무배포 조정 밖에 남는다.
            String minutesKey;
            if (starters.contains(pid)) {
                minutesKey = subsOut.contains(pid) ? "partial" : "starter";
            } else {
                minutesKey = subsIn.contains(pid) ? "partial" : "bench"; // 미출전 XP=0(V2-1)
            }
            PlayerBase pb = playerBase(pid).orElse(null);
            if (pb == null) {
                continue;
            }
            Map<String, Long> events = eventsByPlayer.getOrDefault(pid, Map.of());
            double perfBonus = GrowthCandidates.perfBonus(tuning, events);
            double xpGained = GrowthMath.matchXp(tuning, pb.grade(), minutesKey, result, perfBonus);
            int xpDelta = (int) Math.round(xpGained);

            int inserted = jdbcClient.sql("""
                            INSERT OR IGNORE INTO growth_applied(match_id, user_id, player_id, xp_delta, applied_at)
                            VALUES (?, ?, ?, ?, ?)
                            """)
                    .params(matchId, userId, pid, xpDelta, now)
                    .update();
            if (inserted != 1) {
                continue;   // 이미 정산됨 — 멱등 no-op(기존 report_json 보존)
            }

            CardState card = cardState(userId, pid);
            GrowthMath.LevelState after = GrowthMath.applyXp(tuning, card.level(), card.xp(), xpGained);
            int updated = jdbcClient.sql(
                            "UPDATE user_players SET card_level = ?, card_xp = ? WHERE user_id = ? AND player_id = ?")
                    .params(after.level(), after.xp(), userId, pid)
                    .update();

            List<Map<String, Object>> pending = new ArrayList<>();
            if (updated == 1) {
                // 보유하지 않은 카드(스냅샷에는 있으나 그 사이 trade 로 나간 등)에는 선택권을 만들지
                // 않는다 — 고를 수 없는 대기 뱃지가 영원히 남는다.
                Map<String, Double> add = loadStatAdd(userId, pid);
                Map<String, Double> pre = prePotential(tuning, pb, card.star(), add);
                Map<String, Double> eventScore = GrowthCandidates.eventScore(tuning, events);
                Map<String, Double> behaviorScore = GrowthCandidates.behaviorScore(tuning,
                        behaviorByPlayer.getOrDefault(pid, Map.of()));
                for (int i = 0; i < after.levelUps(); i++) {
                    int level = card.level() + i;
                    grantChoice(tuning, userId, pid, pb, card.star(), level, matchId, matchId,
                            pre, eventScore, behaviorScore, result, now).ifPresent(pending::add);
                }
            }
            persistReportSnapshot(matchId, userId, pid, xpDelta, perfBonus, card.level(), after.level(),
                    pending, revisionId);
        }
    }

    /**
     * 정산 시점 스냅샷 — <b>재계산하지 않는다</b>(M1, #179 gverify). 계수가 바뀌면 과거 리포트가
     * 뒤늦게 다른 말을 하기 때문이다. {@code tuningRevisionId} 가 "그때 어떤 계수였나"의 답이다.
     */
    private void persistReportSnapshot(String matchId, String userId, String playerId,
                                       int xpGained, double perfBonus, int levelBefore, int levelAfter,
                                       List<Map<String, Object>> pendingChoices, String revisionId) {
        Map<String, Object> snap = new LinkedHashMap<>();
        snap.put("xpGained", xpGained);
        snap.put("perfBonus", round2(perfBonus));
        snap.put("levelBefore", levelBefore);
        snap.put("levelAfter", levelAfter);
        snap.put("pendingChoices", pendingChoices);
        snap.put("tuningRevisionId", revisionId);
        try {
            jdbcClient.sql("UPDATE growth_applied SET report_json = ? WHERE match_id = ? AND user_id = ? AND player_id = ?")
                    .params(objectMapper.writeValueAsString(snap), matchId, userId, playerId)
                    .update();
        } catch (Exception e) {
            log.warn("report snapshot persist failed for match={} player={}: {}", matchId, playerId, e.toString());
        }
    }

    /**
     * 하프별 AI 인풋({@code match_halves.home_input_json}/{@code away_input_json})에 박제된
     * {@code PlayerBehavior} 9 파라미터를 선수별로 모은다 — <b>프롬프트의 구조화 결과</b>다(설계 §2.5).
     *
     * <p>여러 하프에 등장하면 <b>평균</b>한다. 하프타임 지시로 역할이 바뀔 수 있고, 후반 투입 선수는
     * h1 에 아예 없다 — h1 만 읽으면 교체 투입 선수의 역할이 통째로 사라진다.
     */
    private Map<String, Map<String, Double>> behaviorsByPlayer(String matchId, String userSide) {
        String column = "home".equals(userSide) ? "home_input_json" : "away_input_json";
        Map<String, Map<String, Double>> sums = new LinkedHashMap<>();
        Map<String, Integer> counts = new LinkedHashMap<>();
        for (int half = 1; half <= 2; half++) {
            String json = jdbcClient.sql(
                            "SELECT " + column + " FROM match_halves WHERE match_id = ? AND half = ?")
                    .params(matchId, half).query(String.class).optional().orElse(null);
            if (json == null || json.isBlank()) {
                continue;
            }
            JsonNode root;
            try {
                root = objectMapper.readTree(json);
            } catch (Exception e) {
                continue;
            }
            for (JsonNode player : root.path("players")) {
                String pid = player.path("playerId").asText("");
                JsonNode behavior = player.path("behavior");
                if (pid.isEmpty() || !behavior.isObject()) {
                    continue;
                }
                Map<String, Double> acc = sums.computeIfAbsent(pid, k -> new LinkedHashMap<>());
                for (String param : GrowthTuning.BEHAVIORS) {
                    JsonNode value = behavior.get(param);
                    if (value != null && value.isNumber()) {
                        acc.merge(param, value.doubleValue(), Double::sum);
                    }
                }
                counts.merge(pid, 1, Integer::sum);
            }
        }
        Map<String, Map<String, Double>> out = new LinkedHashMap<>();
        sums.forEach((pid, acc) -> {
            int n = Math.max(1, counts.getOrDefault(pid, 1));
            Map<String, Double> avg = new LinkedHashMap<>();
            acc.forEach((param, total) -> avg.put(param, total / n));
            out.put(pid, avg);
        });
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

    // ── 3지선다 선택권 (설계 §2.5) ──────────────────────────────────────

    /**
     * 레벨업 1회분의 선택권을 만든다. <b>후보 3개 + 각각의 상승폭(gain)을 그 자리에서 박제</b>한다 —
     * 미루는 동안 다른 픽으로 스탯이 올라 gain 이 줄면 "화면엔 +2.9 였는데 +2.1 이 들어왔다"가 되기
     * 때문이다(hero 명시 요구, 설계 §2.5).
     *
     * <p>멱등: {@code UNIQUE(user_id, player_id, level)} 위의 {@code INSERT OR IGNORE}. 이미 있으면
     * <b>기존 행을 읽어</b> 돌려준다 — 재정산·재백필이 같은 답을 주는 것이 이 계약의 내용이다.
     *
     * @param seedSource 시드 접두. 매치 정산은 {@code matchId}, 소급 지급은 {@code "legacy"}.
     * @return 후보가 하나도 없으면(전 스탯 천장) {@code empty} — <b>빈 선택 대기를 만들지 않는다</b>.
     */
    private Optional<Map<String, Object>> grantChoice(GrowthTuning tuning, String userId, String playerId,
                                                      PlayerBase pb, int star, int level,
                                                      String seedSource, String sourceMatchId,
                                                      Map<String, Double> prePotential,
                                                      Map<String, Double> eventScore,
                                                      Map<String, Double> behaviorScore,
                                                      String result, String now) {
        String seed = GrowthCandidates.seed(seedSource, userId, playerId, level);
        GrowthCandidates.Draw draw = GrowthCandidates.draw(tuning, seed, pb.position(), pb.grade(), star,
                prePotential, eventScore, behaviorScore, result, level);
        if (draw.isEmpty()) {
            return Optional.empty();
        }
        String id = Ulid.next();
        String candidatesJson = writeCandidates(draw.choices());
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO growth_level_choices(id, user_id, player_id, level,
                            candidates_json, seed, source_match_id, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(id, userId, playerId, level, candidatesJson, seed, sourceMatchId, now)
                .update();
        if (inserted != 1) {
            return choiceRow(userId, playerId, level).map(GrowthService::toChoiceMap);
        }
        return Optional.of(toChoiceMap(new ChoiceRow(id, userId, playerId, level, draw.choices(), null)));
    }

    /** 선택권 한 행 — 후보는 <b>박제된 그대로</b> 읽는다(재계산하지 않는다). */
    private record ChoiceRow(String id, String userId, String playerId, int level,
                             List<GrowthCandidates.Choice> candidates, String chosenStat) {
    }

    private static Map<String, Object> toChoiceMap(ChoiceRow row) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("choiceId", row.id());
        out.put("playerId", row.playerId());
        out.put("level", row.level());
        out.put("candidates", row.candidates().stream().map(c -> {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("stat", c.stat());
            m.put("gain", round2(c.gain()));
            return (Object) m;
        }).toList());
        return out;
    }

    private String writeCandidates(List<GrowthCandidates.Choice> choices) {
        try {
            List<Map<String, Object>> raw = new ArrayList<>();
            for (GrowthCandidates.Choice c : choices) {
                Map<String, Object> m = new LinkedHashMap<>();
                m.put("stat", c.stat());
                m.put("gain", round2(c.gain()));
                raw.add(m);
            }
            return objectMapper.writeValueAsString(raw);
        } catch (Exception e) {
            throw new IllegalStateException("candidates_json 직렬화 실패: " + e.getMessage(), e);
        }
    }

    private List<GrowthCandidates.Choice> readCandidates(String json) {
        try {
            List<Map<String, Object>> raw = objectMapper.readValue(json,
                    new TypeReference<List<Map<String, Object>>>() { });
            List<GrowthCandidates.Choice> out = new ArrayList<>();
            for (Map<String, Object> m : raw) {
                out.add(new GrowthCandidates.Choice((String) m.get("stat"),
                        ((Number) m.get("gain")).doubleValue()));
            }
            return out;
        } catch (Exception e) {
            // 박제본이 안 읽히면 유저가 무엇을 고르는지 서버도 모른다 — 조용히 빈 후보로 눕히지 않는다.
            throw new IllegalStateException("candidates_json 파싱 실패: " + json, e);
        }
    }

    private Optional<ChoiceRow> choiceRow(String userId, String playerId, int level) {
        return jdbcClient.sql("""
                        SELECT id, user_id, player_id, level, candidates_json, chosen_stat
                        FROM growth_level_choices WHERE user_id = ? AND player_id = ? AND level = ?
                        """)
                .params(userId, playerId, level)
                .query(this::mapChoiceRow)
                .optional();
    }

    private ChoiceRow mapChoiceRow(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new ChoiceRow(rs.getString("id"), rs.getString("user_id"), rs.getString("player_id"),
                rs.getInt("level"), readCandidates(rs.getString("candidates_json")),
                rs.getString("chosen_stat"));
    }

    /**
     * 대기 중인 선택권 목록(GET /api/growth/choices). {@code playerId} 가 null 이면 전 카드.
     * 정렬은 (playerId, level) — 화면이 "어느 카드의 몇 레벨"을 순서대로 그릴 수 있어야 한다.
     */
    public List<Map<String, Object>> pendingChoices(String userId, String playerId) {
        String sql = """
                SELECT id, user_id, player_id, level, candidates_json, chosen_stat
                FROM growth_level_choices
                WHERE user_id = ? AND chosen_stat IS NULL
                """ + (playerId == null ? "" : " AND player_id = ?")
                + " ORDER BY player_id, level";
        var spec = playerId == null
                ? jdbcClient.sql(sql).params(userId)
                : jdbcClient.sql(sql).params(userId, playerId);
        return spec.query(this::mapChoiceRow).list().stream().map(GrowthService::toChoiceMap).toList();
    }

    /**
     * <b>선택 적용</b>(POST /api/growth/choices/{choiceId}) — 박제된 gain 을 {@code stat_add_json} 에
     * 가산한다. 화면에 보였던 숫자가 그대로 들어가는 것이 이 경로의 계약이다(재계산 금지).
     *
     * <p>중복 선택은 <b>CAS</b>(`WHERE chosen_stat IS NULL`)로 막는다 — 읽고 나서 쓰는 사이에 다른
     * 요청이 끼면 같은 선택권이 두 번 적용되고, 그건 스탯을 공짜로 두 배 주는 사고다.
     */
    public Map<String, Object> applyChoice(String userId, String choiceId, String stat) {
        if (stat == null || stat.isBlank()) {
            throw ApiException.validation("stat이 필요합니다");
        }
        return txRunner.run(() -> {
            ChoiceRow row = jdbcClient.sql("""
                            SELECT id, user_id, player_id, level, candidates_json, chosen_stat
                            FROM growth_level_choices WHERE id = ?
                            """)
                    .param(choiceId)
                    .query(this::mapChoiceRow)
                    .optional()
                    // 남의 선택권도 **404** 다 — 403 은 "그 id 는 실재한다"를 흘린다.
                    .filter(r -> r.userId().equals(userId))
                    .orElseThrow(() -> ApiException.notFound("선택권을 찾을 수 없습니다: " + choiceId));
            if (row.chosenStat() != null) {
                throw new ApiException(HttpStatus.CONFLICT, "CHOICE_ALREADY_MADE",
                        "이미 선택한 성장입니다", Map.of("choiceId", choiceId, "stat", row.chosenStat()));
            }
            GrowthCandidates.Choice picked = row.candidates().stream()
                    .filter(c -> c.stat().equals(stat))
                    .findFirst()
                    .orElseThrow(() -> new ApiException(HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                            "후보에 없는 능력치입니다: " + stat,
                            Map.of("choiceId", choiceId,
                                    "candidates", row.candidates().stream()
                                            .map(GrowthCandidates.Choice::stat).toList())));

            int updated = jdbcClient.sql("""
                            UPDATE growth_level_choices SET chosen_stat = ?, chosen_at = ?
                            WHERE id = ? AND chosen_stat IS NULL
                            """)
                    .params(stat, Instant.now().toString(), choiceId)
                    .update();
            if (updated != 1) {
                throw new ApiException(HttpStatus.CONFLICT, "CHOICE_ALREADY_MADE",
                        "이미 선택한 성장입니다", Map.of("choiceId", choiceId));
            }

            Map<String, Double> add = loadStatAdd(userId, row.playerId());
            add.merge(stat, picked.gain(), Double::sum);
            int applied = jdbcClient.sql(
                            "UPDATE user_players SET stat_add_json = ? WHERE user_id = ? AND player_id = ?")
                    .params(writeStatAdd(add), userId, row.playerId())
                    .update();
            if (applied != 1) {
                // 보유하지 않은 카드에 선택권이 있을 수 없다(생성 경로가 보유를 확인한다). 여기 오면
                // 그 사이 카드가 사라진 것이므로 선택도 없던 일이 되어야 한다.
                throw new ApiException(HttpStatus.CONFLICT, "CHOICE_CARD_MISSING",
                        "보유하지 않은 선수입니다: " + row.playerId(), Map.of("playerId", row.playerId()));
            }

            Map<String, Object> out = new LinkedHashMap<>();
            out.put("choiceId", choiceId);
            out.put("playerId", row.playerId());
            out.put("level", row.level());
            out.put("stat", stat);
            out.put("gain", round2(picked.gain()));
            out.put("card", cardEffective(userId, row.playerId()));
            return out;
        });
    }

    // ── GET /api/growth/report/{matchId} ────────────────────────────────

    /**
     * 매치 성장 리포트 — {@code growth_applied.report_json}(정산 시점 스냅샷)을 그대로 돌려준다.
     *
     * <p>⚠️ #405 W2b 로 <b>재계산 폴백이 사라졌다</b>. 구현이 사라진 게 아니라 <b>재계산이 불가능</b>
     * 해졌기 때문이다: 구 모델은 "매치 로그 → 스탯 XP" 가 순함수라 역산할 수 있었지만, 신 모델의
     * 결과는 <b>유저가 무엇을 골랐는가</b>에 달려 있어 로그만으로 복원되지 않는다. 스냅샷 없는
     * 구 정산분(W2b 이전)은 최소 정보(xp)만 싣는다 — 없는 것을 지어내는 것보다 낫다.
     */
    public Map<String, Object> growthReport(String userId, String matchId) {
        List<Map<String, Object>> entries = growthEntries(userId, matchId);
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("matchId", matchId);
        out.put("entries", entries);
        return out;
    }

    /**
     * 보상 봉투(§2.9)의 {@code GROWTH} 섹션 엔트리이자 성장 리포트의 본문 — <b>같은 자료</b>다.
     * 두 곳이 다른 형태를 만들면 화면 둘이 같은 경기를 다르게 말한다.
     */
    public List<Map<String, Object>> growthEntries(String userId, String matchId) {
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
        List<Map<String, Object>> entries = new ArrayList<>();
        for (AppliedRow row : rows) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("playerId", row.playerId());
            PlayerBase pb = playerBase(row.playerId()).orElse(null);
            entry.put("name", playerName(row.playerId()));
            entry.put("position", pb == null ? null : pb.position());
            entry.put("grade", pb == null ? null : pb.grade());
            entry.put("xpGained", row.xpDelta());
            if (row.reportJson() == null) {
                entry.put("levelBefore", null);
                entry.put("levelAfter", null);
                entry.put("pendingChoices", List.of());
                entries.add(entry);
                continue;
            }
            try {
                JsonNode snap = objectMapper.readTree(row.reportJson());
                entry.put("xpGained", snap.path("xpGained").asInt(row.xpDelta()));
                entry.put("levelBefore", snap.path("levelBefore").isNumber()
                        ? snap.path("levelBefore").asInt() : null);
                entry.put("levelAfter", snap.path("levelAfter").isNumber()
                        ? snap.path("levelAfter").asInt() : null);
                entry.put("pendingChoices", objectMapper.convertValue(snap.path("pendingChoices"),
                        new TypeReference<List<Map<String, Object>>>() { }));
            } catch (Exception e) {
                log.warn("report snapshot parse failed for match={} player={}", matchId, row.playerId());
                entry.put("pendingChoices", List.of());
            }
            entries.add(entry);
        }
        return entries;
    }

    // ── 소급 이관 지급 (설계 §2.7) ──────────────────────────────────────

    /**
     * <b>소급 선택권 지급</b> — {@link GrowthLegacyBackfillService} 전용 진입점.
     *
     * <p>매치 컨텍스트가 없으므로 후보 가중은 <b>포지션 baseline + 그 카드에 쌓여 있던 스탯 XP 분포</b>
     * 로 정한다(설계 §2.7). 그 분포가 곧 "이 카드가 실제로 무엇을 했나"의 이력이라 정합적이다 —
     * 매치 이벤트 자리에 그대로 넣는다({@code eventScore} 인자).
     *
     * <p>멱등: 레벨마다 {@code UNIQUE(user,player,level)} 라 재실행이 행을 늘리지 않고,
     * {@code card_level} 은 계산이 아니라 <b>실제 선택권 수</b>에서 파생하므로 두 번 돌아도 같은 값이다.
     *
     * @param grantCount 지급할 선택권 수(호출부가 이미 {@code legacy.levelGrantCap}·만렙으로 클램프)
     * @param historyScore 스탯별 성장 이력 점수(정규화는 후보 추첨이 한다)
     * @return 실제로 존재하게 된 선택권 수(= card_level − 1)
     */
    public int grantLegacyChoices(String userId, String playerId, int grantCount,
                                  Map<String, Double> historyScore) {
        GrowthTuning tuning = tuning();
        PlayerBase pb = playerBase(playerId).orElse(null);
        if (pb == null) {
            return 0;
        }
        CardState card = cardState(userId, playerId);
        Map<String, Double> add = loadStatAdd(userId, playerId);
        Map<String, Double> pre = prePotential(tuning, pb, card.star(), add);
        String now = Instant.now().toString();
        for (int i = 0; i < grantCount; i++) {
            int level = i + 1;
            grantChoice(tuning, userId, playerId, pb, card.star(), level, LEGACY_SEED_SOURCE, null,
                    pre, historyScore, Map.of(), null, now);
        }
        int granted = jdbcClient.sql("""
                        SELECT COUNT(*) FROM growth_level_choices
                        WHERE user_id = ? AND player_id = ? AND source_match_id IS NULL
                        """)
                .params(userId, playerId).query(Integer.class).single();
        jdbcClient.sql("UPDATE user_players SET card_level = ? WHERE user_id = ? AND player_id = ?")
                .params(granted + 1, userId, playerId)
                .update();
        return granted;
    }

    /**
     * 소급 지급분의 시드 접두. 매치 정산은 {@code matchId} 를 쓰므로, 이 문자열이 매치 id 와 겹치지
     * 않는 한 같은 (유저, 카드, 레벨)의 두 지급이 같은 후보를 갖는 일이 없다.
     */
    static final String LEGACY_SEED_SOURCE = "legacy:";

    private String playerName(String playerId) {
        return jdbcClient.sql("SELECT name FROM players WHERE id = ?")
                .param(playerId).query(String.class).optional().orElse(playerId);
    }
}
