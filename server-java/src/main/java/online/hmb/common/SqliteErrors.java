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
        String msg = causeMessage(e);
        return msg.contains("SQLITE_CONSTRAINT_UNIQUE") || msg.contains("SQLITE_CONSTRAINT_PRIMARYKEY")
                || msg.contains("UNIQUE constraint failed")
                || (msg.contains("SQLITE_CONSTRAINT") && msg.contains("UNIQUE"));
    }

    /**
     * CHECK 제약 위반이면 true — 예: wallets.points >= 0 (동시 뽑기 경합으로 사전 잔액검사를
     * 둘 다 통과한 경우 늦은 쪽이 여기서 걸린다 → 400 INSUFFICIENT_POINTS 매핑, W2 이월사항).
     */
    public static boolean isCheckViolation(DataAccessException e) {
        String msg = causeMessage(e);
        return msg.contains("SQLITE_CONSTRAINT_CHECK") || msg.contains("CHECK constraint failed");
    }

    /**
     * SQLite 잠금 경합(BUSY)이면 true — 재시도로 풀리는 일시적 실패다(#152).
     *
     * <p>특히 {@code SQLITE_BUSY_SNAPSHOT}: WAL 에서 <b>읽기로 시작한 트랜잭션이 나중에 쓰기로
     * 승격</b>하려는데 그 사이 다른 커넥션이 커밋한 경우 SQLite 는 <b>busy handler 를 호출하지 않고
     * 즉시</b> 이 오류를 낸다(스냅샷이 이미 낡아 기다려도 해결되지 않으므로). 따라서 JDBC
     * {@code busy_timeout} 이 걸려 있어도 이 경로는 새며, 해법은 <b>롤백 후 트랜잭션 통째 재시도</b>다.
     */
    public static boolean isBusy(DataAccessException e) {
        String msg = causeMessage(e);
        return msg.contains("SQLITE_BUSY") || msg.contains("database is locked")
                || msg.contains("database table is locked");
    }

    private static String causeMessage(DataAccessException e) {
        Throwable cause = e.getMostSpecificCause();
        if (cause instanceof SQLException se) {
            return String.valueOf(se.getMessage());
        }
        return String.valueOf(e.getMessage());
    }
}
