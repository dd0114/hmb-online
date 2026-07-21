package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.sql.SQLException;
import online.hmb.common.SqliteErrors;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.jdbc.UncategorizedSQLException;

/**
 * #152 판별 단위테스트 — 동시 쓰기 실패(SQLITE_BUSY 계열)를 재시도 가능 오류로 정확히 골라내는지.
 * 실제 관측된 메시지(sqlite-jdbc 3.x, error code 5)를 그대로 쓴다: Spring 의 SQLState 번역기가
 * SQLite 코드를 몰라 {@link UncategorizedSQLException} 으로 올라온다.
 */
class SqliteBusyMappingTest {

    private static UncategorizedSQLException sqlEx(String message) {
        return new UncategorizedSQLException("PreparedStatementCallback", "UPDATE trade_slots ...",
                new SQLException(message, null, 5));
    }

    @Test
    void detectsBusySnapshotFromRealMessage() {
        assertThat(SqliteErrors.isBusy(sqlEx(
                "[SQLITE_BUSY_SNAPSHOT] Another database connection has already written to the database "
                        + "(database is locked)"))).isTrue();
    }

    @Test
    void detectsPlainBusy() {
        assertThat(SqliteErrors.isBusy(sqlEx("[SQLITE_BUSY] The database file is locked (database is locked)")))
                .isTrue();
    }

    @Test
    void doesNotConfuseBusyWithConstraintViolations() {
        assertThat(SqliteErrors.isBusy(sqlEx("[SQLITE_CONSTRAINT_UNIQUE] UNIQUE constraint failed: ..."))).isFalse();
        assertThat(SqliteErrors.isBusy(sqlEx("[SQLITE_CONSTRAINT_CHECK] CHECK constraint failed: ..."))).isFalse();
        assertThat(SqliteErrors.isBusy(new DataIntegrityViolationException("dup"))).isFalse();
        // 반대 방향도 오염되지 않는다(기존 판별 무회귀)
        assertThat(SqliteErrors.isUniqueViolation(sqlEx("[SQLITE_BUSY_SNAPSHOT] ... (database is locked)")))
                .isFalse();
        assertThat(SqliteErrors.isCheckViolation(sqlEx("[SQLITE_BUSY_SNAPSHOT] ... (database is locked)")))
                .isFalse();
    }
}
