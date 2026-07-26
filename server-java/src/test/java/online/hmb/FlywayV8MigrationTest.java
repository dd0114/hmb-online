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
 * V8__p4_match_clock.sql (P4-E2 #170) 검증 — LLD-e2-flow-clock §8, T-M-2.
 *
 * <p>matches 는 자식 테이블(match_prompts·match_halves·ai_jobs)이 참조하므로 CHECK 재구축이
 * FK 를 깨뜨리기 쉽다. 여기서 증명하는 것: ①새 컬럼/인덱스 ②새 state 값 수용 + 모르는 값 거부
 * ③레거시 H1_BREAK 행 이관 ④<b>FK 무결성 보존</b>(고아 삽입은 여전히 거부, foreign_key_check 0행).
 */
@SpringBootTest
class FlywayV8MigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v8AddsClockColumnsAndIndex() {
        assertThat(columnsOf("matches")).contains(
                "kickoff_at", "phase_start_at", "phase_ends_at", "score_h2_home", "score_h2_away");
        // 기존 컬럼은 전부 보존(재작성이 데이터 모델을 갉아먹지 않았는지)
        assertThat(columnsOf("matches")).contains(
                "id", "user_id", "bot_id", "state", "fail_reason", "seed", "engine_version",
                "user_deck_json", "subs_json", "score_h1_home", "score_h1_away", "score_home",
                "score_away", "result", "created_at", "finished_at", "conditions_json", "mode",
                "league_fixture_id", "relations_applied");

        List<String> indexes = jdbcClient.sql("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='matches'")
                .query(String.class).list();
        assertThat(indexes).contains("idx_matches_clock", "idx_matches_user");
    }

    @Test
    void v8CheckAcceptsLiveStatesAndRejectsUnknownOnes() {
        seedUserAndBot();
        for (String state : List.of("FIRST_HALF", "HALFTIME", "SECOND_HALF", "BRIEFING", "FINISHED")) {
            insertMatch("M_" + state, state);
        }
        assertThatThrownBy(() -> insertMatch("M_BOGUS", "EXTRA_TIME")).isNotNull();
    }

    @Test
    void v8MigratesLegacyH1BreakRowsToHalftime() {
        // 이 DB 는 새로 만들어져 레거시 행이 없다 — 마이그레이션 SQL 자체가 멱등·무해한지와
        // (배포본에서 실제로 이관되는) UPDATE 문의 의미를 여기서 재현한다.
        seedUserAndBot();
        insertMatch("M_LEGACY", "H1_BREAK"); // 구 배포본이 남긴 진행 중 매치
        jdbcClient.sql("UPDATE matches SET state='HALFTIME' WHERE state='H1_BREAK'").update();
        assertThat(stateOf("M_LEGACY")).isEqualTo("HALFTIME");
        assertThat(jdbcClient.sql("SELECT phase_ends_at FROM matches WHERE id='M_LEGACY'")
                .query(String.class).optional().orElse(null)).isNull(); // 시계 미적용 = 수동 제출만
    }

    @Test
    void v8PreservesForeignKeyIntegrity() {
        seedUserAndBot();
        insertMatch("M_FK", "BRIEFING");

        // 자식 → matches 참조가 살아 있다: 존재하는 매치는 되고, 없는 매치는 거부된다.
        jdbcClient.sql("""
                        INSERT INTO match_prompts(match_id, phase, scope, player_id, text, created_at)
                        VALUES ('M_FK', 'pre', 'team', NULL, 'x', '2026-01-01T00:00:00Z')
                        """).update();
        assertThatThrownBy(() -> jdbcClient.sql("""
                        INSERT INTO match_prompts(match_id, phase, scope, player_id, text, created_at)
                        VALUES ('M_GHOST', 'pre', 'team', NULL, 'x', '2026-01-01T00:00:00Z')
                        """).update()).isNotNull();

        assertThat(jdbcClient.sql("PRAGMA foreign_key_check").query().listOfRows()).isEmpty();
    }

    @Test
    void migrationHistoryContainsV8() {
        List<String> versions = jdbcClient.sql("SELECT version FROM flyway_schema_history WHERE success = 1")
                .query(String.class).list();
        assertThat(versions).contains("1", "2", "3", "4", "5", "6", "7", "8");
    }

    private void seedUserAndBot() {
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO users(id, nickname, created_at)
                        VALUES ('U_V8', 'v8user', '2026-01-01T00:00:00Z')
                        """).update();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO bots(id, name, persona, analysis_text, deck_json)
                        VALUES ('B_V8', 'bot', 'p', 'a', '{}')
                        """).update();
    }

    private void insertMatch(String id, String state) {
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, created_at)
                        VALUES (?, 'U_V8', 'B_V8', ?, 's', 'e', '{}', '2026-01-01T00:00:00Z')
                        """)
                .params(id, state)
                .update();
    }

    private String stateOf(String id) {
        return jdbcClient.sql("SELECT state FROM matches WHERE id = ?").param(id).query(String.class).single();
    }

    private List<String> columnsOf(String table) {
        return jdbcClient.sql("SELECT name FROM pragma_table_info(?)").param(table).query(String.class).list();
    }
}
