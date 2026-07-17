package online.hmb.auth;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.Optional;
import online.hmb.common.Ulid;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/** 세션 발급·검증. 토큰은 opaque(예측 불가), TTL = hmb.auth.session-ttl-hours. */
@Service
public class SessionService {

    private final JdbcClient jdbcClient;
    private final long sessionTtlHours;

    public SessionService(JdbcClient jdbcClient,
                           @Value("${hmb.auth.session-ttl-hours}") long sessionTtlHours) {
        this.jdbcClient = jdbcClient;
        this.sessionTtlHours = sessionTtlHours;
    }

    public String createSession(String userId) {
        String token = Ulid.opaqueToken();
        String expiresAt = Instant.now().plus(sessionTtlHours, ChronoUnit.HOURS).toString();
        jdbcClient.sql("INSERT INTO sessions(token, user_id, expires_at) VALUES (?, ?, ?)")
                .params(token, userId, expiresAt)
                .update();
        return token;
    }

    /** 유효한 세션이면 userId 반환. 없거나 만료면 empty. */
    public Optional<String> resolveUserId(String token) {
        if (token == null || token.isBlank()) {
            return Optional.empty();
        }
        Optional<SessionRow> row = jdbcClient.sql("SELECT user_id, expires_at FROM sessions WHERE token = ?")
                .param(token)
                .query(SessionRow.class)
                .optional();

        return row.filter(r -> Instant.parse(r.expiresAt()).isAfter(Instant.now()))
                .map(SessionRow::userId);
    }

    private record SessionRow(String userId, String expiresAt) {
    }
}
