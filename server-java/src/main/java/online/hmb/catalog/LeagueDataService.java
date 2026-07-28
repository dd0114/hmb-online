package online.hmb.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;

/**
 * league.v1.json(data 도메인 산출물) 로더 — 리그 봇팀 구성·페르소나·순위 보상표의 SoT
 * (AC-S5/AC-F: 코드 하드코딩 금지). W1 은 <b>로드만</b>(부팅 시 존재·버전 확인) — 실제 소비(봇팀
 * 생성·일정·보상)는 W3 리그 웨이브. 파일이 없으면 empty + 경고만(부팅은 계속, §0.5 도메인 분할:
 * data 에픽 산출물을 대신 생성하지 않는다).
 *
 * <p>파일 형태(data 에픽 산출물): {version, clubNames[], personaPresets[{id,name,description,
 * formation,tactics{line,press,tempo,width}}], rewards[{rank,points}]}.
 */
@Component
public class LeagueDataService {

    private static final Logger log = LoggerFactory.getLogger(LeagueDataService.class);

    /** 리그 데이터 스냅샷 — clubNames/personaPresets/rewards 는 원본 JsonNode 로 보존(W3 소비). */
    public record LeagueData(String version, List<String> clubNames,
                             JsonNode personaPresets, List<RankReward> rewards,
                             List<Division> divisions) {
    }

    /** 순위 보상 행 — rank(1..N) → points (AC-F4, 원장 ref=seasonId 멱등 지급은 W3). */
    public record RankReward(int rank, int points) {
    }

    /**
     * 디비전 사다리 한 칸(#252). {@code gradeSlots} 가 봇 <b>선발 XI 11명</b>의 등급이고
     * <b>slot 0 은 GK</b> 다 — 이 배열이 곧 상대 강도다. {@code strengthMul} 은 등급 슬롯만으로
     * 하한(전원 BRONZE)을 못 넘는 입문 구간용 미세 배율(1.0 = 미적용).
     *
     * <p>league.v2.json 이 SoT — 값을 코드에 두지 않는다(AC-S5).
     */
    public record Division(int level, String name, String shortName,
                           List<String> gradeSlots, double strengthMul) {
    }

    private final Optional<LeagueData> data;

    public LeagueDataService(ObjectMapper objectMapper,
                             @Value("${hmb.data.league-file:}") String leagueFile) {
        this.data = load(objectMapper, leagueFile);
    }

    private static Optional<LeagueData> load(ObjectMapper objectMapper, String path) {
        if (path == null || path.isBlank()) {
            log.warn("league-file not configured — league features disabled until published");
            return Optional.empty();
        }
        File file = new File(path);
        if (!file.exists()) {
            log.warn("league file not found at {} — league features disabled until published",
                    file.getAbsolutePath());
            return Optional.empty();
        }
        try {
            JsonNode root = objectMapper.readTree(file);
            String version = root.path("version").asText("v1");
            List<String> clubNames = new ArrayList<>();
            root.path("clubNames").forEach(n -> clubNames.add(n.asText()));
            JsonNode personaPresets = root.has("personaPresets") ? root.get("personaPresets") : null;
            List<RankReward> rewards = new ArrayList<>();
            root.path("rewards").forEach(n ->
                    rewards.add(new RankReward(n.path("rank").asInt(), n.path("points").asInt())));

            // divisions 는 v2 부터의 additive 블록 — 없으면 빈 리스트(구 발행물 폴백: 서버가
            // 구 등급 라운드로빈으로 동작한다. league.v1.json 로 되돌리는 것이 곧 롤백이다).
            List<Division> divisions = new ArrayList<>();
            root.path("divisions").forEach(n -> {
                List<String> slots = new ArrayList<>();
                n.path("gradeSlots").forEach(g -> slots.add(g.asText()));
                divisions.add(new Division(n.path("level").asInt(), n.path("name").asText(),
                        n.path("shortName").asText(), List.copyOf(slots),
                        n.path("strengthMul").asDouble(1.0)));
            });

            log.info("Loaded league data {} from {} (clubNames={}, personaPresets={}, rewards={}, divisions={})",
                    version, file.getAbsolutePath(), clubNames.size(),
                    personaPresets != null ? personaPresets.size() : 0, rewards.size(), divisions.size());
            return Optional.of(new LeagueData(version, List.copyOf(clubNames), personaPresets,
                    List.copyOf(rewards), List.copyOf(divisions)));
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to load league data from {}: {} — continuing without league config",
                    file.getAbsolutePath(), e.toString());
            return Optional.empty();
        }
    }

    public Optional<LeagueData> get() {
        return data;
    }
}
