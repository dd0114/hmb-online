package online.hmb.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import online.hmb.common.ApiException;
import online.hmb.common.Ulid;
import online.hmb.growth.GrowthTuning;
import online.hmb.growth.LiveGrowthConfigService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * <b>성장 계수 무배포 운영</b>(#405 W2a) — 설계 SoT = {@code docs/plan-v5/growth-redesign.md} §2.8.
 *
 * <p><b>검증은 서버 내부다.</b> #383(엔진 계수)은 판정을 러너에 위임했다 — 유효한 경로가 무엇인지는
 * 엔진을 손에 든 쪽만 알기 때문이다. 성장 계수는 <b>이 서버가 소비자</b>라 위임할 대상이 없다:
 * 경로 화이트리스트({@link GrowthTuning#KNOBS}) · 타입 · 범위를 여기서 본다. 그래서 이 클래스의
 * 판정 규칙은 흉내가 아니라 <b>SoT</b>이고, 레지스트리 계약({@code GrowthTuningRegistryTest})이
 * 그 목록이 실제 계수 트리와 어긋나지 않게 붙잡는다.
 *
 * <p><b>무효 노브는 이유를 같이 돌려준다</b>(#383 m-C 선례): "안 됩니다"만 주면 운영자가 오타인지
 * 범위인지 없는 경로인지 모른 채 계속 시도한다. 항목마다 {@code issues[]} 한 줄이다.
 *
 * <p>모든 시도는 {@code admin_ops_audit}(V18)에 남는다. <b>실패도 남긴다</b> — 거절된 시도가 이력에
 * 없으면 "왜 안 바뀌었나"를 나중에 아무도 모른다(#209 독립검증 BL-1).
 */
@Service
public class AdminGrowthConfigService {

    private static final Logger log = LoggerFactory.getLogger(AdminGrowthConfigService.class);

    public static final String ACTION_SET = "growth_config_set";
    public static final String ACTION_VALIDATE = "growth_config_validate";

    private static final int REASON_MAX_CHARS = 500;
    /** 오버레이 크기 상한 — 실수로 계수 트리를 통째로 붙여넣는 사고를 막는다. */
    private static final int OVERRIDES_MAX = 400;

    private final LiveGrowthConfigService live;
    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public AdminGrowthConfigService(LiveGrowthConfigService live, JdbcClient jdbcClient,
                                    ObjectMapper objectMapper) {
        this.live = live;
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /** 지금 성장 계산에 쓰이는 값 + 출처 + 적용 시점. "적용됐다"의 정의가 화면과 서버에서 같아야 한다. */
    public Map<String, Object> current() {
        LiveGrowthConfigService.Current c = live.current();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("revisionId", c.revisionId());
        view.put("overrides", c.overrides());
        view.put("effective", live.effective());
        view.put("actor", c.actor());
        view.put("reason", c.reason());
        view.put("changedAt", c.createdAt());
        view.put("knobCount", GrowthTuning.KNOBS.size());
        view.put("appliesTo", "이 값은 **다음 정산·조회부터** 즉시 적용된다(매치 pin 없음). "
                + "이미 정산이 끝난 매치의 결과는 바뀌지 않는다.");
        return view;
    }

    public List<LiveGrowthConfigService.Row> history(int limit) {
        return live.history(limit);
    }

    /** 오버레이 가능한 경로 전수 + 타입·범위 — 운영자가 경로 이름을 추측하지 않게 한다. */
    public Map<String, Object> knobs() {
        List<Map<String, Object>> rows = new ArrayList<>();
        GrowthTuning effective = live.effective();
        for (String path : GrowthTuning.KNOBS) {
            GrowthTuning.Spec spec = GrowthTuning.specs().get(path);
            Map<String, Object> row = new LinkedHashMap<>();
            row.put("path", path);
            row.put("type", spec.type().name());
            row.put("min", spec.min());
            row.put("max", spec.max());
            // 효력 시점 — 저장은 되지만 지금 값이 바뀌지 않는 노브를 운영자가 "적용됐다"고 읽지
            // 않게 한다. PUBLISH = 다음 카드 발행부터(이미 발행된 카드 스탯은 안 바뀐다).
            row.put("scope", spec.scope().name());
            row.put("appliesWhen", spec.scope() == GrowthTuning.KnobScope.PUBLISH
                    ? "다음 카드 발행부터(이미 발행된 카드의 스탯은 바뀌지 않는다 — #412 승계 인터페이스)"
                    : "다음 조회·정산부터 즉시");
            row.put("value", effective.valueAt(path, objectMapper));
            rows.add(row);
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("count", rows.size());
        out.put("knobs", rows);
        return out;
    }

    // ── 운영 액션 ─────────────────────────────────────────────────────────

    /** 드라이런 — <b>원장을 만들지 않는다</b>. 값을 확정하기 전에 무엇이 바뀌는지만 본다. */
    public Map<String, Object> validate(String actorUserId, Map<String, Object> overrides) {
        try {
            Map<String, Object> clean = sanitize(overrides);
            Map<String, Object> result = diff(clean);
            audit(actorUserId, ACTION_VALIDATE, "ok", "dry-run",
                    Map.of("attempted", clean, "result", result));
            return result;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_VALIDATE, "failed", "dry-run",
                    Map.of("attempted", overrides == null ? Map.of() : overrides,
                            "error", String.valueOf(e.getMessage())));
            throw e;
        }
    }

    /**
     * 오버레이 <b>전체 교체</b>(PATCH 아님). 부분 병합은 "지금 뭐가 걸려 있나"를 운영자가 머릿속으로
     * 추적하게 만들고 롤백을 역연산으로 바꾼다. {@code GET → 수정 → PUT} 이 유일한 루프이고,
     * 그래서 원장의 모든 행이 <b>완결 스냅샷</b>이다. 기본값 복귀 = {@code overrides:{}} PUT.
     */
    public synchronized Map<String, Object> replace(String actorUserId, Map<String, Object> overrides,
                                                    String reason, String idemKey) {
        Map<String, Object> clean;
        try {
            validateReason(reason);
            clean = sanitize(overrides);
        } catch (ApiException e) {
            audit(actorUserId, ACTION_SET, "failed", reason,
                    Map.of("attempted", overrides == null ? Map.of() : overrides,
                            "error", String.valueOf(e.getMessage())));
            throw e;
        }
        Map<String, Object> changed = diff(clean);
        String requestHash = hashOf(clean, reason);
        try {
            live.recordRevision(actorUserId, clean, reason, idemKey, requestHash);
        } catch (RuntimeException e) {
            // 멱등 충돌(409)도 이력이다 — "보냈는데 왜 안 바뀌었나"의 답이 여기 있다.
            audit(actorUserId, ACTION_SET, "failed", reason,
                    Map.of("attempted", clean, "error", String.valueOf(e.getMessage())));
            throw e;
        }
        Map<String, Object> after = current();
        audit(actorUserId, ACTION_SET, "ok", reason,
                Map.of("after", Map.of("revisionId", String.valueOf(after.get("revisionId")),
                        "overrides", clean), "changed", changed.get("changed")));
        log.info("growth tuning overrides replaced by admin {}: {} knobs", actorUserId, clean.size());
        return after;
    }

    // ── 검증 ────────────────────────────────────────────────────────────

    private void validateReason(String reason) {
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("reason 은 필수입니다(운영 사유 기록)");
        }
        if (reason.length() > REASON_MAX_CHARS) {
            throw ApiException.validation("reason 은 " + REASON_MAX_CHARS + "자 이하여야 합니다");
        }
    }

    /**
     * 경로 화이트리스트 + 타입 + 범위. <b>무효 항목을 전부 모아 한 번에</b> 돌려준다 —
     * 첫 오류에서 끊으면 운영자가 10개 고치는 데 10번 왕복한다.
     */
    private Map<String, Object> sanitize(Map<String, Object> overrides) {
        if (overrides == null) {
            return Map.of();
        }
        if (overrides.size() > OVERRIDES_MAX) {
            throw ApiException.validation("오버레이는 " + OVERRIDES_MAX + "개 이하여야 합니다");
        }
        Map<String, Object> clean = new TreeMap<>();
        List<String> issues = new ArrayList<>();
        for (Map.Entry<String, Object> e : overrides.entrySet()) {
            String path = e.getKey();
            Object v = e.getValue();
            if (path == null || path.isBlank()) {
                issues.add("(빈 경로): 경로가 비어 있습니다");
                continue;
            }
            GrowthTuning.Spec spec = GrowthTuning.specs().get(path);
            if (spec == null) {
                issues.add(path + ": 성장 계수에 없는 경로입니다(GET /api/admin/growth-config/knobs 로 확인)");
                continue;
            }
            switch (spec.type()) {
                case BOOL -> {
                    if (v instanceof Boolean b) {
                        clean.put(path, b);
                    } else {
                        issues.add(path + ": 참/거짓이어야 합니다(받은 값: " + typeName(v) + ")");
                    }
                }
                case INT, DOUBLE -> {
                    if (!(v instanceof Number n)) {
                        issues.add(path + ": 수여야 합니다(받은 값: " + typeName(v) + ")");
                    } else {
                        double d = n.doubleValue();
                        if (!Double.isFinite(d)) {
                            issues.add(path + ": 유한한 수여야 합니다");
                        } else if (spec.type() == GrowthTuning.KnobType.INT && d != Math.rint(d)) {
                            issues.add(path + ": 정수여야 합니다(받은 값: " + d + ")");
                        } else if (d < spec.min() || d > spec.max()) {
                            issues.add(path + ": " + spec.min() + " ~ " + spec.max()
                                    + " 범위여야 합니다(받은 값: " + d + ")");
                        } else {
                            clean.put(path, spec.type() == GrowthTuning.KnobType.INT ? (Object) (long) d : d);
                        }
                    }
                }
                default -> issues.add(path + ": 알 수 없는 노브 종류입니다");
            }
        }
        if (!issues.isEmpty()) {
            throw new ApiException(org.springframework.http.HttpStatus.BAD_REQUEST, "VALIDATION_ERROR",
                    "성장 계수 오버레이가 유효하지 않습니다: " + String.join(" / ", issues),
                    Map.of("issues", issues));
        }
        return clean;
    }

    private static String typeName(Object v) {
        return v == null ? "null" : v.getClass().getSimpleName();
    }

    /**
     * 이 오버레이가 <b>실제로 무엇을 바꾸는가</b>. 값이 기본값과 같아 아무것도 안 바뀌는 오버레이를
     * 운영자가 "적용됐다"고 오해하지 않게 한다 — {@code before → after} 를 그대로 보여준다.
     */
    private Map<String, Object> diff(Map<String, Object> clean) {
        // ⚠️ 비교 기준은 "지금 유효값"이다(코드 기본값이 아니다). 운영자가 알고 싶은 것은
        //    "이 PUT 이 지금 상태를 어떻게 바꾸나"이지 "기본값과 얼마나 다른가"가 아니다.
        //    다만 PUT 은 **전체 교체**라, 지금 걸려 있던 오버레이 중 이번에 안 적힌 경로는
        //    기본값으로 되돌아간다 — 그래서 얹는 대상은 기본값이다.
        GrowthTuning before = live.effective();
        GrowthTuning after = live.defaults().withOverrides(clean, objectMapper);
        List<Map<String, Object>> changed = new ArrayList<>();
        for (String path : GrowthTuning.KNOBS) {
            Object b = before.valueAt(path, objectMapper);
            Object a = after.valueAt(path, objectMapper);
            if (!numericallyEqual(b, a)) {
                Map<String, Object> row = new LinkedHashMap<>();
                row.put("path", path);
                row.put("before", b);
                row.put("after", a);
                changed.add(row);
            }
        }
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("ok", true);
        out.put("knobs", clean.size());
        out.put("changed", changed);
        return out;
    }

    private static boolean numericallyEqual(Object a, Object b) {
        if (a instanceof Number x && b instanceof Number y) {
            return Double.compare(x.doubleValue(), y.doubleValue()) == 0;
        }
        return java.util.Objects.equals(a, b);
    }

    /**
     * 요청 원문 해시 — 멱등 판정의 <b>유일</b> 기준. 정본(키 정렬) 직렬화 + 사유까지 포함한다:
     * 같은 값을 <b>다른 사유</b>로 다시 넣는 것은 다른 운영 행위다.
     */
    private String hashOf(Map<String, Object> clean, String reason) {
        try {
            String payload = objectMapper.writeValueAsString(new TreeMap<>(clean)) + " " + reason;
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            return HexFormat.of().formatHex(md.digest(payload.getBytes(StandardCharsets.UTF_8))).substring(0, 32);
        } catch (JsonProcessingException | NoSuchAlgorithmException e) {
            throw ApiException.validation("요청 해시 계산에 실패했습니다: " + e.getMessage());
        }
    }

    // ── 감사 ────────────────────────────────────────────────────────────

    private void audit(String actorUserId, String action, String result, String reason,
                       Map<String, Object> detail) {
        String detailJson;
        try {
            detailJson = objectMapper.writeValueAsString(detail);
        } catch (JsonProcessingException e) {
            detailJson = "{\"error\":\"detail 직렬화 실패\"}";
        }
        jdbcClient.sql("""
                        INSERT INTO admin_ops_audit(id, actor_user_id, action, result, reason, detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), actorUserId, action, result,
                        reason == null ? "(없음)" : reason, detailJson, Instant.now().toString())
                .update();
    }
}
