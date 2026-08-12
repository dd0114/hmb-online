package online.hmb.coupon;

import java.time.Clock;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import online.hmb.common.Ulid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * #493 W6-v3 — <b>무료 쿠폰</b>: "이번 한 번은 값을 안 낸다"는 1회성 권리.
 *
 * <p>hero verbatim: <i>"이런 무료쿠폰개념은 나중에 쓰일수있으니까 이것도 설계 잘해두자"</i> —
 * 그래서 이 서비스는 튜토리얼을 모른다. 아는 것은 <b>지급·보유·소비</b> 셋뿐이고, 튜토리얼은
 * 그것을 처음 쓰는 소비자일 뿐이다.
 *
 * <p><b>재화가 아니다</b>(V42 머리말 참조). 쿠폰이 소비되면 차감 자체가 일어나지 않으므로
 * 원장에 행이 생기지 않는다 — "왜 골드가 줄었나/늘었나"의 답은 여전히 기존 원장 하나다.
 *
 * <p><b>멱등 2축</b>:
 * <ul>
 *   <li>지급 = {@code uq_user_coupons_grant(user_id, type, grant_key)} + {@code INSERT OR IGNORE}.
 *       스타터 지급이 몇 번 재실행돼도 한 장이다.</li>
 *   <li>소비 = {@code UPDATE … WHERE used_at IS NULL} 의 <b>갱신 행 수</b>. 선검사(read-then-act)로
 *       판정하지 않는다 — 그 형태는 #286 BL-1 이 실측으로 뚫었다(동시 6요청 → 6판 생성).</li>
 * </ul>
 *
 * <p><b>호출 규약</b>: 자체 트랜잭션을 열지 않는다. 소비는 반드시 <b>혜택을 주는 쪽과 같은
 * 트랜잭션</b>에서 불러야 한다 — 갈라 두면 "쿠폰은 썼는데 강화는 실패"가 생기고 회수 경로가 없다.
 */
@Service
public class CouponService {

    private static final Logger log = LoggerFactory.getLogger(CouponService.class);

    /**
     * 유효한 쿠폰 종류의 <b>SoT</b>. DB 에 CHECK 를 걸지 않은 이유 = 종류가 늘 때마다
     * 마이그레이션이 필요해지면 "나중에 재사용"이라는 목적이 깨진다(V42 머리말).
     *
     * <p>새 종류를 더할 때는 ①여기에 상수 ②소비 지점에서 {@link #consume} 호출 ③(필요하면) 지급
     * 지점. 조회 API 는 enum 을 순회하므로 자동으로 따라온다.
     */
    public enum CouponType {
        /** 첫 강화(잠재 다이스) 비용 무료 — {@code GrowthService.dice} 가 소비한다. */
        FREE_ENHANCE,
        /** 트레이드 시간단축 비용 무료 — {@code TradeService.speedup} 이 소비한다. */
        FREE_TRADE_RUSH,
        /**
         * 첫 트레이드 <b>등급 확정</b> 티켓 — {@code TradeService.riggedIfEntitled} 가 소비한다.
         *
         * <p>⚠️ 이 종류는 "무료"가 아니라 "결과 보장"이다. 표(V42)가 나타내는 것은 <b>1회성 권리</b>
         * 일반이고 "무료"는 첫 두 소비자의 성격일 뿐이다 — 같은 원자적 소비 규율이 필요하므로 여기 둔다
         * (별도 표를 만들면 멱등·CAS 코드가 두 벌이 된다).
         *
         * <p>이름의 {@code EPIC} 은 hero 원문("에픽 정도")의 흔적이다. 실제 등급은
         * {@code hmb.tutorial.trade.first-grade} 가 정한다 — 등급 사다리에 EPIC 은 없다.
         */
        FIRST_TRADE_EPIC
    }

    /** 스타터 지급의 멱등 키 — 같은 유저에게 두 번 돌아도 한 장이다. */
    public static final String GRANT_KEY_STARTER = "starter";

    private final JdbcClient jdbcClient;
    private final Clock clock;

    public CouponService(JdbcClient jdbcClient, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.clock = clock;
    }

    /**
     * 쿠폰 1장 지급. <b>멱등</b> — 같은 {@code (userId, type, grantKey)} 는 몇 번을 불러도 한 장이다.
     *
     * @param grantKey 지급 사유이자 멱등 키. 같은 종류를 여러 장 주려면 키를 달리한다
     *                 (예: {@code "event:2026-08"} · {@code "mail:<campaignId>"}).
     * @param expiresAt 만료 시각(ISO-8601) 또는 {@code null}(무기한).
     * @return 이번 호출이 실제로 새 쿠폰을 만들었는가(멱등이라 {@code false} 도 정상 경로다)
     */
    public boolean grant(String userId, CouponType type, String grantKey, String expiresAt) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_coupons(id, user_id, type, grant_key, granted_at,
                                                           used_at, used_ref, expires_at)
                        VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
                        """)
                .params(Ulid.next(), userId, type.name(), grantKey, now(), expiresAt)
                .update();
        if (inserted == 1) {
            log.info("coupon granted: user={} type={} key={}", userId, type, grantKey);
            return true;
        }
        return false;
    }

    /** 만료 없는 지급(대부분의 경우). */
    public boolean grant(String userId, CouponType type, String grantKey) {
        return grant(userId, type, grantKey, null);
    }

    /** 지금 쓸 수 있는 쿠폰이 있는가(만료분 제외). */
    public boolean hasUnused(String userId, CouponType type) {
        return unusedCount(userId, type) > 0;
    }

    /** 지금 쓸 수 있는 장수 — 화면이 "무료" 뱃지를 그릴 근거. */
    public int unusedCount(String userId, CouponType type) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM user_coupons
                        WHERE user_id = ? AND type = ? AND used_at IS NULL
                          AND (expires_at IS NULL OR expires_at > ?)
                        """)
                .params(userId, type.name(), now())
                .query(Integer.class)
                .single();
    }

    /** 종류별 보유 장수(0 인 종류도 포함) — {@code GET /api/me} 가 그대로 싣는다. */
    public Map<String, Integer> unusedCounts(String userId) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (CouponType type : CouponType.values()) {
            out.put(type.name(), 0);
        }
        List<Map.Entry<String, Integer>> rows = jdbcClient.sql("""
                        SELECT type, COUNT(*) AS cnt FROM user_coupons
                        WHERE user_id = ? AND used_at IS NULL
                          AND (expires_at IS NULL OR expires_at > ?)
                        GROUP BY type
                        """)
                .params(userId, now())
                .query((rs, rowNum) -> Map.entry(rs.getString("type"), rs.getInt("cnt")))
                .list();
        for (Map.Entry<String, Integer> row : rows) {
            // 모르는 종류(enum 에서 빠진 옛 문자열)는 조용히 무시한다 — 실패 모드는 "혜택 없음"이다.
            if (out.containsKey(row.getKey())) {
                out.put(row.getKey(), row.getValue());
            }
        }
        return out;
    }

    /**
     * 쿠폰 1장을 <b>원자적으로</b> 소비한다. <b>혜택을 주는 쪽과 같은 트랜잭션에서 부를 것.</b>
     *
     * <p>이중 소비 방어는 선검사가 아니라 {@code WHERE used_at IS NULL} 의 갱신 행 수다 —
     * 두 요청이 동시에 들어와도 한 쪽만 1행을 갱신한다. 후보는 <b>먼저 받은 것부터</b>
     * ({@code granted_at, id}) 쓴다: 만료가 붙은 쿠폰이 섞이면 오래된 것이 먼저 사라지는 쪽이
     * 유저에게 유리하다.
     *
     * @param usedRef 어디에 썼나(감사용, 예: {@code "dice:P122"} · {@code "trade:1"})
     * @return 소비한 쿠폰 id, 쓸 수 있는 쿠폰이 없으면 {@link Optional#empty()}
     */
    public Optional<String> consume(String userId, CouponType type, String usedRef) {
        String now = now();
        Optional<String> candidate = jdbcClient.sql("""
                        SELECT id FROM user_coupons
                        WHERE user_id = ? AND type = ? AND used_at IS NULL
                          AND (expires_at IS NULL OR expires_at > ?)
                        ORDER BY granted_at, id
                        LIMIT 1
                        """)
                .params(userId, type.name(), now)
                .query(String.class)
                .optional();
        if (candidate.isEmpty()) {
            return Optional.empty();
        }
        int updated = jdbcClient.sql("""
                        UPDATE user_coupons SET used_at = ?, used_ref = ?
                        WHERE id = ? AND used_at IS NULL
                        """)
                .params(now, usedRef, candidate.get())
                .update();
        if (updated != 1) {
            // 경합에 졌다 — 다른 요청이 방금 그 장을 썼다. "없음"으로 접는다(호출자는 정상 결제로 간다).
            return Optional.empty();
        }
        log.info("coupon consumed: user={} type={} ref={}", userId, type, usedRef);
        return Optional.of(candidate.get());
    }

    private String now() {
        // #245 규율: 시각은 전부 ISO-8601 로 쓴다(문자열 비교가 뒤집히지 않게).
        return Instant.now(clock).toString();
    }
}
