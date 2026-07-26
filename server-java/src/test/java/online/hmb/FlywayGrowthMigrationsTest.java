package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.annotation.Resource;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * V9__growth.sql(#179 §1)이 V1~V7 위에 클린 적용되는지 검증. additive 만 — user_players 6개 컬럼
 * (기본값 0/NULL) + growth_applied 테이블(멱등 PK). 기존 컬럼·테이블 불변.
 */
@SpringBootTest
class FlywayGrowthMigrationsTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v8AddsGrowthColumnsToUserPlayersWithSafeDefaults() {
        assertThat(columnsOf("user_players")).contains(
                "enhance_level", "limit_break", "match_xp", "growth_level", "growth_vec_json", "copies_used");
        // 기존 컬럼 불변
        assertThat(columnsOf("user_players")).contains("user_id", "player_id", "count", "acquired_at");

        // NOT NULL DEFAULT 0 — 마이그레이션만으로 성장/강화가 생기지 않는다(기본 안전).
        for (String col : List.of("enhance_level", "limit_break", "match_xp", "growth_level", "copies_used")) {
            assertThat(jdbcClient.sql("SELECT dflt_value FROM pragma_table_info('user_players') WHERE name=?")
                    .param(col).query(String.class).single()).as(col).isEqualTo("0");
        }
    }

    @Test
    void v8CreatesGrowthAppliedWithIdempotentPrimaryKey() {
        assertThat(columnsOf("growth_applied")).contains(
                "match_id", "user_id", "player_id", "xp_delta", "applied_at");

        seedMatchAndPlayer();
        insertApplied(10);
        // 같은 (match, user, player) 재정산은 PK 위반 — 멱등 백스톱.
        assertThatThrownBy(() -> insertApplied(20)).isNotNull();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM growth_applied").query(Long.class).single()).isEqualTo(1L);
    }

    @Test
    void migrationHistoryContainsV8() {
        List<String> versions = jdbcClient.sql("SELECT version FROM flyway_schema_history WHERE success = 1")
                .query(String.class).list();
        assertThat(versions).contains("1", "2", "3", "8");
    }

    private void seedMatchAndPlayer() {
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES ('U8','u8','2026-01-01T00:00:00Z')").update();
        jdbcClient.sql("""
                        INSERT INTO players(id, name, position, grade, attributes_json, data_version)
                        VALUES ('PX','px','FW','BRONZE','{}','v1')
                        """).update();
        jdbcClient.sql("""
                        INSERT INTO bots(id, name, persona, analysis_text, deck_json)
                        VALUES ('B8','b8','p','a','{}')
                        """).update();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, user_deck_json, created_at)
                        VALUES ('M8','U8','B8','FINISHED','s','v','{}','2026-01-01T00:00:00Z')
                        """).update();
    }

    private void insertApplied(int xp) {
        jdbcClient.sql("""
                        INSERT INTO growth_applied(match_id, user_id, player_id, xp_delta, applied_at)
                        VALUES ('M8','U8','PX',?, '2026-01-01T00:00:00Z')
                        """).param(xp).update();
    }

    private List<String> columnsOf(String table) {
        return jdbcClient.sql("SELECT name FROM pragma_table_info(?)").param(table).query(String.class).list();
    }
}
