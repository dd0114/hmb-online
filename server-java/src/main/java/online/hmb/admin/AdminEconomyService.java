package online.hmb.admin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.io.File;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.Ulid;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * economy 무배포 운영 (#209 B안) — <b>재배포 없이</b> 스타터 최상위 후보를 갈아끼우고 리로드한다.
 *
 * <p><b>왜 "리로드"만으로는 안 되는가</b>(이 설계의 핵심): 발행물
 * {@code data/players/economy.v3.json} 은 {@code Dockerfile} 의 {@code COPY} 로 <b>이미지에 구워져</b>
 * 있다. 컨테이너 안에서 그 파일은 바뀌지 않으므로, 다시 읽어봐야 같은 바이트다 — 리로드 엔드포인트만
 * 붙이면 "무배포 운영"이 되는 게 아니라 <b>아무 것도 안 하는 버튼</b>이 된다.
 *
 * <p>그래서 <b>override 파일</b>을 둔다: 운영이 올린 내용을 DB 와 같은 디렉토리
 * ({@link EconomyService#overridePath()}, 도커에서는 영속 볼륨)에 원자적으로 쓰고 그걸 우선 로드한다.
 * 재기동해도 살아남고(볼륨), 되돌리기는 파일 삭제 한 번이다.
 *
 * <p><b>안전 장치</b>
 * <ul>
 *   <li>검증을 통과한 내용만 파일이 된다 — 카탈로그에 없는 id·중복·기본팩과 겹침·범위 밖 count 는 400.</li>
 *   <li>쓰기는 <b>임시파일 → ATOMIC_MOVE</b>. 중간에 죽어도 반쯤 쓰인 파일이 로드되는 창이 없다.</li>
 *   <li>리로드가 실패하면 <b>직전 스냅샷을 유지</b>하고 파일을 되돌린다(서비스가 멈추지 않는다).</li>
 *   <li>모든 시도는 {@code admin_ops_audit} 에 남는다 — <b>실패도 남긴다</b>(시도 자체가 이력이다).</li>
 * </ul>
 */
@Service
public class AdminEconomyService {

    private static final Logger log = LoggerFactory.getLogger(AdminEconomyService.class);

    public static final String ACTION_RELOAD = "economy_reload";
    public static final String ACTION_STARTER_TOP = "economy_starter_top";
    public static final String ACTION_OVERRIDE_CLEAR = "economy_override_clear";

    private static final int REASON_MAX_CHARS = 500;
    private static final int POOL_MAX = 50;

    private final EconomyService economyService;
    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    public AdminEconomyService(EconomyService economyService, JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.economyService = economyService;
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    // ── 조회 ─────────────────────────────────────────────────────────────

    /** 지금 서버가 실제로 쓰고 있는 값 + 출처. 운영 화면의 "현재 상태"다. */
    public EconomyView current() {
        return view(economyService.snapshot());
    }

    /** 최근 운영 이력(감사 원장). */
    public List<AuditEntry> history(int limit) {
        int capped = Math.max(1, Math.min(limit, 100));
        return jdbcClient.sql("""
                        SELECT a.id, a.action, a.result, a.reason, a.detail_json, a.created_at,
                               u.nickname AS actor
                        FROM admin_ops_audit a JOIN users u ON u.id = a.actor_user_id
                        ORDER BY a.created_at DESC, a.id DESC
                        LIMIT ?
                        """)
                .param(capped)
                .query((rs, rowNum) -> new AuditEntry(
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
     * 디스크 재읽기. override 파일을 <b>바깥에서</b> 바꿔치기한 운영(볼륨 직접 편집·바인드마운트)이나
     * 되돌린 뒤 반영에 쓴다. 내용을 서버가 바꾸지는 않는다.
     */
    public EconomyView reload(String actorUserId, String reason) {
        validateReason(reason);
        EconomyView before = current();
        try {
            EconomyService.Snapshot after = economyService.reload();
            audit(actorUserId, ACTION_RELOAD, "ok", reason, Map.of("before", before, "after", view(after)));
            return view(after);
        } catch (RuntimeException e) {
            audit(actorUserId, ACTION_RELOAD, "failed", reason,
                    Map.of("before", before, "error", String.valueOf(e.getMessage())));
            throw ApiException.validation("리로드에 실패했습니다: " + e.getMessage());
        }
    }

    /**
     * 스타터 최상위 후보 교체 — <b>이게 "배포 없이 카드 조정"의 실제 경로</b>다.
     * 현재 유효 내용을 base 로 {@code starterTop} 만 갈아끼운 override 를 쓰고 즉시 리로드한다.
     */
    public EconomyView replaceStarterTop(String actorUserId, List<String> pool, Integer count, String reason) {
        validateReason(reason);
        List<String> cleanPool = validatePool(pool);
        int cleanCount = validateCount(count, cleanPool.size());

        EconomyView before = current();
        JsonNode base = readEffectiveJson();

        ObjectNode next = base.deepCopy();
        ObjectNode starterTop = next.putObject("starterTop");
        ArrayNode poolNode = starterTop.putArray("pool");
        cleanPool.forEach(poolNode::add);
        starterTop.put("count", cleanCount);

        Path overridePath = Path.of(economyService.overridePath());
        byte[] previous = readIfExists(overridePath);
        try {
            writeAtomically(overridePath, next);
            EconomyService.Snapshot after = economyService.reload();
            audit(actorUserId, ACTION_STARTER_TOP, "ok", reason, Map.of("before", before, "after", view(after)));
            log.info("starterTop replaced by admin {}: pool={} count={}", actorUserId, cleanPool, cleanCount);
            return view(after);
        } catch (RuntimeException | IOException e) {
            // 새 파일이 서비스를 망가뜨리면 **직전 상태로 되돌린다** — 운영 실수가 가입을 막지 않게.
            restore(overridePath, previous);
            try {
                economyService.reload();
            } catch (RuntimeException ignored) {
                // 되돌린 내용조차 못 읽으면 현재(직전) 스냅샷이 그대로 살아 있다 — 그게 fail-safe 의 목적.
            }
            audit(actorUserId, ACTION_STARTER_TOP, "failed", reason,
                    Map.of("before", before, "attempted",
                            Map.of("pool", cleanPool, "count", cleanCount),
                            "error", String.valueOf(e.getMessage())));
            throw ApiException.validation("starterTop 교체에 실패했습니다: " + e.getMessage());
        }
    }

    /** override 를 지우고 배포 발행물로 되돌린다(원클릭 롤백). */
    public EconomyView clearOverride(String actorUserId, String reason) {
        validateReason(reason);
        EconomyView before = current();
        Path overridePath = Path.of(economyService.overridePath());
        if (!Files.exists(overridePath)) {
            throw ApiException.validation("적용된 override 가 없습니다(이미 발행물을 쓰고 있습니다)");
        }
        byte[] previous = readIfExists(overridePath);
        try {
            Files.delete(overridePath);
            EconomyService.Snapshot after = economyService.reload();
            audit(actorUserId, ACTION_OVERRIDE_CLEAR, "ok", reason, Map.of("before", before, "after", view(after)));
            return view(after);
        } catch (RuntimeException | IOException e) {
            restore(overridePath, previous);
            audit(actorUserId, ACTION_OVERRIDE_CLEAR, "failed", reason,
                    Map.of("before", before, "error", String.valueOf(e.getMessage())));
            throw ApiException.validation("override 제거에 실패했습니다: " + e.getMessage());
        }
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

    /** pool 검증 — 카탈로그 실재 · 중복 없음 · 기본팩과 서로소. 순서는 요청 순서를 보존한다. */
    private List<String> validatePool(List<String> pool) {
        if (pool == null || pool.isEmpty()) {
            throw ApiException.validation("pool 은 최소 1명이어야 합니다");
        }
        if (pool.size() > POOL_MAX) {
            throw ApiException.validation("pool 은 " + POOL_MAX + "명 이하여야 합니다");
        }
        Set<String> unique = new LinkedHashSet<>();
        for (String raw : pool) {
            if (raw == null || raw.isBlank()) {
                throw ApiException.validation("pool 에 빈 playerId 가 있습니다");
            }
            if (!unique.add(raw.trim())) {
                throw ApiException.validation("pool 에 중복된 playerId 가 있습니다: " + raw);
            }
        }
        List<String> clean = List.copyOf(unique);

        String inClause = String.join(",", clean.stream().map(id -> "?").toList());
        Set<String> known = Set.copyOf(jdbcClient
                .sql("SELECT id FROM players WHERE id IN (" + inClause + ")")
                .params(clean.toArray())
                .query(String.class)
                .list());
        for (String id : clean) {
            if (!known.contains(id)) {
                throw ApiException.validation("카탈로그에 없는 playerId 입니다: " + id);
            }
        }

        // 기본팩과 겹치면 "기본 위에 얹히는 1장"이라는 전제가 깨진다(그 유저는 최상위를 못 받은 것과 같다).
        List<String> basics = economyService.get()
                .map(EconomyService.Economy::starterPack)
                .orElse(List.of());
        for (String id : clean) {
            if (basics.contains(id)) {
                throw ApiException.validation("기본팩에 이미 포함된 playerId 입니다: " + id);
            }
        }
        return clean;
    }

    private int validateCount(Integer count, int poolSize) {
        int value = count == null ? 1 : count;
        if (value < 1) {
            throw ApiException.validation("count 는 1 이상이어야 합니다");
        }
        if (value > poolSize) {
            throw ApiException.validation("count 는 pool 크기(" + poolSize + ") 이하여야 합니다");
        }
        return value;
    }

    // ── 파일 I/O ─────────────────────────────────────────────────────────

    /** override 가 있으면 그것, 없으면 발행물 — "지금 유효한 내용"이 새 override 의 base 다. */
    private JsonNode readEffectiveJson() {
        File override = new File(economyService.overridePath());
        File source = override.exists() ? override : new File(economyService.bakedPath());
        try {
            return objectMapper.readTree(source);
        } catch (IOException e) {
            throw ApiException.validation("현재 economy 를 읽지 못했습니다(" + source.getAbsolutePath() + ")");
        }
    }

    /** 임시파일 → ATOMIC_MOVE. 반쯤 쓰인 파일이 로드되는 창을 없앤다. */
    private void writeAtomically(Path target, JsonNode content) throws IOException {
        Path dir = target.toAbsolutePath().getParent();
        Files.createDirectories(dir);
        Path tmp = Files.createTempFile(dir, "economy.override", ".tmp");
        try {
            Files.writeString(tmp, objectMapper.writerWithDefaultPrettyPrinter().writeValueAsString(content) + "\n");
            try {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE);
            } catch (java.nio.file.AtomicMoveNotSupportedException e) {
                Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);
            }
        } finally {
            Files.deleteIfExists(tmp);
        }
    }

    private byte[] readIfExists(Path path) {
        try {
            return Files.exists(path) ? Files.readAllBytes(path) : null;
        } catch (IOException e) {
            return null;
        }
    }

    /** 실패 롤백 — 직전 내용이 있으면 되쓰고, 없었으면(신규 생성이었으면) 지운다. */
    private void restore(Path path, byte[] previous) {
        try {
            if (previous == null) {
                Files.deleteIfExists(path);
            } else {
                Files.write(path, previous);
            }
        } catch (IOException e) {
            log.error("economy override 롤백 실패 {} — 수동 확인 필요", path, e);
        }
    }

    // ── 감사 ────────────────────────────────────────────────────────────

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
                .params(Ulid.next(), actorUserId, action, result, reason, detailJson, Instant.now().toString())
                .update();
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    private EconomyView view(EconomyService.Snapshot snapshot) {
        Map<String, Object> starterTop = new LinkedHashMap<>();
        List<String> pool = new ArrayList<>();
        int count = 0;
        var economy = snapshot.economy().orElse(null);
        if (economy != null && economy.starterTop() != null) {
            pool = economy.starterTop().pool();
            count = economy.starterTop().count();
        }
        starterTop.put("pool", pool);
        starterTop.put("count", count);
        return new EconomyView(
                economy == null ? null : economy.version(),
                snapshot.source().name(),
                snapshot.path(),
                economyService.overridePath(),
                Files.exists(Path.of(economyService.overridePath())),
                snapshot.loadedAt(),
                economy == null ? 0 : economy.starterPack().size(),
                starterTop);
    }

    /** 운영 화면이 보는 "현재 상태" — 값 + <b>어디서 온 값인지</b>(이게 없으면 운영이 확신할 수 없다). */
    public record EconomyView(String version, String source, String effectivePath, String overridePath,
                              boolean overrideApplied, String loadedAt, int starterPackSize,
                              Map<String, Object> starterTop) {
    }

    public record AuditEntry(String id, String actor, String action, String result, String reason,
                             String detailJson, String createdAt) {
    }
}
