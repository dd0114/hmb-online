package online.hmb.admin;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.notice.Notices;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 공지 운영(#248 §2.2) — admin CRUD + <b>성공·실패 모두</b> 남는 감사 원장.
 *
 * <p><b>economy 무배포 운영(#209 B안)과 같은 것</b>: admin 게이트 뒤 · 사유 필수 ·
 * {@code admin_ops_audit}(V18)에 {@code {before, after}} 스냅샷 · 재배포 0.
 * <b>다른 것</b>: economy 는 값이 배포 발행물의 파생이라 "override 파일 → reload" 2단계가 필요했다.
 * 공지는 발행물이 없다 — 운영자가 만드는 데이터 그 자체라 <b>DB 가 SoT</b>이고 쓰면 곧 다음 조회에
 * 반영된다(리로드 엔드포인트가 아예 없다 = 누를 게 없으니 안 눌러서 생기는 사고도 없다).
 *
 * <p><b>이 클래스의 진짜 규칙은 {@code revision} 하나다.</b> 클라의 24시간 억제 키가
 * {@code id@revision} 이라:
 * <ul>
 *   <li>내용 무관 변경(노출 토글·우선순위·기간)에 범프하면 → <b>전원에게 팝업이 다시 뜬다</b>.</li>
 *   <li>내용 변경에 범프하지 않으면 → <b>오탈자 수정본이 억제된 유저에게 영원히 안 보인다</b>.</li>
 * </ul>
 * 그래서 <b>제목 또는 본문이 실제로 바뀔 때만</b> +1 한다({@code updated_at} 을 키로 쓰지 않는 이유).
 * 계약 = {@code AdminNoticeOpsTest.revisionBumpsOnlyWhenTitleOrBodyActuallyChanges}(양방향 변이체 킬).
 */
@Service
public class AdminNoticeService {

    public static final String ACTION_CREATE = "notice_create";
    public static final String ACTION_UPDATE = "notice_update";
    public static final String ACTION_ACTIVE = "notice_active";
    public static final String ACTION_DELETE = "notice_delete";

    /**
     * 원장 조회에서 공지 액션만 걸러내는 패턴 — <b>액션 이름이 곧 필터다</b>(액션을 추가해도
     * 이력 조회에 등록할 곳이 없다). {@code _} 는 LIKE 의 단일문자 와일드카드라 escape 한다 —
     * 안 하면 {@code noticeXcreate} 같은 남의 액션까지 공지 이력에 섞인다.
     */
    private static final String HISTORY_LIKE = "notice\\_%";

    private static final int REASON_MAX_CHARS = 500;
    private static final int TITLE_MAX_CHARS = 100;
    private static final int BODY_MAX_CHARS = 2000;
    /**
     * 우선순위 범위. 정렬 키일 뿐이라 큰 값이 의미를 더하지 않는데, 열어 두면 운영 실수
     * ({@code 99999999999})가 오버플로로 조용히 뒤집힌다. 실질적으로 필요한 폭보다 넉넉하다.
     */
    private static final int PRIORITY_MIN = -1000;
    private static final int PRIORITY_MAX = 1000;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final Clock clock;

    public AdminNoticeService(JdbcClient jdbcClient, TxRunner txRunner, ObjectMapper objectMapper, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.clock = clock;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /**
     * 전체 목록(중지·만료·삭제 포함) + <b>서버가 판정한 상태</b>.
     *
     * <p>상태를 화면이 다시 계산하지 않게 하는 게 요점이다 — 같은 데이터에 두 개의 진실이 생기면
     * 유저 피드와 운영 화면이 조용히 갈라진다. 삭제된 공지는 목록 맨 뒤로 민다(이력은 남기되
     * 일상 운영을 가리지 않게).
     */
    public List<NoticeAdminView> list() {
        String now = Notices.now(clock);
        return jdbcClient.sql("""
                        SELECT id, revision, title, body, starts_at, ends_at, active, priority,
                               deleted_at, created_by, created_at, updated_at
                        FROM notices
                        ORDER BY (deleted_at IS NULL) DESC, priority DESC, created_at DESC, id DESC
                        """)
                .query((rs, rowNum) -> view(rs.getString("id"), rs.getInt("revision"), rs.getString("title"),
                        rs.getString("body"), rs.getString("starts_at"), rs.getString("ends_at"),
                        rs.getInt("active") != 0, rs.getInt("priority"), rs.getString("deleted_at"),
                        rs.getString("created_by"), rs.getString("created_at"), rs.getString("updated_at"), now))
                .list();
    }

    /** 공지 운영 이력(감사 원장) — 성공·실패 모두. economy 이력과 같은 테이블·같은 모양이다. */
    public List<AdminEconomyService.AuditEntry> history(int limit) {
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
                .query((rs, rowNum) -> new AdminEconomyService.AuditEntry(
                        rs.getString("id"),
                        rs.getString("actor"),
                        rs.getString("action"),
                        rs.getString("result"),
                        rs.getString("reason"),
                        rs.getString("detail_json"),
                        rs.getString("created_at")))
                .list();
    }

    // ── 운영 액션 ─────────────────────────────────────────────────────────

    public NoticeAdminView create(String actorUserId, UpsertRequest req) {
        String reason = req == null ? null : req.reason();
        try {
            requireBody(req);
            String title = validTitle(req.title());
            String body = validBody(req.body());
            String startsAt = Notices.normalizeInstant(req.startsAt(), "startsAt");
            String endsAt = Notices.normalizeInstant(req.endsAt(), "endsAt");
            validWindow(startsAt, endsAt);
            int priority = validPriority(req.priority());
            validateReason(reason);

            String now = Notices.now(clock);
            String id = Ulid.next();
            txRunner.run(() -> jdbcClient.sql("""
                            INSERT INTO notices(id, title, body, starts_at, ends_at, active, priority,
                                                revision, deleted_at, created_by, created_at, updated_at)
                            VALUES (?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?, ?)
                            """)
                    .params(id, title, body, startsAt, endsAt, activeFlag(req.active()), priority,
                            actorUserId, now, now)
                    .update());

            NoticeAdminView after = require(id);
            audit(actorUserId, ACTION_CREATE, "ok", reason, detail(null, null, after, null, null));
            return after;
        } catch (RuntimeException e) {
            // 생성 실패는 대상 행이 아직 없다 — 그래서 **요청 원문(attempted)** 이 유일한 복원 단서다.
            audit(actorUserId, ACTION_CREATE, "failed", reason, detail(null, null, null, req, e));
            throw rethrow(e, "공지 생성에 실패했습니다: ");
        }
    }

    /**
     * 수정 = 내용 필드 <b>전체 치환</b>(운영 화면이 폼 전체를 보낸다). {@code startsAt}/{@code endsAt}/
     * {@code priority} 를 안 보내면 "제한 없음"·기본값으로 <b>지워진다</b> — 부분 패치로 해석하면
     * 기간을 없애는 방법이 사라진다. 계약 = {@code updateIsAFullReplaceNotAPatch}(놀라운 쪽을 박제한다).
     *
     * <p>노출 스위치는 여기서 <b>못 바꾸고, 보내면 400</b>이다({@code POST /{id}/active} 전용).
     * 전체 치환인데 한 필드만 조용히 무시하는 것이 가장 나쁜 비대칭이다 — 운영자는 200 을 받고
     * "내렸다"고 믿는데 공지는 계속 떠 있다(독립검증 MAJ-1 실측).
     */
    public NoticeAdminView update(String actorUserId, String id, UpsertRequest req) {
        String reason = req == null ? null : req.reason();
        NoticeAdminView before = null;
        try {
            // ★ 대상을 **검증보다 먼저** 읽는다(독립검증 B2). 검증이 뒤에 있으면 거절된 시도의 원장에
            //   before 도 대상 id 도 남지 않아, 공지 셋을 연달아 손보다 하나가 튕겼을 때 "어느 공지에
            //   무엇을 넣으려 했나"를 복원할 수 없다 — AC §2.2 가 막으려던 상황 그대로다.
            before = requireLive(id);
            requireBody(req);
            requireNoActiveInBody(req.active());
            String title = validTitle(req.title());
            String body = validBody(req.body());
            String startsAt = Notices.normalizeInstant(req.startsAt(), "startsAt");
            String endsAt = Notices.normalizeInstant(req.endsAt(), "endsAt");
            validWindow(startsAt, endsAt);
            int priority = validPriority(req.priority());
            validateReason(reason);

            // ★ 여기가 규칙의 전부 — 내용이 실제로 달라졌을 때만 억제 키가 바뀐다.
            boolean contentChanged = !title.equals(before.title()) || !body.equals(before.body());
            int expected = before.revision();
            int revision = expected + (contentChanged ? 1 : 0);

            String now = Notices.now(clock);
            // CAS — 읽은 revision 위에서만 쓴다(모듈 규율 "상태 전이는 CAS"). 두 운영자가 같은 공지를
            // 동시에 고치면 나중 쓰기가 앞 revision 을 덮어써 억제 키가 되돌아간다(= 고친 내용이
            // 억제된 유저에게 안 보인다). 진 쪽은 409 를 받고 다시 읽는다.
            int rows = txRunner.run(() -> jdbcClient.sql("""
                            UPDATE notices
                            SET title = ?, body = ?, starts_at = ?, ends_at = ?, priority = ?,
                                revision = ?, updated_at = ?
                            WHERE id = ? AND revision = ? AND deleted_at IS NULL
                            """)
                    .params(title, body, startsAt, endsAt, priority, revision, now, id, expected)
                    .update());
            requireApplied(rows);

            NoticeAdminView after = require(id);
            audit(actorUserId, ACTION_UPDATE, "ok", reason, detail(id, before, after, null, null));
            return after;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_UPDATE, "failed", reason, detail(id, before, null, req, e));
            throw rethrow(e, "공지 수정에 실패했습니다: ");
        }
    }

    /**
     * 노출 ON/OFF. <b>기간을 건드리지 않는다</b> — 급히 내릴 때 {@code endsAt} 을 과거로 조작하게
     * 만들면 원장이 거짓말을 한다("이 공지는 그때 끝난 걸로 되어 있는데 실은 사고로 내린 것"). 그리고
     * 내용이 그대로이므로 {@code revision} 도 오르지 않는다(다시 올렸을 때 전원 재표시가 되지 않는다).
     */
    public NoticeAdminView setActive(String actorUserId, String id, ActiveRequest req) {
        String reason = req == null ? null : req.reason();
        NoticeAdminView before = null;
        try {
            before = requireLive(id);   // 대상 먼저(B2) — 실패 원장에도 어느 공지였는지 남는다.
            if (req == null || req.active() == null) {
                throw ApiException.validation("active 는 필수입니다(true/false)");
            }
            validateReason(reason);

            boolean active = req.active();
            String now = Notices.now(clock);
            int rows = txRunner.run(() -> jdbcClient
                    .sql("UPDATE notices SET active = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
                    .params(active ? 1 : 0, now, id)
                    .update());
            requireApplied(rows);

            NoticeAdminView after = require(id);
            audit(actorUserId, ACTION_ACTIVE, "ok", reason, detail(id, before, after, null, null));
            return after;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_ACTIVE, "failed", reason, detail(id, before, null, req, e));
            throw rethrow(e, "공지 노출 변경에 실패했습니다: ");
        }
    }

    /**
     * <b>soft delete 만</b>(hero 컨펌 Q6). hard delete 를 두지 않는 이유: 감사 원장이 참조하는
     * 대상이 사라지면 "무슨 공지를 왜 내렸나"를 이력으로 복원할 수 없다. 목록에서 안 보이면
     * 운영상 삭제와 동등하다.
     */
    public NoticeAdminView delete(String actorUserId, String id, String reason) {
        NoticeAdminView before = null;
        try {
            before = requireLive(id);   // 대상 먼저(B2).
            validateReason(reason);

            String now = Notices.now(clock);
            int rows = txRunner.run(() -> jdbcClient
                    .sql("UPDATE notices SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
                    .params(now, now, id)
                    .update());
            requireApplied(rows);

            NoticeAdminView after = require(id);
            audit(actorUserId, ACTION_DELETE, "ok", reason, detail(id, before, after, null, null));
            return after;
        } catch (RuntimeException e) {
            // 삭제는 요청 페이로드가 사유뿐이라 attempted 를 따로 싣지 않는다(reason 이 이미 컬럼이다).
            audit(actorUserId, ACTION_DELETE, "failed", reason, detail(id, before, null, null, e));
            throw rethrow(e, "공지 삭제에 실패했습니다: ");
        }
    }

    // ── 검증 ────────────────────────────────────────────────────────────

    private void requireBody(UpsertRequest req) {
        if (req == null) {
            throw ApiException.validation("요청 바디가 비어 있습니다");
        }
    }

    /**
     * 수정 바디에 {@code active} 가 실리면 <b>거부</b>한다(독립검증 MAJ-1). 조용히 무시하면
     * 운영자가 200 을 받고 "내렸다"고 믿는데 공지는 계속 떠 있다 — 전체 치환 규약에서 한 필드만
     * 무시하는 비대칭은 그 자체가 사고다. 되돌릴 곳을 명시해 막다른 길을 만들지 않는다.
     */
    private void requireNoActiveInBody(Boolean active) {
        if (active != null) {
            throw ApiException.validation(
                    "active 는 수정으로 바꿀 수 없습니다 — POST /api/admin/notices/{id}/active 를 쓰세요");
        }
    }

    /**
     * 쓰기가 실제로 한 행에 적용됐는지. CAS/조건부 UPDATE 가 0행이면 <b>그 사이에 상태가 바뀐 것</b>
     * (다른 운영자가 먼저 고쳤거나 삭제했다)이라 200 을 주면 거짓말이 된다.
     */
    private void requireApplied(int rows) {
        if (rows != 1) {
            throw new ApiException(org.springframework.http.HttpStatus.CONFLICT, "CONFLICT",
                    "다른 운영자가 방금 이 공지를 변경했습니다 — 목록을 새로고침한 뒤 다시 시도하세요");
        }
    }

    private void validateReason(String reason) {
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("reason 은 필수입니다(운영 사유 기록)");
        }
        if (reason.length() > REASON_MAX_CHARS) {
            throw ApiException.validation("reason 은 " + REASON_MAX_CHARS + "자 이하여야 합니다");
        }
    }

    private String validTitle(String raw) {
        String title = raw == null ? "" : raw.strip();
        if (title.isEmpty()) {
            throw ApiException.validation("title 은 필수입니다");
        }
        if (title.length() > TITLE_MAX_CHARS) {
            throw ApiException.validation("title 은 " + TITLE_MAX_CHARS + "자 이하여야 합니다");
        }
        return title;
    }

    private String validBody(String raw) {
        // strip() 은 앞뒤 공백만 없앤다 — 본문 안의 줄바꿈은 그대로 살아야 한다(팝업이 pre-wrap 으로 그린다).
        String body = raw == null ? "" : raw.strip();
        if (body.isEmpty()) {
            throw ApiException.validation("body 는 필수입니다");
        }
        if (body.length() > BODY_MAX_CHARS) {
            throw ApiException.validation("body 는 " + BODY_MAX_CHARS + "자 이하여야 합니다");
        }
        return body;
    }

    /**
     * 기간 역전 거부. 시작 &gt; 종료면 그 공지는 <b>절대로 보이지 않는데</b> 목록에서는 "예약됨"처럼
     * 보인다 — 운영자가 오타를 알아챌 방법이 없으므로 저장 시점에 막는다.
     */
    private void validWindow(String startsAt, String endsAt) {
        if (startsAt != null && endsAt != null && startsAt.compareTo(endsAt) >= 0) {
            throw ApiException.validation("startsAt 은 endsAt 보다 앞서야 합니다");
        }
    }

    private int validPriority(Integer priority) {
        int value = priority == null ? 0 : priority;
        if (value < PRIORITY_MIN || value > PRIORITY_MAX) {
            throw ApiException.validation(
                    "priority 는 " + PRIORITY_MIN + " ~ " + PRIORITY_MAX + " 사이여야 합니다: " + value);
        }
        return value;
    }

    /** 생성 시 노출 여부 — 지정이 없으면 켜서 만든다(공지를 만드는 의도는 보이게 하는 것이다). */
    private int activeFlag(Boolean active) {
        return active == null || active ? 1 : 0;
    }

    // ── 조회 헬퍼 ────────────────────────────────────────────────────────

    private NoticeAdminView require(String id) {
        return find(id).orElseThrow(() -> ApiException.notFound("공지를 찾을 수 없습니다: " + id));
    }

    /**
     * 삭제된 공지는 <b>없는 것으로 취급</b>한다(404). 복구 기능이 없는 상태에서 삭제된 행을
     * 수정·토글할 수 있게 두면 "삭제했는데 유저에게 떴다"가 가능해진다.
     */
    private NoticeAdminView requireLive(String id) {
        NoticeAdminView row = require(id);
        if (row.deletedAt() != null) {
            throw ApiException.notFound("이미 삭제된 공지입니다: " + id);
        }
        return row;
    }

    private java.util.Optional<NoticeAdminView> find(String id) {
        String now = Notices.now(clock);
        return jdbcClient.sql("""
                        SELECT id, revision, title, body, starts_at, ends_at, active, priority,
                               deleted_at, created_by, created_at, updated_at
                        FROM notices WHERE id = ?
                        """)
                .param(id)
                .query((rs, rowNum) -> view(rs.getString("id"), rs.getInt("revision"), rs.getString("title"),
                        rs.getString("body"), rs.getString("starts_at"), rs.getString("ends_at"),
                        rs.getInt("active") != 0, rs.getInt("priority"), rs.getString("deleted_at"),
                        rs.getString("created_by"), rs.getString("created_at"), rs.getString("updated_at"), now))
                .optional();
    }

    private static NoticeAdminView view(String id, int revision, String title, String body,
                                        String startsAt, String endsAt, boolean active, int priority,
                                        String deletedAt, String createdBy, String createdAt,
                                        String updatedAt, String now) {
        return new NoticeAdminView(id, revision, title, body, startsAt, endsAt, priority, active,
                Notices.status(active, deletedAt, startsAt, endsAt, now).name(),
                deletedAt, createdBy, createdAt, updatedAt);
    }

    // ── 감사 ────────────────────────────────────────────────────────────

    /**
     * 원장에 실리는 스냅샷. 성공은 {@code {noticeId, before, after}}, 실패는
     * {@code {noticeId, before, attempted, error}} 다 — {@code AdminEconomyService} 의
     * {@code before/attempted/error} 모양(#209 BL-1 의 산물)을 그대로 따른다.
     *
     * <p><b>{@code noticeId} 를 따로 싣는 이유</b>(독립검증 B2): 대상이 없거나 검증에서 튕긴
     * 실패 행은 {@code before} 가 null 이라, id 를 안 실으면 원장 어디에도 대상이 남지 않는다.
     * {@code Map.of} 는 null 값을 못 담으므로 {@code LinkedHashMap} 이다.
     */
    private Map<String, Object> detail(String noticeId, NoticeAdminView before, NoticeAdminView after,
                                       Object attempted, RuntimeException error) {
        Map<String, Object> detail = new LinkedHashMap<>();
        if (noticeId != null) {
            detail.put("noticeId", noticeId);
        }
        detail.put("before", before);
        if (after != null || error == null) {
            detail.put("after", after);
        }
        if (attempted != null) {
            detail.put("attempted", attempted);
        }
        if (error != null) {
            detail.put("error", String.valueOf(error.getMessage()));
        }
        return detail;
    }

    private void audit(String actorUserId, String action, String result, String reason, Map<String, Object> detail) {
        String detailJson;
        try {
            detailJson = objectMapper.writeValueAsString(detail);
        } catch (IOException e) {
            detailJson = "{\"error\":\"detail 직렬화 실패\"}";
        }
        jdbcClient.sql("""
                        INSERT INTO admin_ops_audit(id, actor_user_id, action, result, reason, detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), actorUserId, action, result, reason, detailJson, Notices.now(clock))
                .update();
    }

    /** 검증에서 걸린 것이면 그 메시지가 이미 운영자에게 필요한 전부다(이중 포장하지 않는다). */
    private RuntimeException rethrow(RuntimeException e, String prefix) {
        return e instanceof ApiException api ? api : ApiException.validation(prefix + e.getMessage());
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    /**
     * 운영 화면이 보는 한 건. {@code status} 는 <b>서버가 판정한</b> 값이다
     * ({@code LIVE|SCHEDULED|OFF|EXPIRED|DELETED}) — 화면이 기간을 다시 계산하지 않게.
     */
    public record NoticeAdminView(String id, int revision, String title, String body,
                                  String startsAt, String endsAt, int priority, boolean active,
                                  String status, String deletedAt, String createdBy,
                                  String createdAt, String updatedAt) {
    }

    /**
     * 생성·수정 공통 바디. {@code active} 는 <b>생성에서만</b> 유효하다 — 수정에 실으면 400 이다
     * (조용히 무시하지 않는다, MAJ-1). 필드를 공유하는 이유는 운영 폼이 하나이기 때문이고,
     * 두 record 로 쪼개면 {@code FAIL_ON_UNKNOWN_PROPERTIES=false} 라 {@code active} 가 오히려
     * <b>조용히</b> 사라진다(= 고치려던 바로 그 실패 모드).
     */
    public record UpsertRequest(String title, String body, String startsAt, String endsAt,
                                Integer priority, Boolean active, String reason) {
    }

    public record ActiveRequest(Boolean active, String reason) {
    }
}
