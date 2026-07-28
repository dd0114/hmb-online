package online.hmb.away;

import java.time.Instant;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 레이팅(#245) — <b>{@code wallets.points} 와는 다른 축</b>이다.
 *
 * <p>포인트는 뽑기·강화로 <b>소비되는 재화</b>라 "얼마나 강한가"를 말할 수 없다(잘 싸운 유저와
 * 안 쓴 유저가 구분되지 않는다). 그래서 원정 승패만 반영하는 별도 축을 둔다. hero 확정 = 초기 0,
 * <b>하한 없음</b>(방어에 계속 실패하면 음수로 내려간다 — 0 에서 멈추면 그 아래가 표현되지 않는다).
 *
 * <p>멱등 메커니즘은 {@link online.hmb.meta.WalletService} 와 <b>동형</b>이다: 원장에 먼저
 * INSERT OR IGNORE 하고, 실제로 들어간 경우에만 잔액을 움직인다. 유니크 인덱스
 * {@code uq_rating_ledger_reason_ref} 가 최종 방어선 — 정산이 재시도돼도 두 번 가산되지 않는다.
 */
@Service
public class RatingService {

    private final JdbcClient jdbcClient;

    public RatingService(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * 레이팅 가감 + 원장 기록. 같은 (user, reason, refId) 가 이미 있으면 아무것도 하지 않고 false.
     * 호출자의 트랜잭션 안에서 쓴다(트랜잭션 경계 = 서비스 메서드).
     */
    public boolean apply(String userId, int delta, String reason, String refId) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO rating_ledger(user_id, delta, reason, ref_id, created_at)
                        VALUES (?, ?, ?, ?, ?)
                        """)
                .params(userId, delta, reason, refId, Instant.now().toString())
                .update();
        if (inserted == 0) {
            return false;
        }
        // 행이 없는 계정(마이그레이션 이후 생성 등)도 여기서 자리를 잡는다 — UPDATE 만 하면
        // 0행이라 가감이 조용히 사라진다.
        jdbcClient.sql("""
                        INSERT INTO user_ratings(user_id, rating, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          rating = rating + excluded.rating, updated_at = excluded.updated_at
                        """)
                .params(userId, delta, Instant.now().toString())
                .update();
        return true;
    }

    /** 현재 레이팅. 행이 없으면 0(초기값과 같다 — 없는 것과 0 은 구분할 필요가 없다). */
    public int rating(String userId) {
        return jdbcClient.sql("SELECT rating FROM user_ratings WHERE user_id = ?")
                .param(userId)
                .query(Integer.class)
                .optional()
                .orElse(0);
    }
}
