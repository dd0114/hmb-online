package online.hmb.catalog;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.File;
import java.io.IOException;
import java.util.Iterator;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import online.hmb.common.TxRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * 부팅 시 data/players/*.v1.json 을 읽어 players 테이블을 upsert하고 버전을 meta_kv에 기록한다.
 * (LLD §1 catalog/PlayerCatalogService, PRD §3.1 AC-D4 — server-java는 버전 파일만 읽는다)
 *
 * data 에픽은 병렬 진행 중이라 파일이 아직 없을 수 있다 — 없으면 경고 로그만 남기고 부팅을 계속한다
 * (§0.5 도메인 분할: server-java가 data 산출물을 대신 생성하지 않는다).
 *
 * players.v1.json 실제 발행 형식(data 에픽 산출물, 확인됨): 최상위가 **배열**이고 각 원소는
 * {"id":"P001","name":"...","position":"GK","grade":"BRONZE",
 *  "attributes":{"technical":.., "mental":.., "physical":.., "passing":.., "shooting":..,
 *                 "tackling":.., "pace":.., "stamina":.., "positioning":..}}.
 * 파일 자체에 "version" 필드는 없다 — 버전은 파일명 규약(players.<version>.json)에서 유도한다
 * (PRD AC-D4: "소비자는 버전 파일만 읽는다"). bots.v1.json도 동일하게 최상위 배열.
 * economy.v1.json만 최상위 객체이며 내부에 "version" 필드를 갖는다.
 * 파서는 배열/객체 두 형태를 모두 허용해 향후 포맷 변경에도 관대하게 대응한다.
 *
 * economy.v1.json / bots.v1.json은 W2/W3에서 실제 소비(GachaService/BotService)한다.
 * W0에서는 존재 여부·버전만 확인해 meta_kv에 기록한다(파싱 실패해도 부팅은 계속).
 */
@Component
@org.springframework.core.annotation.Order(0)   // 부팅 임포트는 다른 러너보다 먼저 — AdminBootstrap 의 온보딩이 players FK 를 필요로 한다.
public class PlayerCatalogService implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(PlayerCatalogService.class);

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final String playersFile;
    private final String economyFile;
    private final String botsFile;

    public PlayerCatalogService(JdbcClient jdbcClient,
                                 TxRunner txRunner,
                                 ObjectMapper objectMapper,
                                 @Value("${hmb.data.players-file}") String playersFile,
                                 @Value("${hmb.data.economy-file}") String economyFile,
                                 @Value("${hmb.data.bots-file}") String botsFile) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.playersFile = playersFile;
        this.economyFile = economyFile;
        this.botsFile = botsFile;
    }

    @Override
    public void run(ApplicationArguments args) {
        importPlayers();
        recordVersionIfPresent(economyFile, "economy_version");
        recordVersionIfPresent(botsFile, "bots_version");
    }

    void importPlayers() {
        File file = new File(playersFile);
        if (!file.exists()) {
            log.warn("players data file not found at {} — skipping seed import (data epic pending). "
                    + "Catalog will be empty until the file is published.", file.getAbsolutePath());
            return;
        }

        try {
            JsonNode root = objectMapper.readTree(file);
            String version = versionOf(root, file);
            JsonNode players = root.isArray() ? root : root.path("players");
            if (!players.isArray()) {
                log.warn("players data file {} is neither a top-level array nor an object with a "
                        + "'players' array — skipping import", file.getAbsolutePath());
                return;
            }

            int count = upsertPlayers(players, version);
            setMetaKv("players_version", version);
            log.info("Imported {} players from {} (version={})", count, file.getAbsolutePath(), version);
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to import players from {}: {} — continuing boot without catalog data",
                    file.getAbsolutePath(), e.toString());
        }
    }

    private int upsertPlayers(JsonNode players, String version) {
        return txRunner.run(() -> {
            int count = 0;
            Iterator<JsonNode> it = players.elements();
            while (it.hasNext()) {
                JsonNode p = it.next();
                String id = p.path("id").asText(null);
                String name = p.path("name").asText(null);
                String position = p.path("position").asText(null);
                String grade = p.path("grade").asText(null);
                JsonNode attributes = p.path("attributes");

                if (id == null || name == null || position == null || grade == null || attributes.isMissingNode()) {
                    log.warn("Skipping malformed player entry: {}", p);
                    continue;
                }

                String attributesJson = attributes.toString();
                // C4(AC-C4): data v2.1 성격 필드. 구파일(personality 없음)은 기본 CALM 으로 안전 임포트.
                String personality = normalizePersonality(p.path("personality").asText(null));

                jdbcClient.sql("""
                                INSERT INTO players(id, name, position, grade, attributes_json, data_version, personality)
                                VALUES (?, ?, ?, ?, ?, ?, ?)
                                ON CONFLICT(id) DO UPDATE SET
                                  name = excluded.name,
                                  position = excluded.position,
                                  grade = excluded.grade,
                                  attributes_json = excluded.attributes_json,
                                  data_version = excluded.data_version,
                                  personality = excluded.personality
                                """)
                        .params(id, name, position, grade, attributesJson, version, personality)
                        .update();
                count++;
            }
            return count;
        });
    }

    private void recordVersionIfPresent(String path, String metaKey) {
        File file = new File(path);
        if (!file.exists()) {
            log.warn("{} not found at {} — will be consumed in a later wave once the data epic publishes it",
                    metaKey, file.getAbsolutePath());
            return;
        }
        try {
            JsonNode root = objectMapper.readTree(file);
            String version = versionOf(root, file);
            setMetaKv(metaKey, version);
            log.info("Detected {} = {} at {}", metaKey, version, file.getAbsolutePath());
        } catch (IOException | RuntimeException e) {
            log.warn("Failed to read {} from {}: {}", metaKey, file.getAbsolutePath(), e.toString());
        }
    }

    private static final Set<String> VALID_PERSONALITIES = Set.of("FIERY", "CALM", "GLASS", "AMBITIOUS");

    /** 성격 정규화 — 없거나 미허용 값이면 기본 CALM (구파일 안전 + DB CHECK 위반 방지). */
    private static String normalizePersonality(String raw) {
        if (raw == null) {
            return "CALM";
        }
        String upper = raw.trim().toUpperCase(java.util.Locale.ROOT);
        return VALID_PERSONALITIES.contains(upper) ? upper : "CALM";
    }

    // 파일명 규약 players.<version>.json 에서 <version> 전체를 캡처(점 포함 — 예: v2.1).
    private static final Pattern FILENAME_VERSION = Pattern.compile("^[^.]+\\.(.+)\\.json$");

    /** JSON 내부에 "version" 필드가 있으면 그것을, 없으면(예: 최상위 배열) 파일명에서 유도한다. */
    private static String versionOf(JsonNode root, File file) {
        if (root.isObject() && root.hasNonNull("version")) {
            return root.path("version").asText();
        }
        Matcher m = FILENAME_VERSION.matcher(file.getName());
        return m.matches() ? m.group(1) : "v1";
    }

    private void setMetaKv(String key, String value) {
        jdbcClient.sql("""
                        INSERT INTO meta_kv(key, value) VALUES (?, ?)
                        ON CONFLICT(key) DO UPDATE SET value = excluded.value
                        """)
                .params(key, value)
                .update();
    }
}
