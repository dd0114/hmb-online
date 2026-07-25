package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

import jakarta.annotation.Resource;

/** Flyway V1__init.sql + V2__phase2.sql이 ERD DDL 그대로 깨끗하게 적용되는지(24개 테이블) 검증. */
@SpringBootTest
class FlywayMigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    private static final List<String> EXPECTED_TABLES = List.of(
            // V1 (17)
            "players", "users", "sessions", "wallets", "point_ledger", "user_players",
            "decks", "deck_slots", "prompt_presets", "gacha_pulls", "gacha_results",
            "bots", "matches", "match_prompts", "match_halves", "ai_jobs", "meta_kv",
            // V2 phase2 (7)
            "team_presets", "player_relations", "team_morale",
            "trade_slots", "trade_log", "league_seasons", "league_fixtures",
            // V5 p3 admin (1) — V4 는 컬럼 추가만이라 테이블 목록 불변
            "admin_audit",
            // V8 growth (1) — #179 성장 정산 멱등. V6/V7 은 컬럼·인덱스 추가만이라 테이블 목록 불변
            "growth_applied"
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
