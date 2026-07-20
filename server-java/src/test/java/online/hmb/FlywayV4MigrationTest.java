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
 * V4__p3_local_auth.sql(P3 §A, P3-D2)이 V1~V3 위에 클린 적용되는지 검증.
 * additive 만 — users.password TEXT NULL(평문 목업, 해시 전환은 백로그) 추가 + 기존 컬럼 불변.
 */
@SpringBootTest
class FlywayV4MigrationTest {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDbWithMissingData(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void v4AddsNullablePasswordToUsers() {
        assertThat(columnsOf("users")).contains("password");

        // NULL 허용(기존 guest/mock 유저는 비번 없음)
        Integer notNull = jdbcClient.sql("SELECT \"notnull\" FROM pragma_table_info('users') WHERE name = 'password'")
                .query(Integer.class).single();
        assertThat(notNull).isZero();

        // 기존 컬럼은 그대로
        assertThat(columnsOf("users")).contains("id", "nickname", "auth_provider", "created_at");
    }

    @Test
    void existingRowsKeepNullPasswordAndLocalRowsPersist() {
        jdbcClient.sql("INSERT INTO users(id, nickname, created_at) VALUES ('U_NOPW','nopw','2026-01-01T00:00:00Z')")
                .update();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE id='U_NOPW' AND password IS NULL")
                .query(Long.class).single()).isEqualTo(1L);

        jdbcClient.sql("""
                        INSERT INTO users(id, nickname, auth_provider, password, created_at)
                        VALUES ('U_PW','pw','local','plaintext-mock','2026-01-01T00:00:00Z')
                        """).update();
        assertThat(jdbcClient.sql("SELECT password FROM users WHERE id='U_PW'")
                .query(String.class).single()).isEqualTo("plaintext-mock");
    }

    @Test
    void migrationHistoryContainsV4() {
        List<String> versions = jdbcClient.sql("SELECT version FROM flyway_schema_history WHERE success = 1")
                .query(String.class).list();
        assertThat(versions).contains("1", "2", "3", "4");
    }

    private List<String> columnsOf(String table) {
        return jdbcClient.sql("SELECT name FROM pragma_table_info(?)").param(table).query(String.class).list();
    }
}
