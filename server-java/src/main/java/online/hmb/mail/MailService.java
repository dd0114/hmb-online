package online.hmb.mail;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.util.ArrayList;
import java.util.List;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.meta.WalletService;
import online.hmb.notice.Notices;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 우편함 — <b>유저 쪽</b>(#323): 목록 · 열람 · 수령.
 *
 * <h3>수령이 두 번 되지 않는 이유는 두 겹이다</h3>
 * <ol>
 *   <li><b>상태 CAS</b> — {@code UPDATE … SET claimed_at=? WHERE id=? AND claimed_at IS NULL}.
 *       0행이면 이미 누군가(=같은 유저의 더블탭) 가져간 것이다.</li>
 *   <li><b>원장 유니크</b> — G/Z 지급이 기존 {@code uq_ledger_reason_ref(user_id, reason, ref_id)} 에
 *       {@code reason='mail_claim'}, {@code ref_id=user_mails.id} 로 얹힌다. CAS 가 미래의 잘못된
 *       리팩터로 뚫려도 <b>돈은 두 번 나가지 않는다</b>.</li>
 * </ol>
 * 새 멱등 메커니즘을 만들지 않은 것이 요점이다 — 지갑·원장은 이미 SoT 가 있다(재발명 금지).
 *
 * <h3>더블탭이 409 가 아니라 200 인 이유</h3>
 * admin 의 멱등키 충돌(다른 금액을 같은 키로)은 <b>서로 다른 의도</b>라 409 로 거절해야 하지만,
 * 유저의 두 번째 [받기]는 같은 의도의 재전송이다. 실패로 보이게 하면 "받았는데 에러가 났다"가 되고
 * 문의가 생긴다. {@code applied:false} + 현재 잔액으로 <b>사실대로</b> 답한다.
 *
 * <h3>만료·회수</h3>
 * 410 로 거절한다(회수도 같은 410 — 유저에게 "운영이 회수했다"까지 알릴 필요는 없고, 못 받는다는
 * 사실은 같다). ⚠️ 만료된 메일도 <b>목록에는 남는다</b>(hero 확정 ④) — 놓쳤다는 사실이 보여야 한다.
 * 대신 <b>뱃지에는 세지 않는다</b>: 끌 수 없는 숫자가 남으면 뱃지가 무의미해진다.
 */
@Service
public class MailService {

    /** 원장 사유 — point_ledger / gem_ledger 공용. */
    public static final String LEDGER_REASON = "mail_claim";

    /**
     * <b>"아직 내가 할 일"의 단일 정의</b>. 뱃지 카운트와 목록의 {@code actionable} 이 같은 문자열을
     * 쓴다 — 두 곳에 따로 적으면 "뱃지엔 1인데 열어 보면 할 게 없다"가 된다(그 순간 유저는 뱃지를
     * 믿지 않게 되고, 뱃지의 존재 이유가 사라진다). 계약 = {@code MailboxApiTest.badgeMatchesList}.
     *
     * <p>파라미터는 {@code (userId 는 바깥 WHERE, now)} — 이 조각 안의 {@code ?} 는 now 하나다.
     */
    private static final String ACTIONABLE = """
            c.revoked_at IS NULL
            AND (um.expires_at IS NULL OR um.expires_at > ?)
            AND (um.read_at IS NULL OR (c.has_attachments = 1 AND um.claimed_at IS NULL))
            """;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final WalletService walletService;
    private final ObjectMapper objectMapper;
    private final MailProperties props;
    private final Clock clock;

    public MailService(JdbcClient jdbcClient, TxRunner txRunner, WalletService walletService,
                       ObjectMapper objectMapper, MailProperties props, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.walletService = walletService;
        this.objectMapper = objectMapper;
        this.props = props;
        this.clock = clock;
    }

    // ── 조회 ──────────────────────────────────────────────────────────────

    public MailListResponse list(String userId) {
        String now = Notices.now(clock);
        List<MailView> mails = jdbcClient.sql("""
                        SELECT um.id, um.read_at, um.claimed_at, um.expires_at, um.created_at,
                               c.title, c.body, c.payload_json, c.revoked_at
                        FROM user_mails um JOIN mail_campaigns c ON c.id = um.campaign_id
                        WHERE um.user_id = ?
                        ORDER BY um.created_at DESC, um.id DESC
                        LIMIT ?
                        """)
                .params(userId, props.getListLimit())
                .query((rs, rowNum) -> view(
                        rs.getString("id"),
                        rs.getString("title"),
                        rs.getString("body"),
                        rs.getString("payload_json"),
                        rs.getString("created_at"),
                        rs.getString("expires_at"),
                        rs.getString("revoked_at"),
                        rs.getString("read_at"),
                        rs.getString("claimed_at"),
                        now))
                .list();
        // ⚠️ 목록과 뱃지는 **같은 now** 로 판정한다 — 각자 시계를 읽으면 만료 경계의 1초에서
        // "목록엔 살아 있는데 뱃지엔 안 세는" 상태가 실제로 발생한다.
        return new MailListResponse(mails, unread(userId, now));
    }

    /** 뱃지 수 — {@code GET /api/me} 가 이 값을 싣는다(전용 엔드포인트를 만들지 않는 이유는 설계문서 §3.4). */
    public int unread(String userId) {
        return unread(userId, Notices.now(clock));
    }

    private int unread(String userId, String now) {
        Long count = jdbcClient.sql("""
                        SELECT COUNT(*) FROM user_mails um JOIN mail_campaigns c ON c.id = um.campaign_id
                        WHERE um.user_id = ? AND (""" + ACTIONABLE + ")")
                .params(userId, now)
                .query(Long.class)
                .single();
        return count == null ? 0 : count.intValue();
    }

    // ── 열람 ──────────────────────────────────────────────────────────────

    /**
     * 열람 기록(멱등). 이미 읽었으면 아무것도 쓰지 않는다 — {@code read_at} 이 최초 열람 시각으로
     * 남아야 CS 에서 "언제 봤나"가 성립한다(매번 덮어쓰면 그 정보가 사라진다).
     */
    public MailView read(String userId, String mailId) {
        String now = Notices.now(clock);
        Row row = require(userId, mailId);
        if (row.readAt == null) {
            jdbcClient.sql("UPDATE user_mails SET read_at = ? WHERE id = ? AND user_id = ? AND read_at IS NULL")
                    .params(now, mailId, userId)
                    .update();
        }
        Row after = require(userId, mailId);
        return toView(after, now);
    }

    // ── 수령 ──────────────────────────────────────────────────────────────

    public ClaimResult claim(String userId, String mailId) {
        String now = Notices.now(clock);
        return txRunner.run(() -> claimInTx(userId, mailId, now));
    }

    private ClaimResult claimInTx(String userId, String mailId, String now) {
        Row row = require(userId, mailId);

        if (row.claimedAt != null) {
            // 같은 의도의 재전송 — 사실대로 답한다(지급 없음, 현재 잔액).
            return new ClaimResult(mailId, true, false, Granted.NONE, wallet(userId));
        }
        if (row.revokedAt != null) {
            throw new ApiException(org.springframework.http.HttpStatus.GONE, "GONE",
                    "이 우편물은 회수되어 받을 수 없습니다");
        }
        if (row.expiresAt != null && row.expiresAt.compareTo(now) <= 0) {
            throw new ApiException(org.springframework.http.HttpStatus.GONE, "GONE",
                    "수령 기간이 지난 우편물입니다");
        }

        // ① 상태 CAS — 이 UPDATE 가 1행을 바꾼 요청만 지급으로 넘어간다.
        int taken = jdbcClient.sql("""
                        UPDATE user_mails SET claimed_at = ?, read_at = COALESCE(read_at, ?)
                        WHERE id = ? AND user_id = ? AND claimed_at IS NULL
                        """)
                .params(now, now, mailId, userId)
                .update();
        if (taken == 0) {
            // 같은 트랜잭션 밖에서 먼저 가져갔다(더블탭). 지급하지 않는다.
            return new ClaimResult(mailId, true, false, Granted.NONE, wallet(userId));
        }

        MailAttachments att = parse(row.payloadJson);

        // ② 지급 — 전부 **기존 경로**. ref_id = 이 우편물 id 라 원장 유니크가 두 번째를 막는다.
        if (att.points() != 0) {
            walletService.apply(userId, att.points(), LEDGER_REASON, mailId);
        }
        if (att.gems() != 0) {
            walletService.applyGems(userId, att.gems(), LEDGER_REASON, mailId);
        }

        List<Granted.PlayerGranted> grantedPlayers = new ArrayList<>();
        for (MailAttachments.PlayerGrant p : att.players()) {
            // ⚠️ 발송 시점에 검증했지만 **여기서 다시 본다** — 그 사이 유닛이 카탈로그에서 회수될 수
            // 있다. 그때 없는 id 하나 때문에 G·Z 수령까지 막지 않는다(economy 지급 경로와 같은 규율:
            // 최상위 누락 ≪ 서비스 중단). 건너뛴 사실은 응답에 나타난다(그 항목이 없다).
            if (!playerExists(p.playerId())) {
                continue;
            }
            boolean isNew = grantPlayer(userId, p.playerId(), p.count(), now);
            grantedPlayers.add(new Granted.PlayerGranted(p.playerId(), p.count(), isNew));
        }

        return new ClaimResult(mailId, true, true,
                new Granted(att.points(), att.gems(), grantedPlayers), wallet(userId));
    }

    /** {@code user_players} upsert — 신규면 true(GachaService 와 같은 형태). */
    private boolean grantPlayer(String userId, String playerId, int count, String now) {
        int inserted = jdbcClient.sql("""
                        INSERT OR IGNORE INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, ?, ?)
                        """)
                .params(userId, playerId, count, now)
                .update();
        if (inserted == 0) {
            jdbcClient.sql("UPDATE user_players SET count = count + ? WHERE user_id = ? AND player_id = ?")
                    .params(count, userId, playerId)
                    .update();
            return false;
        }
        return true;
    }

    private boolean playerExists(String playerId) {
        Long n = jdbcClient.sql("SELECT COUNT(*) FROM players WHERE id = ?")
                .param(playerId)
                .query(Long.class)
                .single();
        return n != null && n > 0;
    }

    // ── 내부 ──────────────────────────────────────────────────────────────

    /**
     * 내 우편물 한 통. <b>남의 우편물은 404</b> — 403 은 "그 id 는 실재한다"를 흘린다(공지 단건이
     * 예약 공지를 404 로 숨기는 것과 같은 규율).
     */
    private Row require(String userId, String mailId) {
        return jdbcClient.sql("""
                        SELECT um.id, um.read_at, um.claimed_at, um.expires_at, um.created_at,
                               c.title, c.body, c.payload_json, c.revoked_at
                        FROM user_mails um JOIN mail_campaigns c ON c.id = um.campaign_id
                        WHERE um.id = ? AND um.user_id = ?
                        """)
                .params(mailId, userId)
                .query((rs, rowNum) -> new Row(
                        rs.getString("id"), rs.getString("title"), rs.getString("body"),
                        rs.getString("payload_json"), rs.getString("created_at"),
                        rs.getString("expires_at"), rs.getString("revoked_at"),
                        rs.getString("read_at"), rs.getString("claimed_at")))
                .optional()
                .orElseThrow(() -> ApiException.notFound("우편물을 찾을 수 없습니다"));
    }

    private MailAttachments parse(String payloadJson) {
        try {
            return MailAttachments.normalize(objectMapper.readValue(payloadJson, MailAttachments.class));
        } catch (Exception e) {
            // 저장된 payload 가 깨졌다 = 우리가 쓴 것이 아니다. 조용히 빈 첨부로 지급하면 유저는
            // "받았는데 아무것도 없다"를 겪고 원인은 영영 안 남는다. 실패로 드러낸다.
            throw new IllegalStateException("우편물 첨부 payload 를 읽을 수 없습니다: " + payloadJson, e);
        }
    }

    private WalletView wallet(String userId) {
        return new WalletView(walletService.points(userId), walletService.gems(userId));
    }

    private MailView toView(Row r, String now) {
        return view(r.id, r.title, r.body, r.payloadJson, r.createdAt, r.expiresAt, r.revokedAt,
                r.readAt, r.claimedAt, now);
    }

    private MailView view(String id, String title, String body, String payloadJson, String createdAt,
                          String expiresAt, String revokedAt, String readAt, String claimedAt, String now) {
        return new MailView(id, title, body, parse(payloadJson), createdAt, expiresAt, readAt, claimedAt,
                state(expiresAt, revokedAt, readAt, claimedAt, now).name());
    }

    /**
     * 상태는 <b>서버가 정한다</b>. 클라가 {@code expiresAt < now} 를 계산하면 <b>기기 시계가 진실</b>이
     * 되고(폰 시계가 하루 빠른 유저에게 멀쩡한 보상이 만료로 보인다), 규칙이 바뀔 때 조용히 어긋난다
     * (공지 #248 이 남긴 규율 3번과 같다).
     */
    static MailState state(String expiresAt, String revokedAt, String readAt, String claimedAt, String now) {
        if (claimedAt != null) {
            return MailState.CLAIMED;
        }
        if (revokedAt != null || (expiresAt != null && expiresAt.compareTo(now) <= 0)) {
            return MailState.EXPIRED;
        }
        return readAt == null ? MailState.UNREAD : MailState.READ;
    }

    public enum MailState {
        UNREAD, READ, CLAIMED, EXPIRED
    }

    private record Row(String id, String title, String body, String payloadJson, String createdAt,
                       String expiresAt, String revokedAt, String readAt, String claimedAt) {
    }

    // ── 응답 DTO ──────────────────────────────────────────────────────────

    /** 유저에게 보이는 한 통. {@code state} 는 서버 판정값이다. */
    public record MailView(String id, String title, String body, MailAttachments attachments,
                           String sentAt, String expiresAt, String readAt, String claimedAt, String state) {
    }

    public record MailListResponse(List<MailView> mails, int unread) {
    }

    public record WalletView(long points, long gems) {
    }

    /** @param applied false = 이미 수령한 우편물이라 아무것도 바뀌지 않았다(잔액은 현재값). */
    public record ClaimResult(String id, boolean claimed, boolean applied, Granted granted, WalletView wallet) {
    }

    public record Granted(long points, long gems, List<PlayerGranted> players) {
        public static final Granted NONE = new Granted(0, 0, List.of());

        public record PlayerGranted(String playerId, int count, boolean isNew) {
        }
    }
}
