package online.hmb.auth;

import java.time.Instant;
import java.util.Optional;
import java.util.regex.Pattern;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.meta.WalletService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataAccessException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * 목업 로그인(닉네임만으로 인증, D8). 신규 닉네임이면 하나의 트랜잭션으로
 * users + wallets + 스타터 팩(user_players, economy.v1.json starterPack) + 원장('starter',
 * ref=userId, +initialPoints)을 생성한다 (LLD §3, AC-S1).
 *
 * 추후 OAuth 구현체 추가 지점: AuthProvider를 구현한 별도 클래스(예: GoogleOAuthProvider)를
 * 추가하고 빈 교체 — 컨트롤러/세션/온보딩 로직 불변.
 */
@Component
public class MockAuthProvider implements AuthProvider {

    private static final Logger log = LoggerFactory.getLogger(MockAuthProvider.class);
    private static final Pattern NICKNAME_PATTERN = Pattern.compile("^[\\p{L}\\p{N}_-]{2,16}$");

    /** 원장 사유 — ERD point_ledger.reason 주석의 열거값. */
    static final String LEDGER_REASON_STARTER = "starter";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final EconomyService economyService;
    private final WalletService walletService;

    public MockAuthProvider(JdbcClient jdbcClient,
                            TxRunner txRunner,
                            EconomyService economyService,
                            WalletService walletService) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.economyService = economyService;
        this.walletService = walletService;
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

        try {
            return createNewUser(nickname);
        } catch (DataAccessException e) {
            // 동시 첫 로그인 경합: 다른 요청이 먼저 같은 닉네임을 커밋한 경우(users.nickname
            // UNIQUE 위반, tx 전체 롤백됨) → 기존 유저 재조회로 로그인 처리 (W1 이월사항 c)
            if (!SqliteErrors.isUniqueViolation(e)) {
                throw e;
            }
            String racedId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                    .param(nickname)
                    .query(String.class)
                    .optional()
                    .orElseThrow(() -> e);
            return new AuthResult(racedId, nickname, false);
        }
    }

    private AuthResult createNewUser(String nickname) {
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

            grantStarterPack(userId, now);

            return new AuthResult(userId, nickname, true);
        });
    }

    /**
     * 스타터 팩 지급 — 신규 유저 생성 트랜잭션의 일부(같은 tx, 실패 시 전체 롤백).
     * 수치·구성은 economy.v1.json에서만 온다(AC-S5). 원장 ref=userId라 재실행돼도 멱등
     * (기존 유저 재로그인은 이 경로에 오지도 않는다 — isNew 분기).
     */
    private void grantStarterPack(String userId, String now) {
        Optional<EconomyService.Economy> economyOpt = economyService.get();
        if (economyOpt.isEmpty()) {
            log.warn("economy config unavailable — user {} created WITHOUT starter pack", userId);
            return;
        }
        EconomyService.Economy economy = economyOpt.get();

        for (String playerId : economy.starterPack()) {
            jdbcClient.sql("""
                            INSERT OR IGNORE INTO user_players(user_id, player_id, count, acquired_at)
                            VALUES (?, ?, 1, ?)
                            """)
                    .params(userId, playerId, now)
                    .update();
        }

        walletService.apply(userId, economy.initialPoints(), LEDGER_REASON_STARTER, userId);
    }
}
