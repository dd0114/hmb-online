package online.hmb.admin;

import com.fasterxml.jackson.databind.ObjectMapper;
import java.io.IOException;
import java.nio.file.Files;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.chars.CharBundleService;
import online.hmb.chars.CharBundleStorage;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.notice.Notices;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;
import org.springframework.web.multipart.MultipartFile;

/**
 * 유닛 아트 <b>핫로드</b> 운영 (#309 W2) — 번들 업로드 · 리비전 목록 · 활성 전환.
 * 설계 = {@code docs/plan-v5/ops-content.md} §7.
 *
 * <p><b>이 웨이브가 끊는 배포 의존</b>: 유닛 <b>등록</b>은 이미 무배포였다(#207 파트 A —
 * {@code POST /api/admin/units} 가 {@code players} 에 직접 쓰고 {@code admin_locked} 로 시드
 * 재임포트를 막는다). 그런데 등록해도 <b>아트가 없으면 이니셜 폴백</b>으로 뜬다. 아트는 셋이
 * 웹 빌드에 구워져 있었다: 아틀라스·카드 PNG / 매니페스트 3종 / player-chars 매핑.
 *
 * <p><b>왜 통짜 zip 인가</b>: 셋은 서로를 참조한다(매니페스트가 아틀라스 타일 좌표를, 매핑이
 * 유닛 id 를 가리킨다). 파일 단위로 올리면 "매니페스트는 새것, PNG 는 옛것"인 중간 상태가 실제로
 * 존재하고, 그때 화면은 <b>깨진 그림이 아니라 좌표가 어긋난 그림</b>을 그린다 — 아무도 못 알아챈다.
 *
 * <p><b>파이프라인은 그대로 로컬이다</b>(이슈 명시 요구): 합성·아틀라스 로직을 서버로 옮기는 건
 * 재발명이다(#57). 서버는 <b>산출물을 보관·서빙</b>만 한다.
 *
 * <p><b>롤백이 기능이다</b>: 리비전을 쌓고 활성 포인터만 옮긴다. 전부 끄면 web 이 웹 빌드에 구운
 * 폴백으로 돌아간다 = 아트 배포 이전 상태. 삭제 동사는 없다(W1 D9 와 같은 철학).
 */
@Service
public class AdminCharBundleService {

    public static final String ACTION_UPLOAD = "chars_bundle_upload";
    public static final String ACTION_ACTIVATE = "chars_bundle_activate";

    /** 원장 조회 필터. {@code _} 는 LIKE 단일문자 와일드카드라 escape 한다(공지 이력과 같은 함정). */
    private static final String HISTORY_LIKE = "chars\\_%";

    private static final int REASON_MAX_CHARS = 500;
    private static final int NOTE_MAX_CHARS = 500;

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final CharBundleStorage storage;
    private final CharBundleService bundles;
    private final Clock clock;

    public AdminCharBundleService(JdbcClient jdbcClient, TxRunner txRunner, ObjectMapper objectMapper,
                                  CharBundleStorage storage, CharBundleService bundles, Clock clock) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.storage = storage;
        this.bundles = bundles;
        this.clock = clock;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /** 리비전 목록(최신 우선). 활성 표시 포함 — 롤백 대상을 고르는 화면의 입력이다. */
    public List<BundleView> list() {
        return jdbcClient.sql("""
                        SELECT id, file_count, byte_size, manifest_summary, note, active,
                               created_by, created_at, updated_at
                        FROM char_bundles ORDER BY created_at DESC, id DESC
                        """)
                .query((rs, rowNum) -> new BundleView(
                        rs.getString("id"),
                        rs.getInt("file_count"),
                        rs.getLong("byte_size"),
                        readSummary(rs.getString("manifest_summary")),
                        rs.getString("note"),
                        rs.getInt("active") != 0,
                        rs.getString("created_by"),
                        rs.getString("created_at"),
                        rs.getString("updated_at")))
                .list();
    }

    /** 아트 운영 이력(성공·실패 모두). 공지 이력과 같은 테이블·같은 모양(V18). */
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

    /**
     * 번들 업로드. <b>활성화하지 않는다</b> — 올리는 것과 켜는 것은 별개 동작이다.
     *
     * <p>왜 나눴나: 새 아트가 잘못됐을 때 그 사실을 알기 전에 이미 라이브에 나가 있으면,
     * 되돌리는 동안 유저가 틀린 그림을 본다. 올려 두고 요약(유닛 수·매핑 버전)을 확인한 뒤
     * 켜는 편이 한 단계 느리지만 <b>되돌릴 일 자체가 줄어든다</b>.
     */
    public BundleView upload(String actorUserId, MultipartFile file, String note, String reason) {
        String revisionId = Ulid.next();
        try {
            validateReason(reason);
            if (file == null || file.isEmpty()) {
                throw ApiException.validation("업로드할 번들(zip)이 없습니다");
            }
            byte[] zipBytes = read(file);
            CharBundleStorage.Extracted extracted = storage.extract(revisionId, zipBytes);
            Map<String, Object> summary = summarize(revisionId);

            String now = Notices.now(clock);
            try {
                txRunner.run(() -> jdbcClient.sql("""
                                INSERT INTO char_bundles(id, file_count, byte_size, manifest_summary,
                                                         note, active, created_by, created_at, updated_at)
                                VALUES (?, ?, ?, ?, ?, 0, ?, ?, ?)
                                """)
                        .params(revisionId, extracted.names().size(), extracted.totalBytes(),
                                writeJson(summary), trimNote(note), actorUserId, now, now)
                        .update());
            } catch (RuntimeException e) {
                storage.removeQuietly(revisionId); // DB 가 실패하면 푼 파일도 되돌린다(고아 방지)
                throw e;
            }

            BundleView view = new BundleView(revisionId, extracted.names().size(), extracted.totalBytes(),
                    summary, trimNote(note), false, actorUserId, now, now);
            audit(actorUserId, ACTION_UPLOAD, "ok", reason, detail(revisionId, null, view, null, null));
            return view;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_UPLOAD, "error", reason,
                    detail(revisionId, null, null, Map.of("note", String.valueOf(note)), e));
            throw rethrow(e);
        }
    }

    /**
     * 활성 리비전 전환. {@code revisionId=null} 이면 <b>전부 끈다</b> = 구운 폴백으로 롤백.
     *
     * <p>⚠️ 끄기와 켜기가 <b>한 트랜잭션</b>이다. 나누면 "둘 다 꺼진" 창(아트가 잠깐 사라짐)이나
     * "둘 다 켜진" 상태(어느 쪽이 서빙될지 조회 순서에 달림 = 새로고침마다 아트가 바뀜)가 생긴다.
     * 후자는 V31 의 부분 유니크 인덱스가 DB 차원에서도 막는다.
     */
    public ActiveResult setActive(String actorUserId, String revisionId, String reason) {
        try {
            validateReason(reason);
            if (revisionId != null && !revisionId.isBlank()) {
                boolean exists = jdbcClient.sql("SELECT COUNT(*) FROM char_bundles WHERE id = ?")
                        .params(revisionId).query(Integer.class).single() > 0;
                if (!exists) {
                    throw ApiException.notFound("그런 아트 번들 리비전이 없습니다: " + revisionId);
                }
            }
            String target = revisionId == null || revisionId.isBlank() ? null : revisionId;
            String now = Notices.now(clock);
            txRunner.run(() -> {
                jdbcClient.sql("UPDATE char_bundles SET active = 0, updated_at = ? WHERE active = 1")
                        .params(now).update();
                if (target != null) {
                    jdbcClient.sql("UPDATE char_bundles SET active = 1, updated_at = ? WHERE id = ?")
                            .params(now, target).update();
                }
            });

            ActiveResult result = new ActiveResult(target, list());
            audit(actorUserId, ACTION_ACTIVATE, "ok", reason,
                    detail(target, null, null, Map.of("activeRevision", String.valueOf(target)), null));
            return result;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_ACTIVATE, "error", reason,
                    detail(revisionId, null, null, Map.of("activeRevision", String.valueOf(revisionId)), e));
            throw rethrow(e);
        }
    }

    // ── 내부 ─────────────────────────────────────────────────────────────

    /**
     * 방금 푼 트리의 매니페스트를 읽어 요약을 만든다. <b>파싱까지 여기서 한다</b> —
     * JSON 이 깨진 번들을 활성화하면 web 은 그 순간 <b>부분 폴백</b>(일부 축만 살아 있는 상태)이
     * 되는데, 그건 "아트가 안 바뀐다"보다 알아채기 어렵다.
     */
    private Map<String, Object> summarize(String revisionId) {
        Map<String, Object> base = readJson(revisionId, "manifest.json");
        Map<String, Object> units = readJson(revisionId, "units/manifest.json");
        Map<String, Object> mapping = readJson(revisionId, "player-chars.json");
        readJson(revisionId, "characters/manifest.json"); // 파싱 가능 여부만 확인
        return CharBundleStorage.summarize(base, units, mapping);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readJson(String revisionId, String rel) {
        CharBundleStorage.Served served = storage.read(revisionId, rel);
        if (served == null) {
            throw ApiException.validation("번들에 " + rel + " 가 없습니다");
        }
        try {
            return objectMapper.readValue(served.bytes(), Map.class);
        } catch (IOException e) {
            // ⚠️ 파서 내부 메시지를 응답에 그대로 싣지 않는다(AdminErrorHandler 가 막는 유출과 같은 축) —
            //    운영자에게 필요한 것은 "어느 파일이 JSON 이 아닌가"뿐이다.
            throw ApiException.validation(rel + " 를 JSON 으로 읽지 못했습니다(파일이 손상됐거나 형식이 아닙니다)");
        }
    }

    private static byte[] read(MultipartFile file) {
        try {
            return file.getBytes();
        } catch (IOException e) {
            throw ApiException.validation("업로드 파일을 읽지 못했습니다: " + e.getMessage());
        }
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (IOException e) {
            return null;
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readSummary(String raw) {
        if (raw == null || raw.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(raw, Map.class);
        } catch (IOException e) {
            return Map.of();
        }
    }

    private static String trimNote(String raw) {
        if (raw == null || raw.isBlank()) {
            return null;
        }
        String t = raw.trim();
        return t.length() <= NOTE_MAX_CHARS ? t : t.substring(0, NOTE_MAX_CHARS);
    }

    /**
     * ⚠️ <b>사유는 필수다</b>(형제 서비스 {@code AdminNoticeService.validateReason} 와 같은 규율,
     * openapi 도 {@code required} 로 선언한다). 길이만 보던 판이 있었는데, 그러면 화면 밖에서
     * API 를 직접 호출할 때만 원장이 비게 된다 — <b>"누가 왜 했나"가 필요한 상황이 정확히 그 경우다</b>
     * (독립검증 MAJ-2).
     */
    private static void validateReason(String reason) {
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("reason 은 필수입니다(운영 사유 기록)");
        }
        if (reason.length() > REASON_MAX_CHARS) {
            throw ApiException.validation("reason 은 " + REASON_MAX_CHARS + "자 이하여야 합니다");
        }
    }

    private Map<String, Object> detail(String revisionId, BundleView before, BundleView after,
                                       Object attempted, RuntimeException error) {
        Map<String, Object> detail = new LinkedHashMap<>();
        if (revisionId != null) {
            detail.put("revisionId", revisionId);
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

    private void audit(String actorUserId, String action, String result, String reason,
                       Map<String, Object> detail) {
        String detailJson = writeJson(detail);
        jdbcClient.sql("""
                        INSERT INTO admin_ops_audit(id, actor_user_id, action, result, reason, detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), actorUserId, action, result, reason,
                        detailJson == null ? "{}" : detailJson, Notices.now(clock))
                .update();
    }

    private RuntimeException rethrow(RuntimeException e) {
        return e instanceof ApiException api ? api : ApiException.validation(String.valueOf(e.getMessage()));
    }

    /** 보관소 루트(운영 화면의 진단 표시용 — 어디에 쌓이는지 운영자가 알아야 한다). */
    public String storageRoot() {
        return storage.root().toString();
    }

    /** 지금 활성 리비전(없으면 null) — 화면이 "구운 폴백 중"을 표시할 수 있게. */
    public String activeRevision() {
        return bundles.activeRevisionId().orElse(null);
    }

    /** 리비전 디렉토리 존재 확인(운영 진단). */
    public boolean revisionFilesExist(String revisionId) {
        return Files.exists(storage.revisionDir(revisionId));
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    public record BundleView(String id, int fileCount, long byteSize, Map<String, Object> summary,
                             String note, boolean active, String createdBy,
                             String createdAt, String updatedAt) {
    }

    public record ActiveResult(String activeRevision, List<BundleView> bundles) {
    }

    /** {@code revisionId} 가 null/빈값이면 **전부 끈다**(구운 폴백으로 롤백). */
    public record ActivateRequest(String revisionId, String reason) {
    }
}
