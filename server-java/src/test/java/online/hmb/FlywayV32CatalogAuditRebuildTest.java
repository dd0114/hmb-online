package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * V32 — {@code admin_catalog_audit} 재작성(CHECK 에 {@code unit_purge} 추가).
 *
 * <p><b>왜 스프링 컨텍스트를 안 쓰나</b>: 이 마이그레이션의 위험은 "재작성이 <b>기존</b> 행과
 * 인덱스를 보존하는가"다. 부팅이 끝난 DB 에서 새 행을 왕복시키면 <b>그 축을 한 번도 검사하지
 * 않는다</b> — 초판이 정확히 그랬고, 그래서 `INSERT..SELECT` 에서 컬럼 하나를 빼는 변이체가
 * 전 스위트를 통과했다(독립검증 MAJOR-1). 여기서는 Flyway API 로 <b>V31 까지만 올린 DB 에 행을
 * 심고, 그 다음 V32 를 적용</b>해 전후를 대조한다.
 *
 * <p><b>인덱스 목록은 원본 마이그레이션을 직접 읽고 센다.</b> 초판은 V14 를 "둘"로 오독해
 * {@code uq_catalog_audit_idem} 을 빠뜨렸고, 계약이 그 손실을 {@code containsExactly(3개)} 로
 * <b>박제</b>했다 — 고치려 하면 테스트가 막는 상태였다(독립검증 BLOCKER-1). 계약이 구현을
 * 검증한 게 아니라 복사한 것이다.
 */
class FlywayV32CatalogAuditRebuildTest {

    /** V14(셋) + V15(하나). **숫자를 여기 적지 말고 이 목록을 보라** — 세는 계약의 기준이다. */
    private static final List<String> EXPECTED_INDEXES = List.of(
            "idx_catalog_audit_player",      // V14 조회
            "idx_catalog_audit_actor",       // V14 조회
            "uq_catalog_audit_idem",         // V14 멱등 백스톱 — 대상별(update/deactivate/activate/override_reset)
            "uq_catalog_audit_create_idem"); // V15 멱등 백스톱 — unit_create 전역

    /** 재작성 직전에 심을 행 — 전 컬럼에 서로 다른 값을 둬서 컬럼이 섞이거나 빠지면 드러나게. */
    private static final Map<String, String> LEGACY_ROW = new LinkedHashMap<>();

    static {
        LEGACY_ROW.put("id", "01LEGACYAUDITROW00000000AA");
        LEGACY_ROW.put("player_id", "P901");
        LEGACY_ROW.put("action", "unit_update");
        LEGACY_ROW.put("before_json", "{\"grade\":\"GOLD\"}");
        LEGACY_ROW.put("after_json", "{\"grade\":\"DIA\"}");
        LEGACY_ROW.put("changed_fields", "grade,attributes");
        LEGACY_ROW.put("reason", "재작성 전에 있던 행");
        LEGACY_ROW.put("idem_key", "LEGACY-KEY");
        LEGACY_ROW.put("created_at", "2026-07-29T01:02:03Z");
    }

    /**
     * <b>재작성 전에 있던 행이 내용까지 살아남는다.</b> 감사 원장 재작성에서 "무손실"이 바로 이 축이고,
     * 여기가 비어 있으면 컬럼을 하나 빼도 아무 테스트가 안 깨진다(실측된 결함).
     */
    @Test
    void rowsThatExistedBeforeTheRebuildSurviveWithEveryColumnIntact(@TempDir Path dir) throws Exception {
        Path db = dir.resolve("v32-legacy.db");
        migrateTo(db, 31);
        try (Connection c = open(db)) {
            seedActorAndLegacyRow(c);
        }

        migrateTo(db, 32); // ← 여기서 DROP TABLE + RENAME 이 돈다

        try (Connection c = open(db)) {
            Map<String, String> after = selectRow(c, LEGACY_ROW.get("id"));
            assertThat(after)
                    .as("재작성이 컬럼을 빠뜨리거나 섞지 않았다")
                    .containsAllEntriesOf(LEGACY_ROW);
            assertThat(rowCount(c)).as("행이 늘거나 줄지 않았다").isEqualTo(1);
        }
    }

    /**
     * <b>컬럼 순서까지 원본과 같다.</b> V32 주석이 "열 순서·타입 동일"을 선언하므로 계약을 둔다
     * (독립검증 MIN-B — 그 선언만 무계약이었고 순서를 바꾸는 변이체가 살아남았다).
     *
     * <p>⚠️ 런타임 영향은 <b>0</b> 이다({@code SELECT *} 사용처가 없다 — 참조 12곳 전부 명시 컬럼).
     * 그래도 계약을 두는 이유: 다음 재작성이나 {@code .dump} 기반 위치 복원에서 순서가 곧 의미가 되고,
     * 그때는 이미 늦다.
     */
    @Test
    void columnOrderMatchesTheOriginal(@TempDir Path dir) throws Exception {
        Path db = dir.resolve("v32-cols.db");
        migrateTo(db, 32);

        try (Connection c = open(db);
             Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("PRAGMA table_info(admin_catalog_audit)")) {
            List<String> order = new ArrayList<>();
            while (rs.next()) {
                order.add(rs.getString("name"));
            }
            assertThat(order).containsExactly(
                    "id", "actor_user_id", "player_id", "action", "before_json",
                    "after_json", "changed_fields", "reason", "idem_key", "created_at");
        }
    }

    /**
     * ⚠️ <b>인덱스 넷이 전부 다시 생겼는가.</b> 표와 함께 사라지므로 재작성이 다시 만들어야 한다.
     * 이름만 보지 않고 <b>부분 유니크의 조건까지</b> 본다 — 조건이 한 글자 다르면 사정거리가 달라진다.
     */
    @Test
    void allFourIndexesAreRecreatedWithTheirOriginalConditions(@TempDir Path dir) throws Exception {
        Path db = dir.resolve("v32-idx.db");
        migrateTo(db, 32);

        try (Connection c = open(db)) {
            assertThat(indexNames(c))
                    .as("V14 셋 + V15 하나 — 재작성이 하나라도 빠뜨리면 그 가드가 조용히 사라진다")
                    .containsExactlyInAnyOrderElementsOf(EXPECTED_INDEXES);

            // 대상별(V14): 서로 다른 유닛에 같은 키가 오는 건 정상 시나리오라 player_id 가 스코프에 있다.
            assertThat(indexSql(c, "uq_catalog_audit_idem"))
                    .contains("UNIQUE")
                    .contains("action, player_id, idem_key")
                    .contains("idem_key IS NOT NULL");
            // 전역(V15): create 는 대상이 아직 없어 같은 키 = 같은 요청의 재전송이다.
            assertThat(indexSql(c, "uq_catalog_audit_create_idem"))
                    .contains("UNIQUE")
                    .contains("action = 'unit_create'")
                    .contains("idem_key IS NOT NULL");
        }
    }

    /**
     * 두 유니크가 <b>실제로 잠그는지</b>. 이름·SQL 대조만으로는 "만들어졌다"만 알 수 있다.
     *
     * <p>V14 인덱스가 담당하는 4개 액션이 이 커밋에서 잃을 뻔한 그 가드다 — 앱의 사전조회는
     * check-then-act 라 경합을 막지 못하므로, 없으면 <b>감사 원장에 중복 행</b>이 생기고 두 번째
     * 행의 {@code before} 스냅샷은 이미 바뀐 상태라 "무엇이 바뀌었나"가 거짓이 된다.
     */
    @Test
    void bothIdempotencyBackstopsActuallyLock(@TempDir Path dir) throws Exception {
        Path db = dir.resolve("v32-lock.db");
        migrateTo(db, 32);

        try (Connection c = open(db)) {
            String actor = seedUser(c, "v32-lock");

            // ── V14: 같은 (action, player_id, idem_key) 두 번은 거부 ──
            insertAudit(c, actor, "P900", "unit_update", "K-DUP");
            assertThatThrownBy(() -> insertAudit(c, actor, "P900", "unit_update", "K-DUP"))
                    .as("대상별 멱등 백스톱(V14)이 살아 있다")
                    .isInstanceOf(SQLException.class);
            // 다른 대상에 같은 키는 **정상**이다(그래서 스코프가 대상별이다 — V5→V6 의 교훈).
            insertAudit(c, actor, "P901", "unit_update", "K-DUP");

            // ── V15: create 는 대상이 달라도 같은 키면 거부(같은 요청의 재전송) ──
            insertAudit(c, actor, "P910", "unit_create", "K-CREATE");
            assertThatThrownBy(() -> insertAudit(c, actor, "P911", "unit_create", "K-CREATE"))
                    .as("create 전역 멱등 백스톱(V15)이 살아 있다")
                    .isInstanceOf(SQLException.class);
        }
    }

    /** 새 action 은 수용되고 <b>오타는 여전히 거부</b>된다(CHECK 를 넓힌 것이지 없앤 것이 아니다). */
    @Test
    void purgeIsAcceptedButTyposAreStillRejected(@TempDir Path dir) throws Exception {
        Path db = dir.resolve("v32-check.db");
        migrateTo(db, 32);

        try (Connection c = open(db)) {
            String actor = seedUser(c, "v32-check");
            insertAudit(c, actor, "P920", "unit_purge", null);

            for (String typo : List.of("unit_purged", "purge", "whatever")) {
                assertThatThrownBy(() -> insertAudit(c, actor, "P921", typo, null))
                        .as("허용값 밖: " + typo)
                        .isInstanceOf(SQLException.class);
            }
            // 기존 5개 액션도 그대로 통과해야 한다(넓히면서 하나를 떨어뜨리지 않았다).
            int i = 0;
            for (String kept : List.of("unit_create", "unit_update", "unit_deactivate",
                    "unit_activate", "unit_override_reset")) {
                insertAudit(c, actor, "P93" + (i++), kept, null);
            }
        }
    }

    /** {@code player_id} 에 FK 가 없다 — 회수된(=존재하지 않는) 유닛의 이력을 보존하는 전제다. */
    @Test
    void thereIsStillNoForeignKeyOnPlayerIdSoPurgedHistorySurvives(@TempDir Path dir) throws Exception {
        Path db = dir.resolve("v32-fk.db");
        migrateTo(db, 32);

        try (Connection c = open(db)) {
            String actor = seedUser(c, "v32-fk");
            insertAudit(c, actor, "P_DOES_NOT_EXIST", "unit_purge", null);
            assertThat(rowCount(c)).isEqualTo(1);
        }
    }

    // ── 헬퍼 ───────────────────────────────────────────────────────────────

    /** 지정 버전까지만 마이그레이션한다(그 다음 버전이 하는 일을 전후로 관측할 수 있게). */
    private static void migrateTo(Path db, int version) {
        Flyway.configure()
                .dataSource("jdbc:sqlite:" + db.toAbsolutePath() + "?foreign_keys=on", null, null)
                .locations("classpath:db/migration")
                .target(org.flywaydb.core.api.MigrationVersion.fromVersion(String.valueOf(version)))
                .load()
                .migrate();
    }

    private static Connection open(Path db) throws SQLException {
        return DriverManager.getConnection("jdbc:sqlite:" + db.toAbsolutePath() + "?foreign_keys=on");
    }

    private static void seedActorAndLegacyRow(Connection c) throws SQLException {
        String actor = seedUser(c, "v32-legacy");
        try (var ps = c.prepareStatement("""
                INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action, before_json,
                                                after_json, changed_fields, reason, idem_key, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """)) {
            ps.setString(1, LEGACY_ROW.get("id"));
            ps.setString(2, actor);
            ps.setString(3, LEGACY_ROW.get("player_id"));
            ps.setString(4, LEGACY_ROW.get("action"));
            ps.setString(5, LEGACY_ROW.get("before_json"));
            ps.setString(6, LEGACY_ROW.get("after_json"));
            ps.setString(7, LEGACY_ROW.get("changed_fields"));
            ps.setString(8, LEGACY_ROW.get("reason"));
            ps.setString(9, LEGACY_ROW.get("idem_key"));
            ps.setString(10, LEGACY_ROW.get("created_at"));
            ps.executeUpdate();
        }
    }

    private static Map<String, String> selectRow(Connection c, String id) throws SQLException {
        try (var ps = c.prepareStatement("""
                SELECT id, player_id, action, before_json, after_json, changed_fields,
                       reason, idem_key, created_at
                  FROM admin_catalog_audit WHERE id = ?
                """)) {
            ps.setString(1, id);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).as("재작성 후에도 그 행이 있다").isTrue();
                Map<String, String> out = new LinkedHashMap<>();
                for (String col : LEGACY_ROW.keySet()) {
                    out.put(col, rs.getString(col));
                }
                return out;
            }
        }
    }

    private static int rowCount(Connection c) throws SQLException {
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT COUNT(*) FROM admin_catalog_audit")) {
            rs.next();
            return rs.getInt(1);
        }
    }

    private static List<String> indexNames(Connection c) throws SQLException {
        List<String> names = new ArrayList<>();
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("""
                     SELECT name FROM sqlite_master WHERE type='index'
                       AND tbl_name='admin_catalog_audit' AND name NOT LIKE 'sqlite_%'
                     """)) {
            while (rs.next()) {
                names.add(rs.getString(1));
            }
        }
        return names;
    }

    private static String indexSql(Connection c, String name) throws SQLException {
        try (var ps = c.prepareStatement("SELECT sql FROM sqlite_master WHERE name = ?")) {
            ps.setString(1, name);
            try (ResultSet rs = ps.executeQuery()) {
                assertThat(rs.next()).as("인덱스가 있다: " + name).isTrue();
                return rs.getString(1);
            }
        }
    }

    private static void insertAudit(Connection c, String actor, String playerId, String action,
                                    String idemKey) throws SQLException {
        try (var ps = c.prepareStatement("""
                INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action,
                                                reason, idem_key, created_at)
                VALUES (?, ?, ?, ?, '사유', ?, '2026-07-30T00:00:00Z')
                """)) {
            ps.setString(1, online.hmb.common.Ulid.next());
            ps.setString(2, actor);
            ps.setString(3, playerId);
            ps.setString(4, action);
            ps.setString(5, idemKey);
            ps.executeUpdate();
        }
    }

    private static String seedUser(Connection c, String nickname) throws SQLException {
        String id = online.hmb.common.Ulid.next();
        try (var ps = c.prepareStatement(
                "INSERT INTO users(id, nickname, created_at) VALUES (?, ?, '2026-07-30T00:00:00Z')")) {
            ps.setString(1, id);
            ps.setString(2, nickname);
            ps.executeUpdate();
        }
        return id;
    }

    /** {@code @TempDir} 정리를 돕는다(SQLite WAL 파일이 남아 삭제가 실패하는 것을 막는다). */
    @SuppressWarnings("unused")
    private static void deleteQuietly(Path p) {
        try {
            Files.deleteIfExists(p);
        } catch (Exception ignored) {
            // 임시 디렉토리는 JUnit 이 정리한다
        }
    }
}
