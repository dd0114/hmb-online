package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;

/**
 * V8 마이그레이션을 **실 배포 DB 모양 위에서** 검증한다 (P4-E2 #170, LLD-e2-flow-clock §8 / T-M-2).
 *
 * <p>왜 별도 클래스인가: `@SpringBootTest` 는 항상 빈 임시 DB 로 부팅하므로 V8 이 <b>데이터가 있는</b>
 * DB 에서 어떻게 되는지 아무 것도 말해주지 않는다. 실제로 첫 버전은 자식 행(match_prompts 등)이 있는
 * 배포 DB 에서 COMMIT 시 FK 위반으로 죽었고(백엔드 부팅 불가), 그때의 마이그레이션 테스트는
 * "마이그레이션 후에 행을 넣고 SQL 을 손으로 재실행"하는 tautology 라 이를 잡지 못했다(독립검증 blocker).
 *
 * <p>그래서 여기서는 <b>V1~V7 로 만든 DB에 진행 중 매치 + 자식 행(match_prompts·match_halves·ai_jobs)을
 * 넣고 나서 V8 을 돌린다</b> — 배포에서 실제로 일어나는 순서 그대로.
 */
class FlywayV8LegacyDataMigrationTest {

    private static final String LOCATIONS = "classpath:db/migration";

    private static String jdbcUrl(Path db) {
        // 운영과 같은 연결 옵션(FK 강제 + WAL) — FK 강제가 꺼져 있으면 이 테스트는 의미가 없다.
        return "jdbc:sqlite:" + db.toAbsolutePath() + "?foreign_keys=on&journal_mode=WAL&busy_timeout=5000";
    }

    private static Flyway flyway(Path db, String target) {
        org.flywaydb.core.api.configuration.FluentConfiguration config = Flyway.configure()
                .dataSource(jdbcUrl(db), null, null)
                .locations(LOCATIONS);
        if (target != null) {
            config = config.target(org.flywaydb.core.api.MigrationVersion.fromVersion(target));
        }
        return config.load();
    }

    @Test
    void v8MigratesADeployedDatabaseThatHasInFlightMatchesAndChildRows() throws Exception {
        Path db = Files.createTempFile("hmb-v8-legacy-", ".db");
        Files.deleteIfExists(db);

        // 1) 배포본 상태 재현: V7 까지만 적용한 DB.
        flyway(db, "7").migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) VALUES ('U1','tester','2026-07-01T00:00:00Z')");
            st.executeUpdate("INSERT INTO bots(id, name, persona, analysis_text, deck_json) "
                    + "VALUES ('B1','bot','p','a','{}')");
            // 진행 중 매치(구 하프타임) + 완료 매치
            st.executeUpdate("INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, "
                    + "user_deck_json, score_h1_home, score_h1_away, created_at) "
                    + "VALUES ('M_LIVE','U1','B1','H1_BREAK','s1','e','{}',1,0,'2026-07-25T09:00:00Z')");
            st.executeUpdate("INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, "
                    + "user_deck_json, score_home, score_away, result, created_at) "
                    + "VALUES ('M_DONE','U1','B1','FINISHED','s2','e','{}',2,1,'WIN','2026-07-24T09:00:00Z')");
            // 자식 행 — 이게 있어야 blocker 가 재현된다(부모 DROP 이 FK 위반 카운터를 올린다).
            st.executeUpdate("INSERT INTO match_prompts(match_id, phase, scope, player_id, text, created_at) "
                    + "VALUES ('M_LIVE','pre','team',NULL,'점유 중심','2026-07-25T09:01:00Z')");
            st.executeUpdate("INSERT INTO match_halves(match_id, half, select_data_json, home_input_json, "
                    + "away_input_json, half_seed, match_log_json, last_hash) "
                    + "VALUES ('M_LIVE',1,'{}','{}','{}','hs','{}','h1hash')");
            st.executeUpdate("INSERT INTO ai_jobs(id, match_id, side, half, status, context_json, "
                    + "created_at, updated_at) "
                    + "VALUES ('J1','M_LIVE','home',1,'done','{}','2026-07-25T09:00:30Z','2026-07-25T09:00:40Z')");
        }

        // 2) 배포 = 여기서 V8 이 돈다. 실패하면 Spring 부팅이 죽는다(= 백엔드 다운).
        flyway(db, null).migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            // 3) 레거시 진행 중 매치가 감독시간으로 이관되고, 시계는 미적용(수동 제출만).
            assertThat(scalar(st, "SELECT state FROM matches WHERE id='M_LIVE'")).isEqualTo("HALFTIME");
            assertThat(scalar(st, "SELECT phase_ends_at FROM matches WHERE id='M_LIVE'")).isNull();
            assertThat(scalar(st, "SELECT kickoff_at FROM matches WHERE id='M_LIVE'")).isNull();

            // 4) 데이터 보존 — 재작성이 기존 값을 잃지 않았다.
            assertThat(scalar(st, "SELECT score_h1_home FROM matches WHERE id='M_LIVE'")).isEqualTo("1");
            assertThat(scalar(st, "SELECT state FROM matches WHERE id='M_DONE'")).isEqualTo("FINISHED");
            assertThat(scalar(st, "SELECT result FROM matches WHERE id='M_DONE'")).isEqualTo("WIN");
            assertThat(scalar(st, "SELECT COUNT(*) FROM matches")).isEqualTo("2");

            // 5) 자식 행과 FK 무결성 보존 — 고아가 생기지 않았다.
            assertThat(scalar(st, "SELECT COUNT(*) FROM match_prompts WHERE match_id='M_LIVE'")).isEqualTo("1");
            assertThat(scalar(st, "SELECT COUNT(*) FROM match_halves WHERE match_id='M_LIVE'")).isEqualTo("1");
            assertThat(scalar(st, "SELECT COUNT(*) FROM ai_jobs WHERE match_id='M_LIVE'")).isEqualTo("1");
            assertThat(rows(st, "PRAGMA foreign_key_check")).isEmpty();

            // 6) 새 컬럼·인덱스·CHECK 가 실제로 적용됐다.
            assertThat(rows(st, "SELECT name FROM pragma_table_info('matches')"))
                    .contains("kickoff_at", "phase_start_at", "phase_ends_at", "score_h2_home", "score_h2_away");
            assertThat(rows(st, "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='matches'"))
                    .contains("idx_matches_clock", "idx_matches_user");
            st.executeUpdate("UPDATE matches SET state='SECOND_HALF' WHERE id='M_LIVE'"); // 새 값 수용
            assertThat(scalar(st, "SELECT state FROM matches WHERE id='M_LIVE'")).isEqualTo("SECOND_HALF");
        }
    }

    private static String scalar(Statement st, String sql) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        }
    }

    private static List<String> rows(Statement st, String sql) throws Exception {
        List<String> out = new ArrayList<>();
        try (ResultSet rs = st.executeQuery(sql)) {
            while (rs.next()) {
                out.add(rs.getString(1));
            }
        }
        return out;
    }
}
