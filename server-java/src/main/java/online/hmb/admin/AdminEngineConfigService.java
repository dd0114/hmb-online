package online.hmb.admin;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import online.hmb.common.ApiException;
import org.springframework.http.HttpStatus;
import online.hmb.common.Ulid;
import online.hmb.engine.EngineRunnerClient;
import online.hmb.engine.LiveEngineConfigService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * <b>계수 무배포 운영</b>(#383) — 하네스에서 확정한 엔진 계수를 재배포 없이 반영한다.
 * 설계 SoT = {@code docs/plan-v5/live-engine-config.md}, 운영 절차는 그 문서 §9.
 *
 * <p><b>이 클래스의 존재 이유는 게이트다.</b> 이 기능은 배포 게이트를 없앤다 — 없앤 게이트를
 * 아무것도 대체하지 않으면 오타 한 번이 <b>그 이후 생성되는 모든 매치</b>를 죽인다(진행 중 매치는
 * {@link LiveEngineConfigService} 의 스냅샷이 보호하지만 신규는 아니다). 그래서 원장에 쓰기 전에
 * <b>러너에게 물어본다</b>: 경로가 실재하는가 · 타입이 맞는가 · 이 값으로 경기가 성립하는가.
 * 판정을 여기서 흉내내면 엔진이 바뀔 때 조용히 어긋난다 — 유효한 경로는 엔진을 손에 든 쪽만 안다.
 *
 * <p><b>멱등 판정은 {@code request_hash} 하나</b>다. 필드를 하나씩 비교하면 빠뜨린 필드가 곧
 * 구멍이다 — #323(우편함)에서 독립검증이 그 방식을 두 번 뚫었다.
 *
 * <p>모든 시도는 {@code admin_ops_audit}(V18)에 남는다. <b>실패도 남긴다</b> — 거절된 시도가
 * 이력에 없으면 "왜 안 바뀌었나"를 나중에 아무도 모른다(#209 독립검증 BL-1).
 */
@Service
public class AdminEngineConfigService {

    private static final Logger log = LoggerFactory.getLogger(AdminEngineConfigService.class);

    public static final String ACTION_SET = "engine_config_set";
    public static final String ACTION_VALIDATE = "engine_config_validate";

    private static final int REASON_MAX_CHARS = 500;
    /** 오버레이 크기 상한 — 실수로 config 를 통째로 붙여넣는 사고를 막는다(계수는 수십 개면 족하다). */
    private static final int OVERRIDES_MAX = 200;

    private final LiveEngineConfigService live;
    private final EngineRunnerClient runner;
    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public AdminEngineConfigService(LiveEngineConfigService live, EngineRunnerClient runner,
                                    JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.live = live;
        this.runner = runner;
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /** 지금 <b>새 매치에 실릴</b> 값 + 출처. "적용됐다"의 정의가 화면과 서버에서 같아야 한다. */
    public ConfigView current() {
        LiveEngineConfigService.Current c = live.current();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("revisionId", c.revisionId());
        view.put("overrides", c.overrides());
        view.put("effectiveConfigHash", c.effectiveHash());
        view.put("actor", c.actor());
        view.put("reason", c.reason());
        view.put("changedAt", c.createdAt());
        view.put("appliesTo", "이 값은 **지금 이후 생성되는 매치**부터 적용된다. 진행 중 매치는 "
                + "시작 시점 스냅샷으로 끝까지 돈다.");
        return new ConfigView(view);
    }

    public List<LiveEngineConfigService.Row> history(int limit) {
        return live.history(limit);
    }

    /** 오버레이 가능한 경로 전수 — 운영자가 경로 이름을 추측하지 않게 한다(러너 위임). */
    public JsonNode knobs() {
        return runner.configKnobs();
    }

    // ── 운영 액션 ─────────────────────────────────────────────────────────

    /** 드라이런 — 원장을 만들지 않는다. 값을 확정하기 전에 diff·스모크만 본다. */
    public JsonNode validate(String actorUserId, Map<String, Object> overrides) {
        Map<String, Object> clean = sanitize(overrides);
        try {
            JsonNode result = runner.validateConfigOverrides(clean);
            audit(actorUserId, ACTION_VALIDATE, "ok", "dry-run",
                    Map.of("attempted", clean, "result", result));
            return result;
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_VALIDATE, "failed", "dry-run",
                    Map.of("attempted", clean, "error", String.valueOf(e.getMessage())));
            throw e;
        }
    }

    /**
     * 오버레이 <b>전체 교체</b>(PATCH 아님). 부분 병합은 "지금 뭐가 걸려 있나"를 운영자가 머릿속으로
     * 추적하게 만들고, 롤백을 역연산 계산으로 바꾼다. {@code GET → 수정 → PUT} 이 유일한 루프이고,
     * 그래서 원장의 모든 행이 <b>완결 스냅샷</b>이다.
     *
     * <p>기본값 복귀 = 빈 오버레이({@code {}})로 PUT — 그 사실도 원장에 리비전으로 남는다.
     */
    public synchronized ConfigView replace(String actorUserId, Map<String, Object> overrides,
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

        String requestHash = hashOf(clean, reason);

        JsonNode validated;
        try {
            // 원장에 쓰기 **전에** 러너에게 물어본다. 여기서 막지 못한 값은 이후 모든 신규 매치를 죽인다.
            validated = runner.validateConfigOverrides(clean);
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_SET, "failed", reason,
                    Map.of("attempted", clean, "error", String.valueOf(e.getMessage())));
            // ⚠️ **러너 장애를 400 으로 감싸지 않는다**(독립검증 5차 m5). 400 은 "운영자가 보낸 값이
            // 문제다"라는 뜻이고, 그 문구를 받은 운영자는 고칠 수 없는 것을 고치려 든다 — 러너가
            // 안 떠 있는데 계수를 계속 바꿔 보게 만드는 것이 정확히 그 상태다. 값 문제는
            // EngineRunnerClient 가 이미 ApiException(400)으로 올려 준다; 나머지는 그대로 5xx 다.
            if (e instanceof ApiException api) {
                throw api;
            }
            throw new ApiException(HttpStatus.BAD_GATEWAY, "RUNNER_UNAVAILABLE",
                    "계수 검증기(러너)에 도달하지 못했습니다: " + e.getMessage());
        }

        String effectiveHash = validated.path("effectiveConfigHash").asText(null);
        if (effectiveHash == null || effectiveHash.isBlank()) {
            // 지문 없이 원장을 쓰면 "무슨 config 였나"의 근거가 비고, NOT NULL 제약에 걸려 500 이
            // 된다(독립검증 m5). 지문을 못 주는 러너는 이 기능을 지원하지 않는 구 이미지라는 뜻이라
            // **fail-closed** 가 맞다 — 반쯤 적용된 상태를 만들지 않는다.
            String message = "러너가 유효 config 지문을 주지 않았습니다(이 기능을 지원하지 않는 구 러너입니다)";
            audit(actorUserId, ACTION_SET, "failed", reason, Map.of("attempted", clean, "error", message));
            throw ApiException.validation(message);
        }
        try {
            live.recordRevision(actorUserId, clean, effectiveHash, reason, idemKey, requestHash);
        } catch (RuntimeException e) {
            // 멱등 충돌(409)도 이력이다 — "보냈는데 왜 안 바뀌었나"의 답이 여기 있다.
            audit(actorUserId, ACTION_SET, "failed", reason,
                    Map.of("attempted", clean, "error", String.valueOf(e.getMessage())));
            throw e;
        }

        ConfigView after = current();
        audit(actorUserId, ACTION_SET, "ok", reason,
                Map.of("after", after.value(), "changed", validated.path("changed")));
        log.info("engine config overrides replaced by admin {}: {} knobs, hash={}",
                actorUserId, clean.size(), effectiveHash);
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
     * 값 타입만 본다 — <b>경로가 유효한지는 여기서 판정하지 않는다</b>. 그건 러너가 한다.
     * 여기서 경로 규칙을 흉내내면 엔진이 바뀔 때 두 곳의 진실이 조용히 갈라진다.
     */
    private Map<String, Object> sanitize(Map<String, Object> overrides) {
        if (overrides == null) {
            return Map.of();
        }
        if (overrides.size() > OVERRIDES_MAX) {
            throw ApiException.validation("오버레이는 " + OVERRIDES_MAX + "개 이하여야 합니다");
        }
        Map<String, Object> clean = new TreeMap<>();
        for (Map.Entry<String, Object> e : overrides.entrySet()) {
            Object v = e.getValue();
            if (e.getKey() == null || e.getKey().isBlank()) {
                throw ApiException.validation("빈 경로가 있습니다");
            }
            if (v instanceof Number n) {
                double d = n.doubleValue();
                if (!Double.isFinite(d)) {
                    throw ApiException.validation(e.getKey() + ": 유한한 수여야 합니다");
                }
                clean.put(e.getKey(), v);
            } else if (v instanceof Boolean b) {
                clean.put(e.getKey(), b);
            } else {
                throw ApiException.validation(e.getKey() + ": 값은 수 또는 참/거짓이어야 합니다(받은 값: "
                        + (v == null ? "null" : v.getClass().getSimpleName()) + ")");
            }
        }
        return clean;
    }

    /**
     * 요청 원문 해시 — 멱등 판정의 <b>유일</b> 기준. 정본(키 정렬) 직렬화 + 사유까지 포함한다:
     * 같은 값을 <b>다른 사유</b>로 다시 넣는 것은 다른 운영 행위이므로 같은 키를 재사용하면 안 된다.
     */
    private String hashOf(Map<String, Object> clean, String reason) {
        try {
            String payload = objectMapper.writeValueAsString(clean) + " " + reason;
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
                .params(Ulid.next(), actorUserId, action, result, reason, detailJson, Instant.now().toString())
                .update();
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    /** 값 + <b>어디서 왔는지</b> + <b>언제부터 적용되는지</b>. 셋 다 없으면 운영이 확신할 수 없다. */
    public record ConfigView(Map<String, Object> value) {
    }
}
