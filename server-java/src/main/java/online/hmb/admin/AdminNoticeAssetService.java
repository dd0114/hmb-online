package online.hmb.admin;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.notice.NoticeAssetStorage;
import online.hmb.notice.NoticeAssetTypes;
import online.hmb.notice.Notices;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

/**
 * 공지 이미지 <b>업로드·목록·노출 스위치</b> (#309 W1). 설계 = {@code docs/plan-v5/ops-content.md}.
 *
 * <p><b>이 웨이브가 끊는 배포 의존</b>: 공지에 그림 한 장을 넣으려면 {@code apps/web/public/notice/}
 * 에 파일을 커밋하고 <b>웹을 다시 배포</b>해야 했다. 공지 텍스트는 이미 무배포(#248)인데
 * 그림만 배포에 묶여 있어, 실제 운영에서는 "이미지 있는 공지 = 배포 이벤트"였다.
 *
 * <p><b>공지(#248)와 같은 것</b>: admin 게이트 · 사유 · 성공·실패 모두 {@code admin_ops_audit} 기록 ·
 * DB 가 SoT 라 쓰면 곧 반영(리로드 없음).
 * <b>다른 것</b>: 값이 아니라 <b>바이트</b>를 다룬다 — 그래서 검증이 "형태가 맞나"가 아니라
 * <b>"이게 정말 이미지인가"</b>이고, 실패 시 <b>파일까지</b> 되돌려야 한다.
 *
 * <p><b>삭제가 없다</b>(hero 확정 2026-07-30 — "삭제 없애. 비활성화하면 되잖아"). 자산을 내리는
 * 행위는 되돌릴 수 있어야 한다: 삭제는 오조작이 곧 영구 소실이고, 그 그림을 참조하던 공지를
 * 되살릴 방법이 없다. {@code active=0} 이면 서빙이 404 이고 다시 켜면 같은 바이트가 돌아온다.
 */
@Service
public class AdminNoticeAssetService {

    /** 원장 액션. {@code notice_} 접두사라 <b>기존 공지 이력 조회에 그대로 섞여 나온다</b>. */
    public static final String ACTION_UPLOAD = "notice_asset_upload";
    public static final String ACTION_ACTIVE = "notice_asset_active";

    private static final int REASON_MAX_CHARS = 500;
    /** 표시용 원본 이름 상한. 경로에 쓰지 않으므로 길이만 자른다. */
    private static final int NAME_MAX_CHARS = 200;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final NoticeAssetStorage storage;
    private final Clock clock;

    public AdminNoticeAssetService(JdbcClient jdbcClient, TxRunner txRunner, ObjectMapper objectMapper,
                                   NoticeAssetStorage storage, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.storage = storage;
        this.clock = clock;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /**
     * 전체 목록(노출 OFF 포함) + <b>{@code usedBy}</b> = 그 자산을 본문에서 참조하는
     * <b>살아 있는 공지 수</b>.
     *
     * <p>이 숫자가 목록에 있는 이유는 장식이 아니다 — 운영자가 노출을 끄기 전에 <b>무슨 일이
     * 벌어지는지</b> 알아야 한다("공지 2건이 이 이미지를 씁니다"). 없으면 조용히 남의 공지 그림을
     * 지우게 된다. 세는 대상에서 <b>삭제된 공지는 뺀다</b>(이미 안 보이는 것을 근거로 겁주지 않는다).
     */
    public List<AssetView> list() {
        return jdbcClient.sql("""
                        SELECT a.id, a.original_name, a.content_type, a.byte_size, a.active,
                               a.created_by, a.created_at, a.updated_at,
                               (SELECT COUNT(*) FROM notices n
                                 WHERE n.deleted_at IS NULL
                                   AND n.body LIKE '%' || a.id || '%') AS used_by
                        FROM notice_assets a
                        ORDER BY a.created_at DESC, a.id DESC
                        """)
                .query((rs, rowNum) -> new AssetView(
                        rs.getString("id"),
                        url(rs.getString("id")),
                        rs.getString("original_name"),
                        rs.getString("content_type"),
                        rs.getLong("byte_size"),
                        rs.getInt("active") != 0,
                        rs.getInt("used_by"),
                        rs.getString("created_by"),
                        rs.getString("created_at"),
                        rs.getString("updated_at")))
                .list();
    }

    // ── 운영 액션 ─────────────────────────────────────────────────────────

    /**
     * 업로드. 검증 순서가 계약이다: <b>크기 → 매직바이트 → 저장 → DB</b>.
     *
     * <p>크기를 먼저 보는 이유는 큰 파일을 다 읽고 나서 거절하지 않기 위해서다. 타입을
     * <b>매직바이트로</b> 보는 이유는 파일명 확장자도 클라 {@code Content-Type} 도 업로드하는 쪽이
     * 정하는 값이기 때문이다({@link NoticeAssetTypes}).
     *
     * <p><b>실패는 부수효과가 0이어야 한다</b> — 파일을 쓴 뒤 DB 가 실패하면 파일을 되돌린다.
     * 남겨 두면 아무도 참조하지 않는 바이트가 볼륨에 쌓이고, 목록에 안 뜨니 회수 경로도 없다.
     */
    public AssetView upload(String actorUserId, MultipartFile file, String reason) {
        String originalName = file == null ? null : file.getOriginalFilename();
        try {
            validateReason(reason);
            if (file == null || file.isEmpty()) {
                throw ApiException.validation("업로드할 파일이 없습니다");
            }
            if (file.getSize() > storage.maxBytes()) {
                throw ApiException.validation("이미지가 너무 큽니다(" + file.getSize() + " 바이트, 상한 "
                        + storage.maxBytes() + " 바이트)");
            }
            byte[] bytes = read(file);
            // getSize() 를 믿지 않고 실제 바이트로 한 번 더 — 상한은 볼륨 보호라 신고값으로 재면 안 된다.
            if (bytes.length > storage.maxBytes()) {
                throw ApiException.validation("이미지가 너무 큽니다(" + bytes.length + " 바이트, 상한 "
                        + storage.maxBytes() + " 바이트)");
            }
            NoticeAssetTypes.ImageType type = NoticeAssetTypes.detect(bytes);
            if (type == null) {
                // ⚠️ 문구에 "확장자를 바꾸세요"를 적지 마라 — 판정이 확장자가 아니라는 게 요점이다.
                throw ApiException.validation("지원하지 않는 이미지 형식입니다. 허용: "
                        + NoticeAssetTypes.ALLOWED_LABEL + " (SVG 는 보안상 허용하지 않습니다)");
            }

            String id = Ulid.next();
            String storedName = id + "." + type.extension();
            String now = Notices.now(clock);
            storage.write(storedName, bytes);
            try {
                txRunner.run(() -> jdbcClient.sql("""
                                INSERT INTO notice_assets(id, stored_name, original_name, content_type,
                                                          byte_size, sha256, active, created_by,
                                                          created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?)
                                """)
                        .params(id, storedName, trimName(originalName), type.contentType(),
                                (long) bytes.length, sha256(bytes), actorUserId, now, now)
                        .update());
            } catch (RuntimeException e) {
                storage.removeQuietly(storedName);
                throw e;
            }

            AssetView view = new AssetView(id, url(id), trimName(originalName), type.contentType(),
                    bytes.length, true, 0, actorUserId, now, now);
            audit(actorUserId, ACTION_UPLOAD, "ok", reason, detail(id, null, view, null, null));
            return view;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_UPLOAD, "error", reason,
                    detail(null, null, null, Map.of("originalName", String.valueOf(originalName)), e));
            throw rethrow(e);
        }
    }

    /**
     * 노출 ON/OFF. <b>이것이 "내리기"의 전부다</b> — 삭제 경로는 만들지 않는다(D9).
     * 끄면 공개 서빙이 404 이고, 켜면 같은 바이트가 그대로 돌아온다.
     */
    public AssetView setActive(String actorUserId, String id, ActiveRequest req) {
        String reason = req == null ? null : req.reason();
        AssetView before = find(id).orElse(null);
        try {
            validateReason(reason);
            if (req == null || req.active() == null) {
                throw ApiException.validation("active 는 true 또는 false 여야 합니다");
            }
            if (before == null) {
                throw ApiException.notFound("이미지를 찾을 수 없습니다: " + id);
            }
            boolean active = req.active();
            String now = Notices.now(clock);
            txRunner.run(() -> jdbcClient.sql("UPDATE notice_assets SET active = ?, updated_at = ? WHERE id = ?")
                    .params(active ? 1 : 0, now, id)
                    .update());

            AssetView after = find(id).orElseThrow(() -> ApiException.notFound("이미지를 찾을 수 없습니다: " + id));
            audit(actorUserId, ACTION_ACTIVE, "ok", reason, detail(id, before, after, null, null));
            return after;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_ACTIVE, "error", reason,
                    detail(id, before, null, Map.of("active", String.valueOf(req == null ? null : req.active())), e));
            throw rethrow(e);
        }
    }

    // ── 내부 ─────────────────────────────────────────────────────────────

    /**
     * 본문에 붙일 값 = <b>상대경로</b>. 절대 URL 을 돌려주면 운영자가 그걸 본문에 붙여넣고,
     * 백엔드가 quick tunnel 뒤라 <b>주소가 바뀌는 순간 과거 공지 이미지가 전부 깨진다</b>
     * (실적: deploy-log 2026-07-22·07-25). 복구 경로가 본문 일괄 수정뿐이라 되돌리기가 비싸다.
     * 상대경로면 web 이 렌더 시점에 현재 오리진을 붙이므로 자가복구(#183)를 그냥 따라간다.
     */
    private static String url(String id) {
        return "/api/notices/assets/" + id;
    }

    private java.util.Optional<AssetView> find(String id) {
        return list().stream().filter(a -> a.id().equals(id)).findFirst();
    }

    private static byte[] read(MultipartFile file) {
        try {
            return file.getBytes();
        } catch (IOException e) {
            throw ApiException.validation("업로드 파일을 읽지 못했습니다: " + e.getMessage());
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e); // JDK 표준 알고리즘 — 없으면 환경이 깨진 것이다
        }
    }

    private static String trimName(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String trimmed = raw.trim();
        return trimmed.length() <= NAME_MAX_CHARS ? trimmed : trimmed.substring(0, NAME_MAX_CHARS);
    }

    private static void validateReason(String reason) {
        if (reason != null && reason.length() > REASON_MAX_CHARS) {
            throw ApiException.validation("reason 은 " + REASON_MAX_CHARS + "자 이하여야 합니다");
        }
    }

    private Map<String, Object> detail(String assetId, AssetView before, AssetView after,
                                       Object attempted, RuntimeException error) {
        Map<String, Object> detail = new LinkedHashMap<>();
        if (assetId != null) {
            detail.put("assetId", assetId);
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

    private RuntimeException rethrow(RuntimeException e) {
        return e instanceof ApiException api ? api : ApiException.validation(String.valueOf(e.getMessage()));
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    /**
     * 운영 화면이 보는 자산 한 건. {@code url} 은 상대경로이고(위 참조), {@code usedBy} 는
     * 노출을 끄기 전에 운영자가 알아야 하는 숫자다.
     */
    public record AssetView(String id, String url, String originalName, String contentType,
                            long byteSize, boolean active, int usedBy, String createdBy,
                            String createdAt, String updatedAt) {
    }

    public record ActiveRequest(Boolean active, String reason) {
    }
}
