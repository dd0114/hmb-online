package online.hmb.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * economy.v1.json(data 도메인 산출물) 로더 — 경제 수치의 SoT (AC-S5: 코드 하드코딩 금지).
 * W1 소비 범위: initialPoints + starterPack(스타터 팩 14명). gacha/rewards는 W2/W3에서 소비.
 *
 * 파일이 없으면 empty — 로그인 시 스타터 팩 지급을 건너뛰고 경고만 남긴다(부팅은 계속,
 * §0.5 도메인 분할: data 에픽 산출물을 대신 생성하지 않는다).
 */
@Component
public class EconomyService {

    private static final Logger log = LoggerFactory.getLogger(EconomyService.class);

    /**
     * 경제 수치 스냅샷 (W1: initialPoints/starterPack + trade/league 블록 로드, W2: gacha·trade, W3: rewards·league).
     * trade/league 는 economy.v2.json 의 신규 블록 — W1 은 로드만(소비는 W2/W3). 구파일(블록 없음)엔 null.
     * growth/star/potential/dice = 에픽 #179 메이플 피벗(V2) — 구 enhance 블록은 폐기.
     */
    public record Economy(String version, int initialPoints, List<String> starterPack,
                          Gacha gacha, Rewards rewards, JsonNode trade, JsonNode league,
                          Growth growth, Star star, Potential potential, Dice dice, Gems gems) {
    }

    /** economy.v1.json `gacha` 노드 — 뽑기 비용·확률표·pity (AC-S5: 여기서만 온다). */
    public record Gacha(int singleCost, int tenCost, int tenCount,
                        Map<String, Double> rates, String tenPityMinGrade) {
    }

    /** economy.v1.json `rewards` 노드 — 매치 보상 승/무/패 (AC-M6, ref=matchId 멱등 지급). */
    public record Rewards(int win, int draw, int loss) {
    }

    /**
     * economy.v2.json `growth` 노드 (에픽 #179 V2-5, 메이플 피벗 GM1) — 경기 스탯별 XP 트랙 수치.
     * baselineByPosition = {FW|MF|DF|GK: {능력치: 방향 가중치}}(합≈1) — XP 방향 가중치 + OVR 가중치 겸용.
     * eventStatMap = {이벤트타입: {능력치: 가중치}} — match-log 이벤트 카운트 × 가중치 = eventBonus.
     */
    public record Growth(int xpBase, int xpLvBase, double xpLvGrowth,
                         Map<String, Double> gradeXpMult, Map<String, Double> minutesMult,
                         Map<String, Map<String, Double>> baselineByPosition,
                         Map<String, Map<String, Double>> eventStatMap) {
    }

    /** economy.v2.json `star` 노드 (에픽 #179 V2-5) — 성★ 승급(중복 소모·스탯 천장 개방 비율). */
    public record Star(Map<Integer, Integer> copies, Map<Integer, Double> starFrac) {
    }

    /** 잠재 옵션 테이블 1행 — type(STAT_PCT|STAT_FLAT|CONDITION_RECOVERY|TEAM_MORALE), stat(STAT_* 만). */
    public record PotentialOption(String type, String stat, double value, double weight, boolean premium) {
    }

    /**
     * economy.v2.json `potential` 노드 (에픽 #179 V2-5) — 잠재능력 3줄·티어·다이스 확률.
     * cashPremiumMult = 캐시 다이스가 premium=true 옵션 weight 에 곱하는 배수(GM1 신설).
     */
    public record Potential(Map<String, Integer> linesByGrade, Map<String, String> gradeTierCap,
                            Map<Integer, String> starTierCap, Map<String, Double> tierUp,
                            double ceilingMult, double cashPremiumMult,
                            Map<String, List<PotentialOption>> tables) {
    }

    /**
     * economy.v2.json `dice` 노드 (에픽 #179 V2-5, V2.2 재화 이원화로 cashCost→cashGemCost 개정) —
     * 다이스 상점 가격. 노말=P, 캐시=젬 전용(cashGemCost).
     */
    public record Dice(int normalCost, int cashGemCost) {
    }

    /** economy.v2.json `gems` 노드 팩 1종 — 충전 목업(실결제 없음, 즉시 지급). */
    public record GemTopupPack(String id, int gems, String mockPrice) {
    }

    /** economy.v2.json `gems` 노드 (V2.2 재화 이원화 GM8s) — 충전 팩 목록. */
    public record Gems(List<GemTopupPack> topupPacks) {
    }

    private final Optional<Economy> economy;

    public EconomyService(ObjectMapper objectMapper,
                          @Value("${hmb.data.economy-file}") String economyFile) {
        this.economy = load(objectMapper, economyFile);
    }

    private static Optional<Economy> load(ObjectMapper objectMapper, String path) {
        File file = new File(path);
        if (!file.exists()) {
            log.warn("economy file not found at {} — starter pack / economy features disabled until published",
                    file.getAbsolutePath());
            return Optional.empty();
        }
        try {
            JsonNode root = objectMapper.readTree(file);
            String version = root.path("version").asText("v1");
            int initialPoints = root.path("initialPoints").asInt();
            List<String> starterPack = new ArrayList<>();
            root.path("starterPack").forEach(n -> starterPack.add(n.asText()));

            JsonNode g = root.path("gacha");
            Map<String, Double> rates = new LinkedHashMap<>();
            g.path("rates").properties().forEach(e -> rates.put(e.getKey(), e.getValue().asDouble()));
            Gacha gacha = new Gacha(
                    g.path("singleCost").asInt(),
                    g.path("tenCost").asInt(),
                    g.path("tenCount").asInt(),
                    Map.copyOf(rates),
                    g.path("tenPityMinGrade").asText());

            JsonNode r = root.path("rewards");
            Rewards rewards = new Rewards(
                    r.path("win").asInt(), r.path("draw").asInt(), r.path("loss").asInt());

            // trade/league 블록(economy.v2 신규) — W1 은 로드만, 구파일엔 없을 수 있어 null 로 둔다.
            JsonNode trade = root.has("trade") ? root.get("trade") : null;
            JsonNode league = root.has("league") ? root.get("league") : null;

            // growth/star/potential/dice 블록(#179 V2-5, GM1 발행) — 구파일엔 없을 수 있어 null(성장 기능 비활성).
            Growth growth = parseGrowth(root.path("growth"));
            Star star = parseStar(root.path("star"));
            Potential potential = parsePotential(root.path("potential"));
            Dice dice = parseDice(root.path("dice"));
            // gems 블록(V2.2 재화 이원화 GM8s) — 구파일엔 없을 수 있어 null(충전 목업 기능 비활성).
            Gems gems = parseGems(root.path("gems"));

            log.info("Loaded economy {} from {} (initialPoints={}, starterPack={} players, "
                            + "gacha single/ten={}/{} tenCount={} pity>={}, rewards {}/{}/{}, "
                            + "trade={}, league={}, growth={}, star={}, potential={}, dice={}, gems={})",
                    version, file.getAbsolutePath(), initialPoints, starterPack.size(),
                    gacha.singleCost(), gacha.tenCost(), gacha.tenCount(), gacha.tenPityMinGrade(),
                    rewards.win(), rewards.draw(), rewards.loss(),
                    trade != null ? "present" : "absent", league != null ? "present" : "absent",
                    growth != null ? "present" : "absent", star != null ? "present" : "absent",
                    potential != null ? "present" : "absent", dice != null ? "present" : "absent",
                    gems != null ? "present" : "absent");
            return Optional.of(new Economy(version, initialPoints, List.copyOf(starterPack), gacha, rewards,
                    trade, league, growth, star, potential, dice, gems));
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to load economy from {}: {} — continuing without economy config",
                    file.getAbsolutePath(), e.toString());
            return Optional.empty();
        }
    }

    /** `growth` 노드 파싱(V2-5) — 없으면 null(성장 기능 비활성, 부팅은 계속). */
    private static Growth parseGrowth(JsonNode g) {
        if (g == null || g.isMissingNode() || !g.isObject()) {
            return null;
        }
        Map<String, Map<String, Double>> baseline = new LinkedHashMap<>();
        g.path("baselineByPosition").properties().forEach(posEntry -> {
            Map<String, Double> weights = new LinkedHashMap<>();
            posEntry.getValue().properties().forEach(w -> weights.put(w.getKey(), w.getValue().asDouble()));
            baseline.put(posEntry.getKey(), Map.copyOf(weights));
        });
        Map<String, Map<String, Double>> eventStatMap = new LinkedHashMap<>();
        g.path("eventStatMap").properties().forEach(evEntry -> {
            Map<String, Double> weights = new LinkedHashMap<>();
            evEntry.getValue().properties().forEach(w -> weights.put(w.getKey(), w.getValue().asDouble()));
            eventStatMap.put(evEntry.getKey(), Map.copyOf(weights));
        });
        return new Growth(
                g.path("xpBase").asInt(100),
                g.path("xpLvBase").asInt(100),
                g.path("xpLvGrowth").asDouble(1.7),
                Map.copyOf(asDoubleMap(g.path("gradeXpMult"))),
                Map.copyOf(asDoubleMap(g.path("minutesMult"))),
                Map.copyOf(baseline),
                Map.copyOf(eventStatMap));
    }

    /** `star` 노드 파싱(V2-5) — 없으면 null. 키(2/3/4)는 목표 성(★) 정수. */
    private static Star parseStar(JsonNode s) {
        if (s == null || s.isMissingNode() || !s.isObject()) {
            return null;
        }
        Map<Integer, Integer> copies = new LinkedHashMap<>();
        s.path("copies").properties().forEach(e -> copies.put(Integer.parseInt(e.getKey()), e.getValue().asInt()));
        Map<Integer, Double> starFrac = new LinkedHashMap<>();
        s.path("starFrac").properties()
                .forEach(e -> starFrac.put(Integer.parseInt(e.getKey()), e.getValue().asDouble()));
        return new Star(Map.copyOf(copies), Map.copyOf(starFrac));
    }

    /** `potential` 노드 파싱(V2-5) — 없으면 null. tables[tier] = 옵션 리스트(고정 value·weight·premium). */
    private static Potential parsePotential(JsonNode p) {
        if (p == null || p.isMissingNode() || !p.isObject()) {
            return null;
        }
        Map<String, Integer> linesByGrade = new LinkedHashMap<>();
        p.path("linesByGrade").properties().forEach(e -> linesByGrade.put(e.getKey(), e.getValue().asInt()));
        Map<String, String> gradeTierCap = new LinkedHashMap<>();
        p.path("gradeTierCap").properties().forEach(e -> gradeTierCap.put(e.getKey(), e.getValue().asText()));
        Map<Integer, String> starTierCap = new LinkedHashMap<>();
        p.path("starTierCap").properties()
                .forEach(e -> starTierCap.put(Integer.parseInt(e.getKey()), e.getValue().asText()));
        Map<String, Double> tierUp = asDoubleMap(p.path("tierUp"));
        Map<String, List<PotentialOption>> tables = new LinkedHashMap<>();
        p.path("tables").properties().forEach(tierEntry -> {
            List<PotentialOption> options = new ArrayList<>();
            tierEntry.getValue().forEach(o -> options.add(new PotentialOption(
                    o.path("type").asText(),
                    o.hasNonNull("stat") ? o.path("stat").asText() : null,
                    o.path("value").asDouble(),
                    o.path("weight").asDouble(1.0),
                    o.path("premium").asBoolean(false))));
            tables.put(tierEntry.getKey(), List.copyOf(options));
        });
        return new Potential(Map.copyOf(linesByGrade), Map.copyOf(gradeTierCap), Map.copyOf(starTierCap),
                Map.copyOf(tierUp), p.path("ceilingMult").asDouble(1.5),
                p.path("cashPremiumMult").asDouble(1.0), Map.copyOf(tables));
    }

    /** `dice` 노드 파싱(V2-5, V2.2 로 cashCost→cashGemCost 개정) — 없으면 null. */
    private static Dice parseDice(JsonNode d) {
        if (d == null || d.isMissingNode() || !d.isObject()) {
            return null;
        }
        return new Dice(d.path("normalCost").asInt(500), d.path("cashGemCost").asInt(10));
    }

    /** `gems` 노드 파싱(V2.2 재화 이원화 GM8s) — 없으면 null(충전 목업 비활성). */
    private static Gems parseGems(JsonNode g) {
        if (g == null || g.isMissingNode() || !g.isObject()) {
            return null;
        }
        List<GemTopupPack> packs = new ArrayList<>();
        g.path("topupPacks").forEach(p -> packs.add(new GemTopupPack(
                p.path("id").asText(),
                p.path("gems").asInt(),
                p.path("mockPrice").asText())));
        return new Gems(List.copyOf(packs));
    }

    private static Map<String, Double> asDoubleMap(JsonNode node) {
        Map<String, Double> out = new LinkedHashMap<>();
        if (node != null && node.isObject()) {
            node.properties().forEach(e -> out.put(e.getKey(), e.getValue().asDouble()));
        }
        return out;
    }

    public Optional<Economy> get() {
        return economy;
    }
}
