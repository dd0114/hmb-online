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
     */
    public record Economy(String version, int initialPoints, List<String> starterPack,
                          Gacha gacha, Rewards rewards, JsonNode trade, JsonNode league,
                          Growth growth, Enhance enhance) {
    }

    /** economy.v1.json `gacha` 노드 — 뽑기 비용·확률표·pity (AC-S5: 여기서만 온다). */
    public record Gacha(int singleCost, int tenCost, int tenCount,
                        Map<String, Double> rates, String tenPityMinGrade) {
    }

    /** economy.v1.json `rewards` 노드 — 매치 보상 승/무/패 (AC-M6, ref=matchId 멱등 지급). */
    public record Rewards(int win, int draw, int loss) {
    }

    /**
     * economy.v2.json `growth` 노드 (에픽 #179 §7) — 경기 성장 트랙 수치. G1 이 프리즈한 값(하드코딩 금지).
     * baselineByPosition = {FW|MF|DF|GK: {능력치: 방향 가중치}}(합≈1) — 성장 방향 w + OVR 가중치.
     */
    public record Growth(int xpBase, int xpPerLevel, int completeMatches,
                         double benchGrowthMult, double execMatchDefault, double speedMaxMult,
                         Map<String, Map<String, Double>> baselineByPosition) {
    }

    /** economy.v2.json `enhance` 노드 (에픽 #179 §7) — 가챠 강화·한계돌파 트랙 수치. */
    public record Enhance(int maxEnhance, double enhanceStep, double autoFillRatio,
                          int limitBreakCopies, int maxLimitBreak, int pointCost) {
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

            // growth/enhance 블록(#179, G1 프리즈) — 구파일엔 없을 수 있어 null 로 둔다(성장 기능 비활성).
            Growth growth = parseGrowth(root.path("growth"));
            Enhance enhance = parseEnhance(root.path("enhance"));

            log.info("Loaded economy {} from {} (initialPoints={}, starterPack={} players, "
                            + "gacha single/ten={}/{} tenCount={} pity>={}, rewards {}/{}/{}, "
                            + "trade={}, league={}, growth={}, enhance={})",
                    version, file.getAbsolutePath(), initialPoints, starterPack.size(),
                    gacha.singleCost(), gacha.tenCost(), gacha.tenCount(), gacha.tenPityMinGrade(),
                    rewards.win(), rewards.draw(), rewards.loss(),
                    trade != null ? "present" : "absent", league != null ? "present" : "absent",
                    growth != null ? "present" : "absent", enhance != null ? "present" : "absent");
            return Optional.of(new Economy(version, initialPoints, List.copyOf(starterPack), gacha, rewards,
                    trade, league, growth, enhance));
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to load economy from {}: {} — continuing without economy config",
                    file.getAbsolutePath(), e.toString());
            return Optional.empty();
        }
    }

    /** `growth` 노드 파싱 — 없으면 null(성장 기능 비활성, 부팅은 계속). */
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
        return new Growth(
                g.path("xpBase").asInt(100),
                g.path("xpPerLevel").asInt(300),
                g.path("completeMatches").asInt(36),
                g.path("benchGrowthMult").asDouble(0.2),
                g.path("execMatchDefault").asDouble(0.6),
                g.path("speedMaxMult").asDouble(3.0),
                Map.copyOf(baseline));
    }

    /** `enhance` 노드 파싱 — 없으면 null. */
    private static Enhance parseEnhance(JsonNode e) {
        if (e == null || e.isMissingNode() || !e.isObject()) {
            return null;
        }
        return new Enhance(
                e.path("maxEnhance").asInt(5),
                e.path("enhanceStep").asDouble(2.0),
                e.path("autoFillRatio").asDouble(0.25),
                e.path("limitBreakCopies").asInt(3),
                e.path("maxLimitBreak").asInt(4),
                e.path("pointCost").asInt(200));
    }

    public Optional<Economy> get() {
        return economy;
    }
}
