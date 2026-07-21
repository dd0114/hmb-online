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
 * V5__p3_admin.sql(P3 §C, P3-D4)이 V1~V4 위에 클린 적용되는지 검증. additive 만 —
 * users.is_admin(DEFAULT 0) + admin_audit 테이블/인덱스 추가, 기존 컬럼·테이블 불변.
 */
@SpringBootTest
class FlywayV5MigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v5AddsIsAdminDefaultingToZero() {
        assertThat(columnsOf("users")).contains("is_admin");

        // NOT NULL + DEFAULT 0 = 마이그레이션만으로는 admin 이 생기지 않는다(기본 안전).
        assertThat(jdbcClient.sql("SELECT \"notnull\" FROM pragma_table_info('users') WHERE name='is_admin'")
                .query(Integer.class).single()).isEqualTo(1);
        assertThat(jdbcClient.sql("SELECT dflt_value FROM pragma_table_info('users') WHERE name='is_admin'")
                .query(String.class).single()).isEqualTo("0");

        // 기존 컬럼(V1 + V4)은 그대로
        assertThat(columnsOf("users")).contains("id", "nickname", "auth_provider", "created_at", "password");

        // 마이그레이션 직후 admin 은 0명
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES ('U_V5','v5user','2026-01-01T00:00:00Z')")
                .update();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE is_admin <> 0").query(Long.class).single())
                .isZero();
    }

    @Test
    void v5CreatesAdminAuditWithRequiredColumns() {
        assertThat(columnsOf("admin_audit")).contains(
                "id", "actor_user_id", "target_user_id", "action", "delta", "reason", "idem_key", "created_at");
    }

    /** 멱등 백스톱 — 같은 (action, idem_key) 감사 행이 두 번 들어갈 수 없다. */
    @Test
    void adminAuditIdempotencyIndexRejectsDuplicateKeys() {
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES ('U_ACT','actor','2026-01-01T00:00:00Z')")
                .update();
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES ('U_TGT','target','2026-01-01T00:00:00Z')")
                .update();
        insertAudit("A1", "dup-key");
        assertThatThrownBy(() -> insertAudit("A2", "dup-key")).isNotNull();

        // NULL 키는 부분 인덱스 대상이 아니라 여러 행 허용(비-포인트 액션 확장 여지)
        insertAudit("A3", null);
        insertAudit("A4", null);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM admin_audit WHERE idem_key IS NULL")
                .query(Long.class).single()).isEqualTo(2L);
    }

    @Test
    void migrationHistoryContainsV5() {
        List<String> versions = jdbcClient.sql("SELECT version FROM flyway_schema_history WHERE success = 1")
                .query(String.class).list();
        assertThat(versions).contains("1", "2", "3", "4", "5");
    }

    private void insertAudit(String id, String idemKey) {
        jdbcClient.sql("""
                        INSERT INTO admin_audit(id, actor_user_id, target_user_id, action, delta, reason,
                                                idem_key, created_at)
                        VALUES (?, 'U_ACT', 'U_TGT', 'points_grant', 10, 'r', ?, '2026-01-01T00:00:00Z')
                        """)
                .params(id, idemKey)
                .update();
    }

    private List<String> columnsOf(String table) {
        return jdbcClient.sql("SELECT name FROM pragma_table_info(?)").param(table).query(String.class).list();
    }
}
