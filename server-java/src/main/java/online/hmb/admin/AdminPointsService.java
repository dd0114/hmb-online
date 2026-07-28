package online.hmb.admin;

import java.time.Instant;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.meta.WalletService;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * admin 포인트 지급/차감(AC-C1). <b>지갑 · 원장 · 감사 3중 기록이 하나의 트랜잭션</b>이다 —
 * 셋 중 하나만 남는 상태가 존재할 수 없다(어느 단계가 실패해도 전부 롤백).
 *
 * <p><b>멱등 설계</b>: 원장 유니크 인덱스 {@code uq_ledger_reason_ref(user_id, reason, ref_id)} 를
 * 그대로 쓴다({@code reason='admin_grant'}, {@code ref_id=멱등키}). 기존 보상 멱등과 <b>같은 메커니즘</b>이라
 * 새 개념을 만들지 않는다. {@link WalletService#apply} 가 false 를 돌려주면 = 이미 적용된 요청 =
 * <b>재전송</b>이므로 감사도 쓰지 않고 현재 잔액과 함께 {@code applied=false} 로 응답한다(200 재생).
 *
 * <p><b>키는 클라이언트가 준다</b>({@code Idempotency-Key} 헤더, 선택). 근거: "이 두 요청이 같은
 * 의도인가"는 <b>서버가 알 수 없는 정보</b>다 — 같은 admin 이 같은 유저에게 1000P 를 두 번 주는 것은
 * 정당한 두 번의 지급일 수도, 네트워크 재전송일 수도 있고 서버는 둘을 구분할 근거가 없다.
 * 서버가 내용 해시로 키를 만들면 <b>정당한 두 번째 지급을 조용히 삼키는</b> 더 나쁜 실패가 된다.
 * 헤더가 없으면 서버가 ULID 를 채번한다 — 그 요청은 재전송 보호를 받지 못하며, 응답의
 * {@code idempotencyKey} 로 그 사실이 관측된다(운영 UI 는 항상 헤더를 보내야 한다).
 * 헤더를 <b>필수</b>로 두지 않은 이유는 확정 계약(바디 {@code {delta, reason}})의 호환을 깨지 않기 위해서다.
 *
 * <p><b>잔액 하한</b>: 음수 잔액은 허용하지 않는다. 사전 검사(400 INSUFFICIENT_POINTS) + DB
 * {@code CHECK (points >= 0)} 백스톱 2층이다. 사전 검사만 두면 동시 차감이 검사를 모두 통과하는
 * read-modify-write 경합에서 뚫리는데, 그때는 UPDATE 가 CHECK 위반으로 터지고 <b>트랜잭션이 통째로
 * 롤백</b>되므로(원장·감사 포함) 잔액이 음수가 되는 상태는 도달 불가다. 그 예외도 같은 400 으로 매핑해
 * 클라이언트에게는 동일하게 보인다.
 */
@Service
public class AdminPointsService {

    /** 원장 사유(point_ledger.reason 열거 확장) — admin 수동 지급/차감. */
    public static final String LEDGER_REASON = "admin_grant";
    /** 감사 액션 종류. */
    public static final String AUDIT_ACTION = "points_grant";

    private static final int REASON_MAX_CHARS = 500;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final WalletService walletService;
    private final AdminUserQueryService users;
    private final EconomyService economyService;

    public AdminPointsService(JdbcClient jdbcClient,
                              TxRunner txRunner,
                              WalletService walletService,
                              AdminUserQueryService users,
                              EconomyService economyService) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.walletService = walletService;
        this.users = users;
        this.economyService = economyService;
    }

    /** 무료재화 심볼 (#232) — 잔액 문구가 "P" 를 박고 있으면 표기 변경이 서버 배포가 된다. */
    private String symbol() {
        return economyService.currency(EconomyService.CURRENCY_POINT).symbol();
    }

    public GrantResult grant(String actorUserId, String targetUserId, Long delta, String reason, String idemKeyHeader) {
        if (delta == null || delta == 0L) {
            throw ApiException.validation("delta 는 0이 아닌 정수여야 합니다");
        }
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("reason 은 필수입니다(운영 사유 기록)");
        }
        if (reason.length() > REASON_MAX_CHARS) {
            throw ApiException.validation("reason 은 " + REASON_MAX_CHARS + "자 이하여야 합니다");
        }
        if (!users.exists(targetUserId)) {
            throw ApiException.notFound("유저를 찾을 수 없습니다");
        }

        String idemKey = (idemKeyHeader == null || idemKeyHeader.isBlank())
                ? Ulid.next()
                : idemKeyHeader.trim();

        try {
            return txRunner.run(() -> applyInTx(actorUserId, targetUserId, delta, reason, idemKey));
        } catch (DataAccessException e) {
            if (SqliteErrors.isCheckViolation(e)) {
                // wallets.points >= 0 백스톱 — 동시 차감이 사전 검사를 함께 통과한 경우.
                throw new ApiException(HttpStatus.BAD_REQUEST, "INSUFFICIENT_POINTS",
                        "잔액이 부족합니다(차감 후 잔액이 음수가 될 수 없습니다)");
            }
            throw e;
        }
    }

    private GrantResult applyInTx(String actorUserId, String targetUserId, long delta,
                                  String reason, String idemKey) {
        long before = walletService.points(targetUserId);
        if (before + delta < 0) {
            throw new ApiException(HttpStatus.BAD_REQUEST, "INSUFFICIENT_POINTS",
                    "잔액이 부족합니다(보유 " + before + symbol() + ", 요청 " + delta + symbol() + ")");
        }

        boolean applied = walletService.apply(targetUserId, delta, LEDGER_REASON, idemKey);
        if (!applied) {
            // 이 키는 이미 쓰였다. 여기서 **금액이 같은지** 반드시 확인한다.
            //
            // 왜: 같은 키로 다른 금액이 오는 건 "재전송"이 아니라 **다른 요청**이다. 그걸 조용히
            // 삼키면(200 + applied:false) admin 은 금액을 잘못 넣고 정정 재전송했을 때 **성공했다고
            // 믿는데 돈은 안 움직인다** — 데이터는 안전하지만 운영 함정이다(검증자 실측:
            // key=SHARED delta=+500 적용 후 delta=+99999 가 200 applied:false 로 삼켜졌다).
            // 표준 멱등 규약대로 409 로 거절한다.
            //
            // reason 은 비교하지 않는다: 돈을 움직이는 필드는 delta 하나이고, reason 은 운영 메모라
            // 문구가 달라졌다고 "다른 금융 조작"이라고 볼 근거가 없다(오타 수정 재전송을 막게 된다).
            long existingDelta = jdbcClient.sql("""
                            SELECT delta FROM point_ledger
                            WHERE user_id = ? AND reason = ? AND ref_id = ?
                            """)
                    .params(targetUserId, LEDGER_REASON, idemKey)
                    .query(Long.class)
                    .single();
            if (existingDelta != delta) {
                throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                        "이 Idempotency-Key 는 이미 다른 금액(" + existingDelta + symbol() + ")으로 사용됐습니다. "
                                + "금액을 정정하려면 새 Idempotency-Key 로 요청하세요");
            }
            // 같은 금액의 정상 재전송 — 감사도 쓰지 않는다(중복 0).
            return new GrantResult(targetUserId, delta, false, before, idemKey, null);
        }

        String auditId = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO admin_audit(id, actor_user_id, target_user_id, action, delta, reason,
                                                idem_key, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(auditId, actorUserId, targetUserId, AUDIT_ACTION, delta, reason, idemKey,
                        Instant.now().toString())
                .update();

        return new GrantResult(targetUserId, delta, true, before + delta, idemKey, auditId);
    }

    /**
     * @param applied false = 같은 멱등키의 재전송이라 아무것도 바뀌지 않았다(잔액은 현재값).
     */
    public record GrantResult(String userId, long delta, boolean applied, long balance,
                              String idempotencyKey, String auditId) {
    }
}
