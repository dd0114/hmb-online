package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import jakarta.annotation.Resource;

/** Flyway V1__init.sql이 ERD.md DDL 그대로 깨끗하게 적용되는지(17개 테이블) 검증. */
@SpringBootTest
class FlywayMigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    private static final List<String> EXPECTED_TABLES = List.of(
            "players", "users", "sessions", "wallets", "point_ledger", "user_players",
            "decks", "deck_slots", "prompt_presets", "gacha_pulls", "gacha_results",
            "bots", "matches", "match_prompts", "match_halves", "ai_jobs", "meta_kv"
    );

    @Test
    void migrationCreatesAllErdTables() {
        List<String> tables = jdbcClient.sql(
                        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' "
                                + "AND name NOT LIKE 'flyway_%'")
                .query(String.class)
                .list();

        assertThat(tables).containsExactlyInAnyOrderElementsOf(EXPECTED_TABLES);
    }

    @Test
    void foreignKeysAndWalPragmasAreEnabled() {
        Integer fkEnabled = jdbcClient.sql("PRAGMA foreign_keys").query(Integer.class).single();
        String journalMode = jdbcClient.sql("PRAGMA journal_mode").query(String.class).single();

        assertThat(fkEnabled).isEqualTo(1);
        assertThat(journalMode).isEqualToIgnoringCase("wal");
    }
}
