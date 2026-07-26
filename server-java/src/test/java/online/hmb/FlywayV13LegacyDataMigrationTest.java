package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;

/**
 * V13(#209) 을 <b>이미 사람들이 쓰고 있는 DB</b> 위에서 검증한다.
 *
 * <p>이슈의 요구는 "기존 유저 무영향(가입 시점만 바뀐다)"이다. V13 은 튜토리얼 완료 플래그를
 * 새로 만드는데, 기본값(0)만 두면 <b>이미 플레이 중인 계정 전원이 미완료로 되살아나</b> 튜토리얼이
 * 다시 뜨고 덱 지급 경로까지 열린다. 백필이 그걸 막는 유일한 장치라, 백필을 검증하려면
 * "마이그레이션 전에 이미 유저가 있는" DB 가 필요하다 — 빈 DB 로 부팅하는 @SpringBootTest 로는
 * 절대 재현되지 않는다(V8 때 같은 이유로 거짓 green 이 났었다).
 */
class FlywayV13LegacyDataMigrationTest {

    private static final String LOCATIONS = "classpath:db/migration";

    private static String jdbcUrl(Path db) {
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
    void existingUsersAreBackfilledAsTutorialDoneAndNewOnesAreNot() throws Exception {
        Path db = Files.createTempFile("hmb-v13-legacy-", ".db");
        Files.deleteIfExists(db);

        // 1) 배포본 상태 재현: V12 까지 적용된 DB + 플레이 중인 계정 2개.
        flyway(db, "12").migrate();
        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) "
                    + "VALUES ('U_OLD1','veteran','2026-07-01T00:00:00Z')");
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) "
                    + "VALUES ('U_OLD2','veteran2','2026-07-02T00:00:00Z')");
        }

        // 2) 배포 = V13 이 여기서 돈다.
        flyway(db, null).migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            // 3) 기존 유저 전원 완료 백필 — 튜토리얼 재노출도, 덱 재지급도 없다.
            assertThat(scalar(st, "SELECT tutorial_done FROM users WHERE id='U_OLD1'")).isEqualTo("1");
            assertThat(scalar(st, "SELECT tutorial_done FROM users WHERE id='U_OLD2'")).isEqualTo("1");

            // 4) 그 이후 가입하는 계정은 기본값 0(미완료)이어야 한다 — 백필이 DEFAULT 를 오염시키지 않았다.
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) "
                    + "VALUES ('U_NEW','rookie','2026-07-27T00:00:00Z')");
            assertThat(scalar(st, "SELECT tutorial_done FROM users WHERE id='U_NEW'")).isEqualTo("0");

            // 5) starter_grants 는 1인 1행(PK) — 재지급이 DB 레벨에서 막힌다.
            st.executeUpdate("INSERT INTO starter_grants(user_id, player_id, granted_at) "
                    + "VALUES ('U_NEW','P001','2026-07-27T00:00:00Z')");
            assertThat(scalar(st, "SELECT COUNT(*) FROM starter_grants")).isEqualTo("1");
            boolean rejected = false;
            try {
                st.executeUpdate("INSERT INTO starter_grants(user_id, player_id, granted_at) "
                        + "VALUES ('U_NEW','P002','2026-07-27T00:00:01Z')");
            } catch (Exception expected) {
                rejected = true;
            }
            assertThat(rejected).as("같은 유저 2회 지급은 PK 로 차단").isTrue();

            assertThat(rows(st, "PRAGMA foreign_key_check")).isZero();
        }
    }

    private static String scalar(Statement st, String sql) throws Exception {
        try (ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getString(1) : null;
        }
    }

    private static int rows(Statement st, String sql) throws Exception {
        int n = 0;
        try (ResultSet rs = st.executeQuery(sql)) {
            while (rs.next()) {
                n++;
            }
        }
        return n;
    }
}
