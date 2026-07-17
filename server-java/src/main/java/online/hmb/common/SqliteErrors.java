package online.hmb.common;

import java.sql.SQLException;
import org.springframework.dao.DataAccessException;
import org.springframework.dao.DataIntegrityViolationException;

/**
 * sqlite-jdbc 예외 판별 유틸. Spring의 SQLState 기반 번역기가 SQLite 에러코드를 모르기 때문에
 * UNIQUE 위반이 DataIntegrityViolationException으로 세분화되지 않고
 * UncategorizedSQLException으로 올 수 있다 — 메시지의 SQLITE_CONSTRAINT로 판별한다.
 */
public final class SqliteErrors {

    private SqliteErrors() {
    }

    /** UNIQUE/PK 제약 위반이면 true (프리셋 이름 중복, 원장 멱등 충돌 등). */
    public static boolean isUniqueViolation(DataAccessException e) {
        if (e instanceof DataIntegrityViolationException) {
            return true;
        }
        Throwable cause = e.getMostSpecificCause();
        if (cause instanceof SQLException se) {
            String msg = String.valueOf(se.getMessage());
            return msg.contains("SQLITE_CONSTRAINT") || msg.contains("UNIQUE constraint failed");
        }
        return false;
    }
}
