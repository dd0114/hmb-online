package online.hmb.meta;

import java.time.Instant;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 지갑(잔액) + 포인트 원장. 지급/차감은 반드시 원장 기록과 함께 — 멱등은
 * uq_ledger_reason_ref(user_id, reason, ref_id WHERE ref_id IS NOT NULL)가 보장한다.
 * 호출자는 서비스 메서드 트랜잭션 안에서 사용한다(트랜잭션 경계 = 서비스 메서드).
 */
@Service
public class WalletService {

    private final JdbcClient jdbcClient;

    public WalletService(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 포인트 지급/차감(delta 음수 가능) + 원장 기록. 같은 (user, reason, refId)가 이미 있으면
     * 아무것도 하지 않고 false(멱등 — AC-M6 보상 중복 방지와 동일 메커니즘).
     */
    public boolean apply(String userId, long delta, String reason, String refId) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO point_ledger(user_id, delta, reason, ref_id, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(userId, delta, reason, refId, Instant.now().toString())
                .update();
        if (inserted == 0) {
            return false;
        }
        jdbcClient.sql("UPDATE wallets SET points = points + ? WHERE user_id = ?")
                .params(delta, userId)
                .update();
        return true;
    }

    public long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId)
                .query(Long.class)
                .single();
    }

    /**
     * 젬 지급/차감(delta 음수 가능) + 원장 기록(gem_ledger, V2.2 재화 이원화). point_ledger/apply 와
     * 동형 — 멱등은 uq_gem_ledger_reason_ref(user_id, reason, ref_id WHERE ref_id IS NOT NULL)가 보장한다.
     */
    public boolean applyGems(String userId, long delta, String reason, String refId) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO gem_ledger(user_id, delta, reason, ref_id, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(userId, delta, reason, refId, Instant.now().toString())
                .update();
        if (inserted == 0) {
            return false;
        }
        jdbcClient.sql("UPDATE wallets SET gems = gems + ? WHERE user_id = ?")
                .params(delta, userId)
                .update();
        return true;
    }

    public long gems(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?")
                .param(userId)
                .query(Long.class)
                .single();
    }
}
