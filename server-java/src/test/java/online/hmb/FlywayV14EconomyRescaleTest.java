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
 * V14(#212 재화 경제 정돈) 를 <b>기존 유저가 들어있는 DB</b> 위에서 검증한다.
 *
 * <p>왜 별도 클래스인가: {@code @SpringBootTest} 는 항상 빈 임시 DB 로 부팅하므로 V14 가 거기서
 * 도는 것은 <b>no-op</b> 이다(지갑 행이 0개). 즉 스프링 테스트가 전부 green 이어도 "배포된 테스터
 * 지갑이 실제로 보정되는가"에 대해서는 아무 것도 말해주지 않는다 — V8 레거시 테스트가 잡아낸 것과
 * 같은 함정. 그래서 여기서는 <b>V13 까지 적용한 DB 에 유저·지갑·원장을 넣고 나서 V14 를 돌린다</b>
 * (배포에서 실제로 일어나는 순서 그대로).
 *
 * <p>검증 대상 = 마이그레이션의 두 약속:
 * <ol>
 *   <li>P 잔액 ×10 (신 가격표 ×10 과 짝 — 안 하면 기존 테스터가 다이스 하나도 못 산다)</li>
 *   <li>젬 6,000 백필 (가입 지급 시점을 지나친 기존 유저에게 1회)</li>
 * </ol>
 * 그리고 <b>재적용해도 이중 지급이 없다</b>는 원장 백스톱.
 */
class FlywayV14EconomyRescaleTest {

    private static final String LOCATIONS = "classpath:db/migration";

    /** V14 직전 버전 — 리베이스로 번호가 밀리면 여기만 고치면 된다. */
    private static final String BEFORE_V14 = "13";

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
    void v14RescalesExistingWalletsAndBackfillsGemsExactlyOnce() throws Exception {
        Path db = Files.createTempFile("hmb-v14-economy-", ".db");
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
        }

        // 2) V14 적용.
        flyway(db, null).migrate();

        try (Connection c = DriverManager.getConnection(jdbcUrl(db))) {
            // (1) P 잔액 ×10 — 0인 유저는 곱해도 0이고 원장도 남기지 않는다(노이즈 방지).
            assertThat(points(c, "U_RICH")).isEqualTo(66000L);
            assertThat(points(c, "U_GEMS")).isEqualTo(12000L);
            assertThat(points(c, "U_BROKE")).isZero();

            // 증분(=구잔액×9)이 원장에 남는다 — 어디서 늘었는지 추적 가능해야 한다.
            assertThat(ledgerDelta(c, "point_ledger", "U_RICH", "economy_rescale_v14")).isEqualTo(59400L);
            assertThat(ledgerRows(c, "point_ledger", "U_BROKE", "economy_rescale_v14")).isZero();

            // (2) 젬 6,000 백필 — 이미 젬을 들고 있던 유저도 "가입 지급"을 못 받았으므로 대상이다(가산).
            assertThat(gems(c, "U_RICH")).isEqualTo(6000L);
            assertThat(gems(c, "U_BROKE")).isEqualTo(6000L);
            assertThat(gems(c, "U_GEMS")).isEqualTo(6330L);
            assertThat(ledgerRows(c, "gem_ledger", "U_RICH", "initial_gems")).isEqualTo(1L);
        }

        // 3) 재적용 백스톱: Flyway 를 우회해 SQL 을 그대로 다시 돌려도 이중 지급이 없어야 한다
        //    (원장 유니크 + INSERT OR IGNORE). 수동 복구/재실행 시나리오 방어.
        String sql = Files.readString(Path.of("src/main/resources/db/migration")
                .resolve(migrationFileName()));
        try (Connection c = DriverManager.getConnection(jdbcUrl(db)); Statement st = c.createStatement()) {
            for (String stmt : sql.split(";")) {
                if (!stmt.isBlank()) {
                    st.executeUpdate(stmt);
                }
            }
        }
        try (Connection c = DriverManager.getConnection(jdbcUrl(db))) {
            // 원장 행은 여전히 1건 — 즉 재실행분은 IGNORE 됐다.
            assertThat(ledgerRows(c, "point_ledger", "U_RICH", "economy_rescale_v14")).isEqualTo(1L);
            assertThat(ledgerRows(c, "gem_ledger", "U_RICH", "initial_gems")).isEqualTo(1L);
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

    private static long scalar(Connection c, String sql) throws Exception {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            return rs.next() ? rs.getLong(1) : -1L;
        }
    }
}
