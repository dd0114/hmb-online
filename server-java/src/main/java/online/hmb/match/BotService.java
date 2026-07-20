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
                jdbcClient.sql("""
                                INSERT INTO bots(id, name, persona, analysis_text, deck_json)
                                VALUES (?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                  name = excluded.name, persona = excluded.persona,
                                  analysis_text = excluded.analysis_text, deck_json = excluded.deck_json
                                """)
                        .params(id, b.path("name").asText(), b.path("persona").asText(),
                                b.path("analysisText").asText(), b.path("deck").toString())
                        .update();
                count++;
            }
            log.info("Imported {} bots from {}", count, file.getAbsolutePath());
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to import bots from {}: {} — continuing boot", file.getAbsolutePath(), e.toString());
        }
    }

    public record BotRow(String id, String name, String persona, String analysisText, String deckJson) {
    }

    public BotRow get(String botId) {
        return find(botId).orElseThrow(() -> ApiException.notFound("봇을 찾을 수 없습니다: " + botId));
    }

    public Optional<BotRow> find(String botId) {
        return jdbcClient.sql("SELECT id, name, persona, analysis_text, deck_json FROM bots WHERE id = ?")
                .param(botId)
                .query((rs, n) -> new BotRow(rs.getString("id"), rs.getString("name"),
                        rs.getString("persona"), rs.getString("analysis_text"), rs.getString("deck_json")))
                .optional();
    }

    /** botId 미지정 시 랜덤 봇 (PRD §3.4). 매칭 랜덤은 게임 결정론 계약 밖 — SecureRandom 허용. */
    public BotRow pickRandom() {
        List<String> ids = jdbcClient.sql("SELECT id FROM bots ORDER BY id").query(String.class).list();
        if (ids.isEmpty()) {
            throw ApiException.notFound("등록된 봇이 없습니다 (bots.v1.json 미임포트)");
        }
        return get(ids.get(secureRandom.nextInt(ids.size())));
    }
}
