package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.LinkedHashMap;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;

/**
 * V19(#217, ABANDONED 상태 + 롤아웃 정합)을 <b>실 배포 DB 모양 위에서</b> 검증한다 — V8 과 같은 규율:
 * `@SpringBootTest` 는 늘 빈 DB 로 부팅하므로 데이터가 있는 DB 에서 이 마이그레이션이 어떻게 되는지
 * 아무 것도 말해주지 않는다. V8 은 바로 그 자리에서 자식 행 FK 위반으로 배포를 죽였다.
 *
 * <p>여기서 잡는 것 둘:
 * <ol>
 *   <li>테이블 재작성이 <b>자식 행(match_prompts·match_halves·ai_jobs·growth_applied)이 있는 DB</b>에서
 *       살아남고 데이터가 온전한가.</li>
 *   <li><b>배포 1일차 락아웃</b>: 잠금 이전에는 매치를 몇 개든 만들 수 있었으므로 실 DB 에는 유저당
 *       미완 매치가 여러 건 있다. 그대로 잠그면 그 유저들은 첫 요청부터 409 에 갇힌다. V19 가
 *       유저당 최신 1건만 남기고 회수하는지 — 그리고 <b>남의 매치는 건드리지 않는지</b>.</li>
 * </ol>
 */
class FlywayV19LegacyDataMigrationTest {

    private static final String LOCATIONS = "classpath:db/migration";

    private static String jdbcUrl(Path db) {
        // 운영과 같은 연결 옵션(FK 강제) — FK 강제가 꺼져 있으면 (1) 검증이 성립하지 않는다.
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
    void v19MigratesADeployedDatabaseAndCollapsesDuplicateInFlightMatches() throws Exception {
        Path db = Files.createTempFile("hmb-v19-legacy-", ".db");
        Files.deleteIfExists(db);

        // 1) 배포본 재현: V18 까지(= v8 오픈베타)만 적용된 DB.
        flyway(db, "18").migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) "
                    + "VALUES ('U1','tester','2026-07-01T00:00:00Z')");
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) "
                    + "VALUES ('U2','other','2026-07-01T00:00:00Z')");
            st.executeUpdate("INSERT INTO bots(id, name, persona, analysis_text, deck_json) "
                    + "VALUES ('B1','bot','p','a','{}')");
            st.executeUpdate("INSERT INTO players(id, name, position, grade, attributes_json, data_version) "
                    + "VALUES ('P001','GK','GK','BRONZE','{}','v1')");

            // U1: 잠금 이전에 쌓인 미완 매치 3건(브리핑만 열고 나감 / GEN 타임아웃 / 지금 재생 중).
            insertMatch(st, "M_OLD_BRIEF", "U1", "BRIEFING", "2026-07-20T09:00:00Z");
            insertMatch(st, "M_OLD_FAILED", "U1", "FAILED", "2026-07-24T09:00:00Z");
            insertMatch(st, "M_LIVE", "U1", "FIRST_HALF", "2026-07-27T09:00:00Z");
            insertMatch(st, "M_DONE", "U1", "FINISHED", "2026-07-19T09:00:00Z");
            // U2: 미완 1건 — 남의 계정 정리에 휩쓸리면 안 된다.
            insertMatch(st, "M_U2", "U2", "BRIEFING", "2026-07-21T09:00:00Z");

            // 자식 행 — 이게 있어야 부모 DROP 이 FK 위반 카운터를 올린다(V8 blocker 재현 조건).
            st.executeUpdate("INSERT INTO match_prompts(match_id, phase, scope, player_id, text, created_at) "
                    + "VALUES ('M_LIVE','pre','team',NULL,'점유 중심','2026-07-27T09:01:00Z')");
            st.executeUpdate("INSERT INTO match_halves(match_id, half, select_data_json, home_input_json, "
                    + "away_input_json, half_seed, match_log_json, last_hash) "
                    + "VALUES ('M_LIVE',1,'{}','{}','{}','hs','{}','h1hash')");
            st.executeUpdate("INSERT INTO ai_jobs(id, match_id, side, half, status, context_json, "
                    + "created_at, updated_at) "
                    + "VALUES ('J1','M_LIVE','home',1,'done','{}','2026-07-27T09:00:30Z','2026-07-27T09:00:40Z')");
            st.executeUpdate("INSERT INTO growth_applied(match_id, user_id, player_id, xp_delta, applied_at) "
                    + "VALUES ('M_DONE','U1','P001',10,'2026-07-19T09:30:00Z')");
        }

        // 2) 배포 = 여기서 V19 가 돈다. 실패하면 Spring 부팅이 죽는다(= 백엔드 다운).
        flyway(db, null).migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            Map<String, String> states = new LinkedHashMap<>();
            try (ResultSet rs = st.executeQuery("SELECT id, state FROM matches ORDER BY id")) {
                while (rs.next()) {
                    states.put(rs.getString("id"), rs.getString("state"));
                }
            }

            // (2) 유저당 최신 미완 1건만 살아남는다 — 배포 순간 실제로 재생 중인 매치가 그것이다.
            assertThat(states.get("M_LIVE")).as("배포 중 재생 중이던 매치는 끊기지 않는다").isEqualTo("FIRST_HALF");
            assertThat(states.get("M_OLD_BRIEF")).isEqualTo("ABANDONED");
            assertThat(states.get("M_OLD_FAILED")).isEqualTo("ABANDONED");
            assertThat(states.get("M_DONE")).as("끝난 매치는 손대지 않는다").isEqualTo("FINISHED");
            assertThat(states.get("M_U2")).as("다른 유저의 유일한 미완 매치는 살아남는다").isEqualTo("BRIEFING");

            // (1) 자식 행이 온전하다 — 재작성이 데이터를 흘리지 않았다.
            assertThat(count(st, "SELECT COUNT(*) FROM match_prompts WHERE match_id = 'M_LIVE'")).isEqualTo(1);
            assertThat(count(st, "SELECT COUNT(*) FROM match_halves WHERE match_id = 'M_LIVE'")).isEqualTo(1);
            assertThat(count(st, "SELECT COUNT(*) FROM ai_jobs WHERE match_id = 'M_LIVE'")).isEqualTo(1);
            assertThat(count(st, "SELECT COUNT(*) FROM growth_applied WHERE match_id = 'M_DONE'")).isEqualTo(1);
            // FK 무결성이 실제로 성립한다(재작성 뒤 고아 참조 0).
            try (ResultSet rs = st.executeQuery("PRAGMA foreign_key_check")) {
                assertThat(rs.next()).as("foreign_key_check 위반 0").isFalse();
            }
            // 재작성 뒤에도 시계 컬럼과 값이 남아 있다(진행 중 매치가 창을 잃으면 시계가 멈춘다).
            try (ResultSet rs = st.executeQuery("SELECT phase_ends_at FROM matches WHERE id = 'M_LIVE'")) {
                assertThat(rs.next()).isTrue();
                assertThat(rs.getString(1)).isEqualTo("2026-07-27T09:04:00.000Z");
            }

            // 새 상태가 실제로 CHECK 를 통과한다(마이그레이션이 CHECK 를 안 넓혔으면 여기서 터진다).
            st.executeUpdate("UPDATE matches SET state = 'ABANDONED' WHERE id = 'M_U2'");
        }
    }

    private static void insertMatch(Statement st, String id, String userId, String state, String createdAt)
            throws java.sql.SQLException {
        st.executeUpdate("INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, "
                + "user_deck_json, created_at, phase_ends_at) VALUES ("
                + "'" + id + "','" + userId + "','B1','" + state + "','s','e','{}','" + createdAt + "',"
                + "'2026-07-27T09:04:00.000Z')");
    }

    private static long count(Statement st, String sql) throws java.sql.SQLException {
        try (ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }
}
