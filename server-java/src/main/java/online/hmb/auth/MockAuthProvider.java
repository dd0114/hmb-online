package online.hmb.auth;

import java.time.Instant;
import java.util.Optional;
import java.util.regex.Pattern;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * 목업 로그인(닉네임만으로 인증, D8). 신규 닉네임이면 user+wallet을 생성한다.
 *
 * W0 스코프: 스타터 팩(14명 지급 + 3,000pt 원장 기록, PRD §3.2)은 economy.v1.json 로딩이
 * 선행돼야 하므로 W1에서 구현한다. 지금은 wallet만 0포인트로 생성.
 * TODO(W1, 에픽 server-java): PlayerCatalogService/economy 로딩 완료 후 스타터 팩(user_players 14명
 * + point_ledger reason='starter' +economy.starterPoints) 지급 로직을 여기 또는 UserOnboardingService에 추가.
 */
@Component
public class MockAuthProvider implements AuthProvider {

    private static final Pattern NICKNAME_PATTERN = Pattern.compile("^[\\p{L}\\p{N}_-]{2,16}$");

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;

    public MockAuthProvider(JdbcClient jdbcClient, TxRunner txRunner) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
    }

    @Override
    public AuthResult authenticate(LoginRequest request) {
        String nickname = request == null ? null : request.nickname();
        if (nickname == null || !NICKNAME_PATTERN.matcher(nickname).matches()) {
            throw ApiException.validation("닉네임은 2~16자의 문자/숫자/_/-만 허용됩니다");
        }

        Optional<String> existingId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname)
                .query(String.class)
                .optional();

        if (existingId.isPresent()) {
            return new AuthResult(existingId.get(), nickname, false);
        }

        return txRunner.run(() -> {
            // 동시 로그인 경합 대비: 트랜잭션 안에서 재확인.
            Optional<String> raced = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                    .param(nickname)
                    .query(String.class)
                    .optional();
            if (raced.isPresent()) {
                return new AuthResult(raced.get(), nickname, false);
            }

            String userId = Ulid.next();
            String now = Instant.now().toString();

            jdbcClient.sql("INSERT INTO users(id, nickname, auth_provider, created_at) VALUES (?, ?, 'mock', ?)")
                    .params(userId, nickname, now)
                    .update();

            jdbcClient.sql("INSERT INTO wallets(user_id, points) VALUES (?, 0)")
                    .param(userId)
                    .update();

            return new AuthResult(userId, nickname, true);
        });
    }
}
