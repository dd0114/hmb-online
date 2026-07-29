package online.hmb.match;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.security.SecureRandom;
import java.util.List;
import java.util.Optional;
import online.hmb.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * 봇(싱글 상대) — 부팅 시 bots.v1.json 임포트(플레이어 임포트와 동일 패턴, 없으면 warn 후 계속)
 * + 매칭용 조회. bots.deck_json = data 파일의 `deck` 노드 그대로
 * ({formation, starters[11:{playerId,slotIndex,promptText?}], bench[]} — bench는 문자열 배열).
 */
@Component
@org.springframework.core.annotation.Order(0)   // 시드 임포트 러너 — 순서 명시(관계: PlayerCatalogService 와 동급, AdminBootstrap 보다 먼저).
public class BotService implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(BotService.class);

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final String botsFile;
    private final SecureRandom secureRandom = new SecureRandom();

    public BotService(JdbcClient jdbcClient,
                      ObjectMapper objectMapper,
                      @Value("${hmb.data.bots-file}") String botsFile) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.botsFile = botsFile;
    }

    @Override
    public void run(ApplicationArguments args) {
        File file = new File(botsFile);
        if (!file.exists()) {
            log.warn("bots data file not found at {} — match creation unavailable until published",
                    file.getAbsolutePath());
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(file);
            JsonNode bots = root.isArray() ? root : root.path("bots");
            if (!bots.isArray()) {
                log.warn("bots data file {} has unexpected shape — skipping import", file.getAbsolutePath());
                return;
            }
            int count = 0;
            for (JsonNode b : bots) {
                String id = b.path("id").asText(null);
                if (id == null) {
                    continue;
                }
                // strengthMul(선택, 기본 1.0) — 등급 하한(전원 BRONZE) 아래로 더 내려야 하는 봇용.
                // 로스터 등급만으로는 못 가는 구간이 실제로 있다: 공격형 페르소나는 같은 파워에서
                // 유저를 훨씬 강하게 압박해(#252 실측) 등급을 다 낮춰도 여전히 어렵다.
                double strengthMul = b.path("strengthMul").asDouble(1.0);
                jdbcClient.sql("""
                                INSERT INTO bots(id, name, persona, analysis_text, deck_json, kind, strength_mul)
                                VALUES (?, ?, ?, ?, ?, 'seed', ?)
                                ON CONFLICT(id) DO UPDATE SET
                                  name = excluded.name, persona = excluded.persona,
                                  analysis_text = excluded.analysis_text, deck_json = excluded.deck_json,
                                  kind = 'seed', strength_mul = excluded.strength_mul
                                """)
                        .params(id, b.path("name").asText(), b.path("persona").asText(),
                                b.path("analysisText").asText(), b.path("deck").toString(), strengthMul)
                        .update();
                count++;
            }
            log.info("Imported {} bots from {}", count, file.getAbsolutePath());
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to import bots from {}: {} — continuing boot", file.getAbsolutePath(), e.toString());
        }
    }

    /** @param strengthMul 봇 능력치 배율(#252). 1.0 = 미적용. 시드봇은 항상 1.0, 리그봇은 디비전 값. */
    public record BotRow(String id, String name, String persona, String analysisText, String deckJson,
                         double strengthMul) {
    }

    /** 연습 매칭 대상 = 시드봇만(#252 BL-1). 리그 봇팀 행은 같은 표에 살지만 매칭 풀이 아니다. */
    public static final String KIND_SEED = "seed";

    public BotRow get(String botId) {
        return find(botId).orElseThrow(() -> ApiException.notFound("봇을 찾을 수 없습니다: " + botId));
    }

    /**
     * 연습 상대 지목용 조회 — {@code kind='seed'} 가 아니면 404 (#252).
     *
     * <p>없는 봇과 같은 응답을 주는 것이 의도다: 리그 봇팀·원정 고스트는 연습 매칭의 대상이 아니고,
     * "존재하지만 못 쓴다"고 알려줄 이유도 없다(다른 유저의 고스트 id 존재 여부가 새는 것도 막는다).
     */
    public BotRow getSeed(String botId) {
        String kind = jdbcClient.sql("SELECT kind FROM bots WHERE id = ?")
                .param(botId).query(String.class).optional().orElse(null);
        if (!KIND_SEED.equals(kind)) {
            throw ApiException.notFound("봇을 찾을 수 없습니다: " + botId);
        }
        return get(botId);
    }

    public Optional<BotRow> find(String botId) {
        return jdbcClient.sql(
                        "SELECT id, name, persona, analysis_text, deck_json, strength_mul FROM bots WHERE id = ?")
                .param(botId)
                .query((rs, n) -> new BotRow(rs.getString("id"), rs.getString("name"),
                        rs.getString("persona"), rs.getString("analysis_text"), rs.getString("deck_json"),
                        rs.getDouble("strength_mul")))
                .optional();
    }

    /**
     * botId 미지정 시 랜덤 봇 (PRD §3.4). 매칭 랜덤은 게임 결정론 계약 밖 — SecureRandom 허용.
     *
     * <p><b>{@code kind='seed'} 로 한정한다(#252 BL-1).</b> 예전엔 {@code bots} 표 전체에서 뽑았는데,
     * {@code LeagueService.insertBotRows} 가 시즌마다 리그 봇 9팀을 같은 표에 넣기 때문에 연습 상대가
     * 점점 리그 봇팀으로 대체됐다 — 라이브 실측 리그팀 45행 : 시드봇 3행 이라 설계된 입문 상대가
     * 뽑힐 확률이 6.25% 였고 시즌이 늘수록 **0으로 수렴**한다. 리그 봇팀은 그 시즌의 디비전 난이도에
     * 맞춰 만든 것이라 연습 상대로 쓰면 난이도 설계가 통째로 무의미해진다.
     */
    public BotRow pickRandom() {
        List<String> ids = jdbcClient.sql("SELECT id FROM bots WHERE kind = ? ORDER BY id")
                .param(KIND_SEED).query(String.class).list();
        if (ids.isEmpty()) {
            throw ApiException.notFound("등록된 연습 봇이 없습니다 (bots 시드 파일 미임포트)");
        }
        return get(ids.get(secureRandom.nextInt(ids.size())));
    }
}
