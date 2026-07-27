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
 * V16(#212 재화 경제 정돈) 를 <b>기존 유저가 들어있는 DB</b> 위에서 검증한다.
 *
 * <p>왜 별도 클래스인가: {@code @SpringBootTest} 는 항상 빈 임시 DB 로 부팅하므로 V16 이 거기서
 * 도는 것은 <b>no-op</b> 이다(지갑 행이 0개). 즉 스프링 테스트가 전부 green 이어도 "배포된 테스터
 * 지갑이 실제로 보정되는가"에 대해서는 아무 것도 말해주지 않는다 — V8 레거시 테스트가 잡아낸 것과
 * 같은 함정. 그래서 여기서는 <b>V13 까지 적용한 DB 에 유저·지갑·원장을 넣고 나서 V16 을 돌린다</b>
 * (배포에서 실제로 일어나는 순서 그대로).
 *
 * <p>검증 대상 = 마이그레이션의 두 약속:
 * <ol>
 *   <li>P 잔액 ×10 (신 가격표 ×10 과 짝 — 안 하면 기존 테스터가 다이스 하나도 못 산다)</li>
 *   <li>젬 6,000 백필 (가입 지급 시점을 지나친 기존 유저에게 1회)</li>
 * </ol>
 * 그리고 <b>재적용해도 이중 지급이 없다</b>는 원장 백스톱.
 */
class FlywayV16EconomyRescaleTest {

    private static final String LOCATIONS = "classpath:db/migration";

    /** V16 직전 버전 — 리베이스로 번호가 밀리면 여기만 고치면 된다. */
    private static final String BEFORE_V14 = "15";

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
    void v16RescalesExistingWalletsAndBackfillsGemsExactlyOnce() throws Exception {
        Path db = Files.createTempFile("hmb-v16-economy-", ".db");
        Files.deleteIfExists(db);

        // 1) 배포본 상태 재현: V14 직전까지만 적용한 DB.
        flyway(db, BEFORE_V14).migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            // 기존 테스터 3인: 잔액 있는 유저 / 잔액 0 유저 / 이미 젬을 들고 있는 유저.
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) VALUES "
                    + "('U_RICH','rich','2026-07-01T00:00:00Z'),"
                    + "('U_BROKE','broke','2026-07-01T00:00:00Z'),"
                    + "('U_GEMS','gemholder','2026-07-01T00:00:00Z')");
            st.executeUpdate("INSERT INTO wallets(user_id, points, gems) VALUES "
                    + "('U_RICH', 6600, 0), ('U_BROKE', 0, 0), ('U_GEMS', 1200, 330)");
            // 실 배포에서는 잔액이 반드시 원장에서 왔다(WalletService 가 둘을 함께 쓴다).
            // 그 불변식(원장 합 = 잔액)을 아래에서 검증하므로 픽스처도 같은 모양으로 만든다.
            st.executeUpdate("INSERT INTO point_ledger(user_id, delta, reason, ref_id, created_at) VALUES "
                    + "('U_RICH', 6600, 'starter', 'U_RICH', '2026-07-01T00:00:00Z'),"
                    + "('U_GEMS', 1200, 'starter', 'U_GEMS', '2026-07-01T00:00:00Z')");
        }

        // 2) V14 적용.
        flyway(db, null).migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db))) {
            // (1) P 잔액 ×10 — 0인 유저는 곱해도 0이고 원장도 남기지 않는다(노이즈 방지).
            assertThat(points(c, "U_RICH")).isEqualTo(66000L);
            assertThat(points(c, "U_GEMS")).isEqualTo(12000L);
            assertThat(points(c, "U_BROKE")).isZero();

            // 증분(=구잔액×9)이 원장에 남는다 — 어디서 늘었는지 추적 가능해야 한다.
            assertThat(ledgerDelta(c, "point_ledger", "U_RICH", "economy_rescale_v16")).isEqualTo(59400L);
            assertThat(ledgerRows(c, "point_ledger", "U_BROKE", "economy_rescale_v16")).isZero();

            // (2) 젬 6,000 백필 — 이미 젬을 들고 있던 유저도 "가입 지급"을 못 받았으므로 대상이다(가산).
            assertThat(gems(c, "U_RICH")).isEqualTo(6000L);
            assertThat(gems(c, "U_BROKE")).isEqualTo(6000L);
            assertThat(gems(c, "U_GEMS")).isEqualTo(6330L);
            assertThat(ledgerRows(c, "gem_ledger", "U_RICH", "initial_gems")).isEqualTo(1L);
        }

        // 3) 재적용 백스톱: Flyway 를 우회해 SQL 을 그대로 다시 돌려도 **잔액이 안 움직여야** 한다.
        //    ⚠️ 여기서 원장 행 수만 보면 안 된다 — 원장 가드(INSERT OR IGNORE)는 원장만 막고
        //    UPDATE 는 그대로 다시 걸릴 수 있어서, 원장은 1행인데 잔액만 또 ×10 되는 상태를
        //    통과시킨다(실제로 초판 SQL 이 그랬다). 그래서 **잔액을 1급 검증 대상으로** 둔다.
        long pointsBefore;
        long gemsBefore;
        try (Connection c = DriverManager.getConnection(jdbcUrl(db))) {
            pointsBefore = points(c, "U_RICH");
            gemsBefore = gems(c, "U_RICH");
        }

        applyMigrationSqlDirectly(db);
        applyMigrationSqlDirectly(db); // 두 번 더 — "우연히 한 번은 무해" 를 배제

        try (Connection c = DriverManager.getConnection(jdbcUrl(db))) {
            assertThat(points(c, "U_RICH")).as("재적용해도 P 잔액 불변").isEqualTo(pointsBefore);
            assertThat(gems(c, "U_RICH")).as("재적용해도 젬 잔액 불변").isEqualTo(gemsBefore);
            assertThat(points(c, "U_GEMS")).isEqualTo(12000L);
            assertThat(gems(c, "U_GEMS")).isEqualTo(6330L);
            assertThat(points(c, "U_BROKE")).isZero();
            assertThat(gems(c, "U_BROKE")).isEqualTo(6000L);

            // 원장도 1건 유지 — 잔액과 원장이 함께 정지해야 "무해"다.
            assertThat(ledgerRows(c, "point_ledger", "U_RICH", "economy_rescale_v16")).isEqualTo(1L);
            assertThat(ledgerRows(c, "gem_ledger", "U_RICH", "initial_gems")).isEqualTo(1L);

            // 원장 합 = 잔액 (P). 원장이 SoT 인 설계라 이 등식이 깨지면 회계가 깨진 것이다.
            assertThat(ledgerSum(c, "point_ledger", "U_RICH")).isEqualTo(points(c, "U_RICH"));
            assertThat(ledgerSum(c, "point_ledger", "U_GEMS")).isEqualTo(points(c, "U_GEMS"));
        }
    }

    /**
     * 마이그레이션 이후에 가입한 유저(=이미 신 스케일 지갑)가 수동 재실행에 휩쓸리지 않아야 한다.
     * 마커가 없으면 이런 유저의 3,000 P 가 30,000 P 로 부풀고 젬도 한 번 더 꽂힌다.
     */
    @Test
    void reapplyDoesNotTouchUsersCreatedAfterTheMigration() throws Exception {
        Path db = Files.createTempFile("hmb-v14-newuser-", ".db");
        Files.deleteIfExists(db);
        flyway(db, BEFORE_V14).migrate();
        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) VALUES "
                    + "('U_OLD','old','2026-07-01T00:00:00Z')");
            st.executeUpdate("INSERT INTO wallets(user_id, points, gems) VALUES ('U_OLD', 100, 0)");
        }
        flyway(db, null).migrate();

        // 마이그레이션 이후 신규 가입(서버가 신 스케일로 지급 — 3,000 P + 6,000 젬).
        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            st.executeUpdate("INSERT INTO users(id, nickname, created_at) VALUES "
                    + "('U_NEW','newbie','2026-07-28T00:00:00Z')");
            st.executeUpdate("INSERT INTO wallets(user_id, points, gems) VALUES ('U_NEW', 3000, 6000)");
            st.executeUpdate("INSERT INTO gem_ledger(user_id, delta, reason, ref_id, created_at) "
                    + "VALUES ('U_NEW', 6000, 'initial_gems', 'U_NEW', '2026-07-28T00:00:00Z')");
        }

        applyMigrationSqlDirectly(db);

        try (Connection c = DriverManager.getConnection(jdbcUrl(db))) {
            assertThat(points(c, "U_NEW")).as("신규 가입자 P 불변").isEqualTo(3000L);
            assertThat(gems(c, "U_NEW")).as("신규 가입자 젬 불변").isEqualTo(6000L);
            assertThat(ledgerRows(c, "gem_ledger", "U_NEW", "initial_gems")).isEqualTo(1L);
            assertThat(points(c, "U_OLD")).as("기존 유저도 재적용 무영향").isEqualTo(1000L);
        }
    }

    /** Flyway 를 우회해 마이그레이션 SQL 을 그대로 실행 — 수동 복구/재실행 시나리오 재현. */
    private static void applyMigrationSqlDirectly(Path db) throws Exception {
        String sql = Files.readString(Path.of("src/main/resources/db/migration")
                .resolve(migrationFileName()));
        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            for (String stmt : sql.split(";")) {
                if (!stmt.isBlank()) {
                    st.executeUpdate(stmt);
                }
            }
        }
    }

    /** V14 파일명 — 리베이스로 번호가 밀려도 디렉토리에서 찾아 쓴다. */
    private static String migrationFileName() throws Exception {
        try (var files = Files.list(Path.of("src/main/resources/db/migration"))) {
            return files.map(p -> p.getFileName().toString())
                    .filter(n -> n.endsWith("__economy_rescale.sql"))
                    .findFirst()
                    .orElseThrow(() -> new IllegalStateException("economy_rescale 마이그레이션을 찾을 수 없다"));
        }
    }

    private static long points(Connection c, String userId) throws Exception {
        return scalar(c, "SELECT points FROM wallets WHERE user_id = '" + userId + "'");
    }

    private static long gems(Connection c, String userId) throws Exception {
        return scalar(c, "SELECT gems FROM wallets WHERE user_id = '" + userId + "'");
    }

    private static long ledgerDelta(Connection c, String table, String userId, String reason)
            throws Exception {
        return scalar(c, "SELECT COALESCE(SUM(delta),0) FROM " + table
                + " WHERE user_id = '" + userId + "' AND reason = '" + reason + "'");
    }

    private static long ledgerRows(Connection c, String table, String userId, String reason)
            throws Exception {
        return scalar(c, "SELECT COUNT(*) FROM " + table
                + " WHERE user_id = '" + userId + "' AND reason = '" + reason + "'");
    }

    /** 유저의 원장 전체 합 — 잔액과 일치해야 한다(원장 = SoT). */
    private static long ledgerSum(Connection c, String table, String userId) throws Exception {
        return scalar(c, "SELECT COALESCE(SUM(delta),0) FROM " + table
                + " WHERE user_id = '" + userId + "'");
    }

    private static long scalar(Connection c, String sql) throws Exception {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : -1L;
        }
    }
}
