package online.hmb.admin;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Clock;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.mail.MailAttachments;
import online.hmb.mail.MailProperties;
import online.hmb.notice.Notices;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 우편함 — <b>admin 쪽</b>(#323): 발송 · 회수 · 발송 이력 조회. <b>재배포 0</b>(#309 무배포화 계보).
 *
 * <h3>발송이 두 번 되지 않는 이유</h3>
 * {@code Idempotency-Key} → {@code uq_mail_campaigns_idem}. 애플리케이션 선검사만으로는 동시
 * 재전송(더블클릭)이 둘 다 통과하므로 <b>DB 가 두 번째를 거절</b>하고, 서비스가 그것을 200 재생으로
 * 바꾼다. ⚠️ <b>내용이 다르면 409</b> — {@code AdminPointsService} 가 겪은 함정 그대로다: 같은 키에
 * 다른 금액이 오는 것은 재전송이 아니라 <b>다른 요청</b>이고, 조용히 삼키면 운영자는 정정에
 * 성공했다고 믿는데 아무 일도 일어나지 않는다.
 *
 * <h3>왜 팬아웃(발송 시 유저 행 생성)인가</h3>
 * 지연 구체화(수신 시 만들기)는 목록·뱃지·수령의 읽기 경로가 <b>실행 행 + 가상 캠페인</b> 두 소스로
 * 갈라져 서로 다른 답을 낼 수 있다. 보상 도메인에서 그 불일치는 곧 CS 다. 대신 규모 폭발은
 * {@code hmb.mail.fanout-max} 로 <b>거부</b>한다(조용히 자르지 않는다). 설계 근거 = docs/plan-v5/mailbox.md §3.2.
 *
 * <h3>감사</h3>
 * {@code admin_ops_audit}(V18) 에 {@code mail_send} / {@code mail_revoke} 를 <b>성공·실패 모두</b>
 * 남긴다. {@code admin_audit}(V5)이 아닌 이유 = 그 테이블은 {@code target_user_id NOT NULL} 이라
 * 전체 발송을 표현할 수 없다(공지 #248 이 같은 이유로 ops 원장을 쓴다).
 */
@Service
public class AdminMailService {

    public static final String ACTION_SEND = "mail_send";
    public static final String ACTION_REVOKE = "mail_revoke";

    /** 이력 조회 필터 — {@code _} 는 LIKE 단일문자 와일드카드라 escape 한다(안 하면 남의 액션이 섞인다). */
    private static final String HISTORY_LIKE = "mail\\_%";

    private static final String AUDIENCE_ALL = "ALL";
    private static final String AUDIENCE_USERS = "USERS";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final MailProperties props;
    private final Clock clock;

    public AdminMailService(JdbcClient jdbcClient, TxRunner txRunner, ObjectMapper objectMapper,
                            MailProperties props, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.props = props;
        this.clock = clock;
    }

    // ── 발송 ──────────────────────────────────────────────────────────────

    public SendResult send(String actorUserId, SendRequest req, String idemKeyHeader) {
        String idemKey = (idemKeyHeader == null || idemKeyHeader.isBlank())
                ? Ulid.next()
                : idemKeyHeader.trim();
        try {
            SendResult result = doSend(actorUserId, req, idemKey);
            return result;
        } catch (ApiException e) {
            // 시도 자체가 이력이다 — 거절도 남긴다(공지·economy 운영과 같은 규율).
            audit(actorUserId, ACTION_SEND, "failed", req == null ? null : req.reason(),
                    Map.of("error", String.valueOf(e.getMessage()),
                            "idempotencyKey", idemKey));
            throw e;
        }
    }

    private SendResult doSend(String actorUserId, SendRequest req, String idemKey) {
        if (req == null) {
            throw ApiException.validation("요청 바디가 필요합니다");
        }
        String audience = validAudience(req.audience());
        String title = validText(req.title(), props.getTitleMaxChars(), "title");
        String body = validText(req.body(), props.getBodyMaxChars(), "body");
        String reason = validText(req.reason(), props.getReasonMaxChars(), "reason");
        MailAttachments attachments = validAttachments(req.attachments());
        String expiresAt = resolveExpiry(req.expiresAt(), req.expiresInDays());

        List<String> targets = resolveTargets(audience, req.userIds());
        if (targets.isEmpty()) {
            throw ApiException.validation("대상 유저가 0명입니다");
        }
        if (targets.size() > props.getFanoutMax()) {
            throw ApiException.validation("대상이 " + targets.size() + "명으로 상한("
                    + props.getFanoutMax() + ")을 넘습니다. 나눠서 발송하세요");
        }

        String payloadJson = writePayload(attachments);
        String now = Notices.now(clock);
        String campaignId = Ulid.next();

        try {
            return txRunner.run(() -> {
                jdbcClient.sql("""
                                INSERT INTO mail_campaigns(id, audience, title, body, payload_json,
                                                           has_attachments, expires_at, revoked_at,
                                                           target_count, reason, idem_key, created_by, created_at)
                                VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)
                                """)
                        .params(campaignId, audience, title, body, payloadJson,
                                attachments.isEmpty() ? 0 : 1, expiresAt,
                                targets.size(), reason, idemKey, actorUserId, now)
                        .update();

                for (String userId : targets) {
                    jdbcClient.sql("""
                                    INSERT INTO user_mails(id, user_id, campaign_id, expires_at,
                                                           read_at, claimed_at, created_at)
                                    VALUES (?, ?, ?, ?, NULL, NULL, ?)
                                    """)
                            .params(Ulid.next(), userId, campaignId, expiresAt, now)
                            .update();
                }

                auditInTx(actorUserId, ACTION_SEND, "ok", reason, Map.of(
                        "campaignId", campaignId,
                        "audience", audience,
                        "targetCount", targets.size(),
                        "payload", attachments,
                        "expiresAt", String.valueOf(expiresAt),
                        "idempotencyKey", idemKey));

                return new SendResult(campaignId, audience, targets.size(), expiresAt, true);
            });
        } catch (DataAccessException e) {
            if (SqliteErrors.isUniqueViolation(e)) {
                return replay(idemKey, audience, targets, attachments, expiresAt);
            }
            throw e;
        }
    }

    /**
     * 같은 멱등키의 재전송. <b>내용이 같을 때만</b> 200 재생이고, 다르면 409 다.
     *
     * <p>비교 대상 = 대상(audience·인원)·첨부·만료. {@code title}/{@code body}/{@code reason} 은
     * 비교하지 않는다 — 돈을 움직이는 필드가 아니고, 오타 수정 재전송을 막게 된다.
     */
    private SendResult replay(String idemKey, String audience, List<String> targets,
                              MailAttachments attachments, String expiresAt) {
        Campaign existing = campaignByIdem(idemKey);
        if (existing == null) {
            // 유니크 위반인데 그 키의 행이 없다 = 우리 인덱스가 아닌 다른 제약이 터졌다.
            throw new ApiException(HttpStatus.CONFLICT, "CONFLICT", "발송을 저장하지 못했습니다");
        }
        boolean same = existing.audience().equals(audience)
                && existing.targetCount() == targets.size()
                && Objects.equals(existing.expiresAt(), expiresAt)
                && parsePayload(existing.payloadJson()).equals(attachments);
        if (!same) {
            throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                    "이 Idempotency-Key 는 이미 다른 내용으로 사용됐습니다. "
                            + "내용을 바꾸려면 새 Idempotency-Key 로 요청하세요");
        }
        return new SendResult(existing.id(), existing.audience(), existing.targetCount(),
                existing.expiresAt(), false);
    }

    // ── 회수 ──────────────────────────────────────────────────────────────

    /**
     * 오발송 수습 — <b>미수령분만</b> 막는다. 이미 수령한 건은 건드리지 않는다: 원장을 되감는 것은
     * 별개의(그리고 훨씬 위험한) 조작이고, 필요하면 {@code POST /api/admin/users/{id}/points} 로
     * 개별 처리한다. 우편함이 지갑을 되돌리는 두 번째 경로가 되면 "왜 줄었나"의 답이 두 곳이 된다.
     */
    public RevokeResult revoke(String actorUserId, String campaignId, String reason) {
        String safeReason = validText(reason, props.getReasonMaxChars(), "reason");
        Campaign c = campaignById(campaignId);
        if (c == null) {
            ApiException e = ApiException.notFound("발송 건을 찾을 수 없습니다");
            audit(actorUserId, ACTION_REVOKE, "failed", safeReason,
                    Map.of("campaignId", campaignId, "error", e.getMessage()));
            throw e;
        }
        String now = Notices.now(clock);
        return txRunner.run(() -> {
            // 이미 회수됐으면 시각을 덮지 않는다 — 최초 회수 시각이 이력이다(멱등).
            if (c.revokedAt() == null) {
                jdbcClient.sql("UPDATE mail_campaigns SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
                        .params(now, campaignId)
                        .update();
            }
            long unclaimed = countUnclaimed(campaignId);
            auditInTx(actorUserId, ACTION_REVOKE, "ok", safeReason, Map.of(
                    "campaignId", campaignId,
                    "unclaimed", unclaimed,
                    "alreadyRevoked", c.revokedAt() != null));
            return new RevokeResult(campaignId, c.revokedAt() == null ? now : c.revokedAt(), unclaimed);
        });
    }

    // ── 조회 ──────────────────────────────────────────────────────────────

    /** 발송 이력 — "보냈나 / 몇 명이 받았나"가 운영의 첫 질문이라 수령 통계를 같이 싣는다. */
    public List<CampaignView> list(int limit) {
        int capped = Math.max(1, Math.min(limit, 100));
        return jdbcClient.sql("""
                        SELECT c.id, c.audience, c.title, c.body, c.payload_json, c.expires_at,
                               c.revoked_at, c.target_count, c.reason, c.idem_key, c.created_at,
                               u.nickname AS actor,
                               (SELECT COUNT(*) FROM user_mails m WHERE m.campaign_id = c.id
                                  AND m.claimed_at IS NOT NULL) AS claimed_count,
                               (SELECT COUNT(*) FROM user_mails m WHERE m.campaign_id = c.id
                                  AND m.read_at IS NOT NULL) AS read_count
                        FROM mail_campaigns c JOIN users u ON u.id = c.created_by
                        ORDER BY c.created_at DESC, c.id DESC
                        LIMIT ?
                        """)
                .param(capped)
                .query((rs, rowNum) -> new CampaignView(
                        rs.getString("id"), rs.getString("audience"), rs.getString("title"),
                        rs.getString("body"), parsePayload(rs.getString("payload_json")),
                        rs.getString("expires_at"), rs.getString("revoked_at"),
                        rs.getInt("target_count"), rs.getInt("claimed_count"), rs.getInt("read_count"),
                        rs.getString("reason"), rs.getString("actor"), rs.getString("created_at")))
                .list();
    }

    public CampaignView detail(String campaignId) {
        return list(100).stream()
                .filter(c -> c.id().equals(campaignId))
                .findFirst()
                .orElseThrow(() -> ApiException.notFound("발송 건을 찾을 수 없습니다"));
    }

    public List<AuditEntry> history(int limit) {
        int capped = Math.max(1, Math.min(limit, 100));
        return jdbcClient.sql("""
                        SELECT a.id, a.action, a.result, a.reason, a.detail_json, a.created_at,
                               u.nickname AS actor
                        FROM admin_ops_audit a JOIN users u ON u.id = a.actor_user_id
                        WHERE a.action LIKE ? ESCAPE '\\'
                        ORDER BY a.created_at DESC, a.id DESC
                        LIMIT ?
                        """)
                .params(HISTORY_LIKE, capped)
                .query((rs, rowNum) -> new AuditEntry(
                        rs.getString("id"), rs.getString("actor"), rs.getString("action"),
                        rs.getString("result"), rs.getString("reason"), rs.getString("detail_json"),
                        rs.getString("created_at")))
                .list();
    }

    // ── 검증 ──────────────────────────────────────────────────────────────

    private String validAudience(String raw) {
        if (AUDIENCE_ALL.equals(raw) || AUDIENCE_USERS.equals(raw)) {
            return raw;
        }
        throw ApiException.validation("audience 는 ALL 또는 USERS 여야 합니다");
    }

    private String validText(String raw, int max, String field) {
        if (raw == null || raw.isBlank()) {
            throw ApiException.validation(field + " 은(는) 필수입니다");
        }
        String trimmed = raw.trim();
        if (trimmed.length() > max) {
            throw ApiException.validation(field + " 은(는) " + max + "자 이하여야 합니다");
        }
        return trimmed;
    }

    /**
     * 첨부 상한 검사. <b>0 첨부도 유효</b>하다(텍스트 전용 안내). 음수는 거절한다 — 우편함은 주는
     * 창구이지 빼앗는 창구가 아니다(차감이 필요하면 admin points 경로가 이미 있고, 거기엔 잔액
     * 하한·감사가 붙어 있다).
     */
    private MailAttachments validAttachments(MailAttachments raw) {
        MailAttachments att = MailAttachments.normalize(raw);
        if (att.points() < 0 || att.gems() < 0) {
            throw ApiException.validation("첨부 재화는 음수일 수 없습니다(차감은 admin points 경로)");
        }
        if (att.points() > props.getMaxPoints()) {
            throw ApiException.validation("첨부 G 가 상한(" + props.getMaxPoints() + ")을 넘습니다");
        }
        if (att.gems() > props.getMaxGems()) {
            throw ApiException.validation("첨부 Z 가 상한(" + props.getMaxGems() + ")을 넘습니다");
        }
        if (att.players().size() > props.getMaxPlayerKinds()) {
            throw ApiException.validation("첨부 카드 종류가 상한(" + props.getMaxPlayerKinds() + ")을 넘습니다");
        }
        for (MailAttachments.PlayerGrant p : att.players()) {
            if (p == null || p.playerId() == null || p.playerId().isBlank()) {
                throw ApiException.validation("첨부 카드의 playerId 가 비어 있습니다");
            }
            if (p.count() <= 0 || p.count() > props.getMaxPlayerCount()) {
                throw ApiException.validation("첨부 카드 장수는 1~" + props.getMaxPlayerCount() + " 여야 합니다");
            }
            Long exists = jdbcClient.sql("SELECT COUNT(*) FROM players WHERE id = ?")
                    .param(p.playerId())
                    .query(Long.class)
                    .single();
            if (exists == null || exists == 0) {
                // 발송 시점에 막는다 — 여기서 놓치면 수령 때 조용히 건너뛰어 "보냈는데 안 왔다"가 된다.
                throw ApiException.validation("카탈로그에 없는 카드입니다: " + p.playerId());
            }
        }
        return att;
    }

    /** {@code expiresAt}(절대) 또는 {@code expiresInDays}(상대) 중 하나. 둘 다 없으면 <b>무기한</b>(hero 확정 ③). */
    private String resolveExpiry(String expiresAt, Integer expiresInDays) {
        if (expiresAt != null && !expiresAt.isBlank() && expiresInDays != null) {
            throw ApiException.validation("expiresAt 과 expiresInDays 는 함께 쓸 수 없습니다");
        }
        if (expiresInDays != null) {
            if (expiresInDays <= 0) {
                throw ApiException.validation("expiresInDays 는 1 이상이어야 합니다");
            }
            return Instant.now(clock).plus(expiresInDays, ChronoUnit.DAYS)
                    .truncatedTo(ChronoUnit.SECONDS).toString();
        }
        String normalized = Notices.normalizeInstant(expiresAt, "expiresAt");
        if (normalized != null && normalized.compareTo(Notices.now(clock)) <= 0) {
            // 이미 지난 시각으로 보내면 아무도 못 받는 우편물이 전원에게 간다 = 확실한 오조작.
            throw ApiException.validation("expiresAt 이 이미 지난 시각입니다");
        }
        return normalized;
    }

    /**
     * 대상 확정. {@code ALL} = <b>발송 시점에 존재하는 유저 전원</b>(이후 가입자는 대상이 아니다 —
     * 패치 보상의 사유가 그 시점에 있던 사람에게만 성립한다).
     */
    private List<String> resolveTargets(String audience, List<String> userIds) {
        if (AUDIENCE_ALL.equals(audience)) {
            if (userIds != null && !userIds.isEmpty()) {
                throw ApiException.validation("audience=ALL 에는 userIds 를 함께 보낼 수 없습니다");
            }
            return jdbcClient.sql("SELECT id FROM users ORDER BY id")
                    .query(String.class)
                    .list();
        }
        if (userIds == null || userIds.isEmpty()) {
            throw ApiException.validation("audience=USERS 에는 userIds 가 필요합니다");
        }
        if (userIds.size() > props.getMaxUserIds()) {
            throw ApiException.validation("userIds 는 " + props.getMaxUserIds() + "명 이하여야 합니다");
        }
        // 중복은 조용히 접는다(같은 사람을 두 번 적은 것은 오타이지 "두 통 보내라"가 아니다 —
        // 그리고 uq_user_mails_user_campaign 가 어차피 거절한다).
        LinkedHashSet<String> unique = new LinkedHashSet<>(userIds);
        List<String> resolved = new ArrayList<>();
        for (String id : unique) {
            Long exists = jdbcClient.sql("SELECT COUNT(*) FROM users WHERE id = ?")
                    .param(id)
                    .query(Long.class)
                    .single();
            if (exists == null || exists == 0) {
                // 없는 유저를 건너뛰면 운영자는 "20명에게 보냈다"고 믿는데 19명이 받는다.
                throw ApiException.validation("유저를 찾을 수 없습니다: " + id);
            }
            resolved.add(id);
        }
        return resolved;
    }

    // ── 내부 ──────────────────────────────────────────────────────────────

    private long countUnclaimed(String campaignId) {
        Long n = jdbcClient.sql("SELECT COUNT(*) FROM user_mails WHERE campaign_id = ? AND claimed_at IS NULL")
                .param(campaignId)
                .query(Long.class)
                .single();
        return n == null ? 0 : n;
    }

    private Campaign campaignByIdem(String idemKey) {
        return jdbcClient.sql("""
                        SELECT id, audience, payload_json, expires_at, revoked_at, target_count
                        FROM mail_campaigns WHERE idem_key = ?
                        """)
                .param(idemKey)
                .query((rs, rowNum) -> new Campaign(rs.getString("id"), rs.getString("audience"),
                        rs.getString("payload_json"), rs.getString("expires_at"),
                        rs.getString("revoked_at"), rs.getInt("target_count")))
                .optional()
                .orElse(null);
    }

    private Campaign campaignById(String id) {
        return jdbcClient.sql("""
                        SELECT id, audience, payload_json, expires_at, revoked_at, target_count
                        FROM mail_campaigns WHERE id = ?
                        """)
                .param(id)
                .query((rs, rowNum) -> new Campaign(rs.getString("id"), rs.getString("audience"),
                        rs.getString("payload_json"), rs.getString("expires_at"),
                        rs.getString("revoked_at"), rs.getInt("target_count")))
                .optional()
                .orElse(null);
    }

    private String writePayload(MailAttachments att) {
        try {
            return objectMapper.writeValueAsString(att);
        } catch (Exception e) {
            throw new IllegalStateException("첨부 직렬화 실패", e);
        }
    }

    private MailAttachments parsePayload(String json) {
        try {
            return MailAttachments.normalize(objectMapper.readValue(json, MailAttachments.class));
        } catch (Exception e) {
            throw new IllegalStateException("첨부 역직렬화 실패: " + json, e);
        }
    }

    /** 실패 감사는 <b>실패한 트랜잭션 밖</b>에서 써야 남는다(같이 롤백되면 이력이 사라진다). */
    private void audit(String actorUserId, String action, String result, String reason,
                       Map<String, Object> detail) {
        txRunner.run(() -> {
            auditInTx(actorUserId, action, result, reason, detail);
            return null;
        });
    }

    private void auditInTx(String actorUserId, String action, String result, String reason,
                           Map<String, Object> detail) {
        String detailJson;
        try {
            detailJson = objectMapper.writeValueAsString(detail);
        } catch (Exception e) {
            detailJson = "{}";
        }
        jdbcClient.sql("""
                        INSERT INTO admin_ops_audit(id, actor_user_id, action, result, reason,
                                                    detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), actorUserId, action, result, reason, detailJson,
                        Notices.now(clock))
                .update();
    }

    private record Campaign(String id, String audience, String payloadJson, String expiresAt,
                            String revokedAt, int targetCount) {
    }

    // ── DTO ───────────────────────────────────────────────────────────────

    /**
     * @param expiresAt      절대 시각(둘 중 하나만)
     * @param expiresInDays  상대 일수(둘 중 하나만). 둘 다 없으면 무기한.
     */
    public record SendRequest(String audience, List<String> userIds, String title, String body,
                              MailAttachments attachments, String expiresAt, Integer expiresInDays,
                              String reason) {
    }

    /** @param applied false = 같은 멱등키의 재전송이라 아무것도 더 보내지 않았다. */
    public record SendResult(String campaignId, String audience, int targetCount, String expiresAt,
                             boolean applied) {
    }

    public record RevokeResult(String campaignId, String revokedAt, long unclaimed) {
    }

    public record CampaignView(String id, String audience, String title, String body,
                               MailAttachments attachments, String expiresAt, String revokedAt,
                               int targetCount, int claimedCount, int readCount, String reason,
                               String actor, String createdAt) {
    }

    public record AuditEntry(String id, String actor, String action, String result, String reason,
                             String detailJson, String createdAt) {
    }
}
