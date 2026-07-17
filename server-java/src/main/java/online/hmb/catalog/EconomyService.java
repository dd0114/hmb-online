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

    /** 경제 수치 스냅샷(W1: initialPoints/starterPack, W2: gacha). rewards는 W3에서 확장. */
    public record Economy(String version, int initialPoints, List<String> starterPack, Gacha gacha) {
    }

    /** economy.v1.json `gacha` 노드 — 뽑기 비용·확률표·pity (AC-S5: 여기서만 온다). */
    public record Gacha(int singleCost, int tenCost, int tenCount,
                        Map<String, Double> rates, String tenPityMinGrade) {
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

            log.info("Loaded economy {} from {} (initialPoints={}, starterPack={} players, "
                            + "gacha single/ten={}/{} tenCount={} pity>={})",
                    version, file.getAbsolutePath(), initialPoints, starterPack.size(),
                    gacha.singleCost(), gacha.tenCost(), gacha.tenCount(), gacha.tenPityMinGrade());
            return Optional.of(new Economy(version, initialPoints, List.copyOf(starterPack), gacha));
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to load economy from {}: {} — continuing without economy config",
                    file.getAbsolutePath(), e.toString());
            return Optional.empty();
        }
    }

    public Optional<Economy> get() {
        return economy;
    }
}
