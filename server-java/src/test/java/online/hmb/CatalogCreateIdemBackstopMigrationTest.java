package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationVersion;
import org.junit.jupiter.api.Test;

/**
 * <b>#207 blocker B1 — V15 마이그레이션이 "이미 오염된 DB" 를 어떻게 통과하나.</b>
 *
 * <p>유니크 인덱스 생성은 <b>기존 중복이 한 쌍만 있어도 실패</b>하고, 실패한 마이그레이션은 부팅을
 * 죽인다. 즉 경합을 이미 겪은 DB(검증자 재현 DB 가 정확히 그 상태다)에 이 마이그레이션을 그냥 얹으면
 * <b>서버가 뜨지 않는다</b>. 그래서 V15 는 인덱스보다 먼저 정리를 한다 — 이 테스트가 그 정리의
 * <b>정확한 계약</b>을 박제한다.
 *
 * <p><b>정리 = 삭제가 아니라 "멱등키 회수"</b>다. 중복 감사행은 실제로 일어난 생성의 <b>유일한
 * 증거</b>이고(중복 생성된 유닛은 players 에 남아 있다), 지우면 그 유닛은 누가·언제·왜 만들었는지
 * 알 수 없는 고아가 된다. 그래서 행은 전부 남기고 <b>키만</b> 내리며, 회수된 키 문자열은 reason 에
 * 각인해 검색 가능하게 남긴다.
 *
 * <p><b>왜 Spring 컨텍스트를 안 쓰나</b>: 부팅 시점엔 이미 V15 까지 적용돼 있어 "V14 상태의 오염된 DB"
 * 를 만들 수 없다. Flyway 를 {@code target=13} 으로 직접 몰아 그 시점의 DB 를 만든 뒤 오염을 심고,
 * 그 위에 V15 를 얹는다 — 실제 운영 업그레이드와 같은 순서다.
 */
class CatalogCreateIdemBackstopMigrationTest {

    private static final String LOC = "classpath:db/migration";

    @Test
    void v14ReclaimsDuplicateKeysWithoutDeletingHistoryAndThenEnforcesTheBackstop() throws Exception {
        Path db = Files.createTempFile("hmb-v14-", ".db");
        Files.deleteIfExists(db);
        String url = "jdbc:sqlite:" + db.toAbsolutePath();

        // ── 1) V14 시점까지만 마이그레이션(백스톱이 아직 없는 상태) ──
        Flyway.configure().dataSource(url, null, null).locations(LOC)
                .target(MigrationVersion.fromVersion("14")).load().migrate();

        try (Connection c = DriverManager.getConnection(url)) {
            exec(c, "INSERT INTO users(id, nickname, auth_provider, created_at) "
                    + "VALUES ('U-ADMIN','v14admin','local','2026-07-27T00:00:00Z')");
            // 경합 재현: 같은 키로 유닛이 3개 생겨 감사에 3행이 남은 상태.
            insertAudit(c, "A1", "P182", "unit_create", "최초 성공", "K-RACE", "2026-07-27T00:00:01Z");
            insertAudit(c, "A2", "P183", "unit_create", "경합 중복", "K-RACE", "2026-07-27T00:00:02Z");
            insertAudit(c, "A3", "P184", "unit_create", "경합 중복", "K-RACE", "2026-07-27T00:00:03Z");
            // 오염되지 않은 행 — 손대면 안 된다.
            insertAudit(c, "B1", "P185", "unit_create", "정상 생성", "K-OK", "2026-07-27T00:00:04Z");
            // 다른 액션의 같은 키 — V14 대상별 스코프의 정상 시나리오라 절대 건드리면 안 된다.
            insertAudit(c, "C1", "P010", "unit_update", "정상 수정", "K-RACE", "2026-07-27T00:00:05Z");

            // 이 시점엔 백스톱이 없어 중복이 들어간다 = 결함이 실재했음을 이 테스트 안에서 증명한다.
            assertThat(countRows(c, "SELECT COUNT(*) FROM admin_catalog_audit WHERE idem_key='K-RACE'"))
                    .isEqualTo(4L);
        }

        // ── 2) V15 적용 — 오염된 DB 에서도 **성공해야** 한다(실패하면 서버가 안 뜬다) ──
        Flyway.configure().dataSource(url, null, null).locations(LOC).load().migrate();

        try (Connection c = DriverManager.getConnection(url)) {
            // ③ 이력은 한 행도 사라지지 않는다 — 중복 생성된 유닛의 유일한 증거다.
            assertThat(rowIds(c, "SELECT id FROM admin_catalog_audit ORDER BY id"))
                    .containsExactly("A1", "A2", "A3", "B1", "C1");

            Map<String, Map<String, String>> rows = auditRows(c);

            // ④ 승자 = (created_at, id) 최소 = 최초 성공분. 앱의 findAudit 정렬과 동일해야
            //    마이그레이션 전후로 재전송 응답이 바뀌지 않는다.
            assertThat(rows.get("A1").get("idem_key")).isEqualTo("K-RACE");
            assertThat(rows.get("A1").get("reason")).isEqualTo("최초 성공");

            // ⑤ 패자는 키만 회수 — 원 키는 reason 에 각인돼 검색 가능하다(회수 사실도 이력이다).
            for (String id : List.of("A2", "A3")) {
                assertThat(rows.get(id).get("idem_key")).as("%s 의 멱등키가 회수되지 않았다", id).isNull();
                assertThat(rows.get(id).get("reason")).as("%s 의 원 키가 유실됐다", id)
                        .contains("K-RACE").contains("V15");
            }

            // ⑥ 무회귀: 오염되지 않은 행과 **다른 액션**의 같은 키는 한 바이트도 안 바뀐다.
            assertThat(rows.get("B1").get("idem_key")).isEqualTo("K-OK");
            assertThat(rows.get("B1").get("reason")).isEqualTo("정상 생성");
            assertThat(rows.get("C1").get("idem_key")).isEqualTo("K-RACE");
            assertThat(rows.get("C1").get("reason")).isEqualTo("정상 수정");

            // ⑦ 백스톱이 실제로 걸린다 — 이제 같은 키의 두 번째 unit_create 는 DB 가 거절한다.
            assertThatThrownBy(() ->
                    insertAudit(c, "A4", "P186", "unit_create", "재발 시도", "K-RACE", "2026-07-27T00:00:06Z"))
                    .isInstanceOf(SQLException.class)
                    .hasMessageContaining("UNIQUE");

            // ⑧ 그러나 다른 액션의 같은 키는 여전히 통과한다(V14 스코프 무회귀 — 부분 인덱스인 이유).
            insertAudit(c, "C2", "P011", "unit_update", "다른 대상 같은 키", "K-RACE", "2026-07-27T00:00:07Z");
            assertThat(countRows(c,
                    "SELECT COUNT(*) FROM admin_catalog_audit WHERE action='unit_update' AND idem_key='K-RACE'"))
                    .isEqualTo(2L);
        } finally {
            Files.deleteIfExists(db);
        }
    }

    // ───────────────────────── 헬퍼 ─────────────────────────

    private static void exec(Connection c, String sql) throws SQLException {
        try (Statement st = c.createStatement()) {
            st.executeUpdate(sql);
        }
    }

    private static void insertAudit(Connection c, String id, String playerId, String action,
                                    String reason, String idemKey, String createdAt) throws SQLException {
        try (PreparedStatement ps = c.prepareStatement("""
                INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action, before_json,
                                                after_json, changed_fields, reason, idem_key, created_at)
                VALUES (?, 'U-ADMIN', ?, ?, NULL, '{}', 'id', ?, ?, ?)
                """)) {
            ps.setString(1, id);
            ps.setString(2, playerId);
            ps.setString(3, action);
            ps.setString(4, reason);
            ps.setString(5, idemKey);
            ps.setString(6, createdAt);
            ps.executeUpdate();
        }
    }

    private static long countRows(Connection c, String sql) throws SQLException {
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            rs.next();
            return rs.getLong(1);
        }
    }

    private static List<String> rowIds(Connection c, String sql) throws SQLException {
        List<String> out = new ArrayList<>();
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            while (rs.next()) {
                out.add(rs.getString(1));
            }
        }
        return out;
    }

    private static Map<String, Map<String, String>> auditRows(Connection c) throws SQLException {
        Map<String, Map<String, String>> out = new LinkedHashMap<>();
        try (Statement st = c.createStatement();
             ResultSet rs = st.executeQuery("SELECT id, idem_key, reason FROM admin_catalog_audit")) {
            while (rs.next()) {
                Map<String, String> row = new LinkedHashMap<>();
                row.put("idem_key", rs.getString("idem_key"));
                row.put("reason", rs.getString("reason"));
                out.put(rs.getString("id"), row);
            }
        }
        return out;
    }
}
