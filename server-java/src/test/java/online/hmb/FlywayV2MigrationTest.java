package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * V2__phase2.sql(ERD-v2 DDL)이 V1 스키마 위에 클린 적용되는지 검증(Flyway가 V1→V2 순서 적용).
 * 신규 테이블 + matches/players ALTER 컬럼 + CHECK 제약(default 값) 존재를 확인한다.
 */
@SpringBootTest
class FlywayV2MigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v2AddsColumnsToMatches() {
        List<String> cols = columnsOf("matches");
        assertThat(cols).contains("conditions_json", "mode", "league_fixture_id");
    }

    @Test
    void v2AddsPersonalityToPlayers() {
        assertThat(columnsOf("players")).contains("personality");
    }

    @Test
    void v2NewTablesHaveExpectedColumns() {
        assertThat(columnsOf("team_presets"))
                .contains("id", "user_id", "slot_no", "name", "snapshot_json", "updated_at");
        assertThat(columnsOf("player_relations"))
                .contains("user_id", "player_id", "trust", "updated_at");
        assertThat(columnsOf("team_morale")).contains("user_id", "morale", "streak", "updated_at");
        assertThat(columnsOf("trade_slots"))
                .contains("id", "user_id", "slot_no", "state", "offer_kind",
                        "target_player_id", "demand_player_id", "seed", "opens_at", "created_at");
        assertThat(columnsOf("trade_log"))
                .contains("id", "user_id", "kind", "result", "detail_json", "created_at");
        assertThat(columnsOf("league_seasons"))
                .contains("id", "user_id", "season_no", "state", "seed", "teams_json",
                        "created_at", "finished_at");
        assertThat(columnsOf("league_fixtures"))
                .contains("id", "season_id", "round", "home_team", "away_team", "is_user",
                        "state", "score_home", "score_away", "match_id");
    }

    @Test
    void matchesModeDefaultsToPracticeAndPersonalityToCalm() {
        // W0 이월 b: 이름이 주장하는 default 를 실제 삽입→읽기로 검증(컬럼 존재만 확인하던 약한 단언 교체).
        // players.personality: 컬럼 미지정 INSERT → DEFAULT 'CALM'
        jdbcClient.sql("""
                        INSERT INTO players(id, name, position, grade, attributes_json, data_version)
                        VALUES ('PX01', 'No Personality', 'MF', 'BRONZE', '{}', 'vtest')
                        """).update();
        String personality = jdbcClient.sql("SELECT personality FROM players WHERE id = 'PX01'")
                .query(String.class).single();
        assertThat(personality).isEqualTo("CALM");

        // matches.mode: 컬럼 미지정 INSERT → DEFAULT 'practice'; relations_applied → DEFAULT 0 (V3)
        seedUserAndBot();
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, created_at)
                        VALUES ('MX01', 'UX01', 'BX01', 'BRIEFING', 'seedhex', 'pending', '{}', '2026-01-01T00:00:00Z')
                        """).update();
        String mode = jdbcClient.sql("SELECT mode FROM matches WHERE id = 'MX01'")
                .query(String.class).single();
        assertThat(mode).isEqualTo("practice");
        Integer relationsApplied = jdbcClient.sql("SELECT relations_applied FROM matches WHERE id = 'MX01'")
                .query(Integer.class).single();
        assertThat(relationsApplied).isZero();
    }

    private void seedUserAndBot() {
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES ('UX01','ux01','2026-01-01T00:00:00Z')")
                .update();
        jdbcClient.sql("""
                        INSERT INTO bots(id, name, persona, analysis_text, deck_json)
                        VALUES ('BX01','Bot X','p','a','{}')
                        """).update();
    }

    @Test
    void v2NewTablesAreEmptyOnFreshDb() {
        for (String table : List.of("team_presets", "player_relations", "team_morale",
                "trade_slots", "trade_log", "league_seasons", "league_fixtures")) {
            Integer count = jdbcClient.sql("SELECT COUNT(*) FROM " + table).query(Integer.class).single();
            assertThat(count).as(table).isZero();
        }
    }

    private List<String> columnsOf(String table) {
        return jdbcClient.sql("SELECT name FROM pragma_table_info(?)")
                .param(table)
                .query(String.class)
                .list();
    }
}
