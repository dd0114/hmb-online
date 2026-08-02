package online.hmb.growth;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import online.hmb.catalog.EconomyService;
import online.hmb.common.ApiException;
import online.hmb.common.Ulid;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * <b>라이브 성장 계수</b>(#405 W2a) — 지금 서버가 성장 계산에 쓰는 {@link GrowthTuning}.
 * 설계 SoT = {@code docs/plan-v5/growth-redesign.md} §2.8.3.
 *
 * <p><b>유효값 = 기본값 ⊕ 최신 리비전</b>(경로 단위 병합):
 * <ul>
 *   <li>기본값 = {@link GrowthTuning#defaults} — 코드 기본값 위에 발행물({@code economy.growth}/
 *       {@code economy.star})이 "현행 승계" 항목만 덮은 것.</li>
 *   <li>리비전 = {@code growth_config_revisions} 의 <b>마지막 삽입 행</b>(V38 {@code seq} 정렬).
 *       빈 오버레이({@code {}}) 리비전 = 기본값 복귀.</li>
 * </ul>
 *
 * <p><b>매치 pin 을 하지 않는다</b>(#383 엔진 계수와 다른 점, 설계 §2.8.3 명시). 정산은 정산 시점 값을
 * 쓴다 — 성장은 매치 <b>종료 후</b> 한 번 계산되는 것이라 "진행 중 매치가 도중에 값이 바뀌어 깨진다"는
 * #241 형태의 위험이 없다. 대신 어떤 값으로 정산했는지가 사후에 답해져야 하므로
 * {@link #currentRevisionId()} 를 노출한다(정산 리포트에 박제하는 것은 W2b).
 *
 * <p><b>캐시는 두 축을 함께 본다</b>: 리비전 id <b>와</b> economy 스냅샷 참조. economy 는
 * {@code POST /api/admin/economy/reload} 로 이 서비스와 무관하게 갈릴 수 있는데, 리비전만 보고
 * 캐시하면 리로드 후에도 옛 baseline 을 계속 쓰게 된다("리로드했는데 반영 안 됨").
 */
@Service
public class LiveGrowthConfigService {

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final EconomyService economyService;

    /** {@code null} = 아직 안 읽었다. 쓰기 직후 무효화({@code volatile} — 다중 스레드에서 즉시 보인다). */
    private volatile Current cached;

    /** 계산된 유효 tuning + 그것을 만든 두 입력(리비전 id · economy 스냅샷 참조). */
    private volatile Resolved resolved;

    public LiveGrowthConfigService(JdbcClient jdbcClient, ObjectMapper objectMapper,
                                   EconomyService economyService) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.economyService = economyService;
    }

    /** 지금 유효한 오버레이 + 출처. 리비전이 하나도 없으면 {@link Current#none()}. */
    public Current current() {
        Current snapshot = cached;
        if (snapshot == null) {
            snapshot = load();
            cached = snapshot;
        }
        return snapshot;
    }

    /** 정산이 "어느 값으로 계산했나"를 나중에 답할 수 있게 하는 출처(소비는 W2b). */
    public String currentRevisionId() {
        return current().revisionId();
    }

    /**
     * 오버레이 <b>없는</b> 기본값 = 코드 기본값 ⊕ 발행물 승계. 리비전을 걷어냈을 때 돌아갈 자리이자,
     * admin 이 "이 PUT 이 무엇을 바꾸나"를 계산하는 기준면이다(PUT 은 전체 교체다).
     */
    public GrowthTuning defaults() {
        EconomyService.Economy economy = economyService.get().orElse(null);
        return GrowthTuning.defaults(economy == null ? null : economy.growth(),
                economy == null ? null : economy.star());
    }

    /** <b>지금 성장 계산에 쓰이는 계수 전체.</b> 발행물 기본 ⊕ 최신 리비전. */
    public GrowthTuning effective() {
        Current c = current();
        EconomyService.Economy economy = economyService.get().orElse(null);
        Resolved r = resolved;
        // economy 는 참조 비교다 — 리로드가 새 스냅샷 인스턴스를 만들므로 그때만 다시 계산한다.
        if (r != null && r.economy() == economy && java.util.Objects.equals(r.revisionId(), c.revisionId())) {
            return r.tuning();
        }
        GrowthTuning base = GrowthTuning.defaults(economy == null ? null : economy.growth(),
                economy == null ? null : economy.star());
        GrowthTuning tuning = base.withOverrides(c.overrides(), objectMapper);
        resolved = new Resolved(economy, c.revisionId(), tuning);
        return tuning;
    }

    /**
     * 리비전 append. <b>검증은 호출부(admin) 책임</b>이다.
     *
     * @param idemKey     null 이면 멱등 없음. 같은 키 + 같은 {@code requestHash} 는 기존 리비전을 그대로
     *                    돌려주고, 같은 키 + <b>다른</b> 내용은 409 다 — 멱등키는 "같은 의도의 재전송"을
     *                    뜻하므로, 내용이 다르면 그건 재전송이 아니라 사고다.
     * @param requestHash 요청 원문 해시. 멱등 판정의 <b>유일</b> 기준(필드별 비교는 빠뜨린 필드가 곧 구멍).
     */
    public synchronized Current recordRevision(String actorUserId, Map<String, Object> overrides,
                                               String reason, String idemKey, String requestHash) {
        if (idemKey != null && !idemKey.isBlank()) {
            Optional<Row> existing = findByIdem(idemKey);
            if (existing.isPresent()) {
                Row row = existing.get();
                if (!row.requestHash().equals(requestHash)) {
                    throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                            "같은 Idempotency-Key 로 다른 내용이 왔습니다(키를 새로 발급하세요)");
                }
                return toCurrent(row);   // 같은 의도의 재전송 — 새 행을 만들지 않는다.
            }
        }
        String json = canonicalJson(overrides);
        jdbcClient.sql("""
                        INSERT INTO growth_config_revisions(id, overrides_json, actor_user_id, reason,
                                                            idem_key, request_hash, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), json, actorUserId, reason, idemKey, requestHash, Instant.now().toString())
                .update();
        cached = null;   // 다음 조회가 DB 를 본다.
        return current();
    }

    /**
     * <b>"현재 값"을 정하는 정렬 = 삽입 순서({@code seq})</b> — V37 과 같은 이유로 같은 선택이다
     * ({@code LiveEngineConfigService#history} javadoc 에 근거 전문이 있다): {@code created_at} 은
     * 나노초 0 일 때 소수부를 생략해 사전순이 뒤집히고, ULID 는 같은 밀리초 안에서 80bit 난수가 순서를
     * 정한다(= 연속 PUT 두 번이 같은 ms 에 들어가면 <b>롤백이 반반 확률로 무시된다</b>).
     * 여기서도 순서가 곧 동작이므로 "대체로 맞는" 정렬로는 부족하다.
     */
    public List<Row> history(int limit) {
        int capped = Math.max(1, Math.min(limit, 100));
        return jdbcClient.sql("""
                        SELECT r.id, r.overrides_json, r.reason, r.request_hash, r.created_at,
                               u.nickname AS actor
                        FROM growth_config_revisions r JOIN users u ON u.id = r.actor_user_id
                        ORDER BY r.seq DESC
                        LIMIT ?
                        """)
                .param(capped)
                .query((rs, n) -> new Row(rs.getString("id"), rs.getString("overrides_json"),
                        rs.getString("actor"), rs.getString("reason"), rs.getString("request_hash"),
                        rs.getString("created_at")))
                .list();
    }

    // ── 내부 ────────────────────────────────────────────────────────────

    private Current load() {
        return jdbcClient.sql("""
                        SELECT r.id, r.overrides_json, r.reason, r.request_hash, r.created_at,
                               u.nickname AS actor
                        FROM growth_config_revisions r JOIN users u ON u.id = r.actor_user_id
                        ORDER BY r.seq DESC
                        LIMIT 1
                        """)
                .query((rs, n) -> new Row(rs.getString("id"), rs.getString("overrides_json"),
                        rs.getString("actor"), rs.getString("reason"), rs.getString("request_hash"),
                        rs.getString("created_at")))
                .optional()
                .map(this::toCurrent)
                .orElseGet(Current::none);
    }

    private Optional<Row> findByIdem(String idemKey) {
        return jdbcClient.sql("""
                        SELECT r.id, r.overrides_json, r.reason, r.request_hash, r.created_at,
                               u.nickname AS actor
                        FROM growth_config_revisions r JOIN users u ON u.id = r.actor_user_id
                        WHERE r.idem_key = ?
                        """)
                .param(idemKey)
                .query((rs, n) -> new Row(rs.getString("id"), rs.getString("overrides_json"),
                        rs.getString("actor"), rs.getString("reason"), rs.getString("request_hash"),
                        rs.getString("created_at")))
                .optional();
    }

    private Current toCurrent(Row row) {
        return new Current(row.id(), row.overridesJson(), readOverrides(row.overridesJson()),
                row.actor(), row.reason(), row.createdAt());
    }

    /** 키를 정렬한 정본 JSON — 같은 내용이 항상 같은 바이트가 되어 diff·감사가 키 순서에 안 흔들린다. */
    private String canonicalJson(Map<String, Object> overrides) {
        try {
            return objectMapper.writeValueAsString(new TreeMap<>(overrides == null ? Map.of() : overrides));
        } catch (JsonProcessingException e) {
            throw ApiException.validation("overrides 직렬화에 실패했습니다: " + e.getMessage());
        }
    }

    private Map<String, Object> readOverrides(String json) {
        try {
            return objectMapper.readValue(json, new TypeReference<Map<String, Object>>() { });
        } catch (JsonProcessingException e) {
            // 원장에 든 값이 파싱 불가라는 것은 코드 결함이다 — 조용히 기본값으로 눕히지 않는다.
            throw new IllegalStateException("growth_config_revisions.overrides_json 파싱 실패: " + json, e);
        }
    }

    /** 오버레이를 JSON 트리로(화면·API 표시용). */
    public JsonNode overridesTree() {
        return objectMapper.valueToTree(current().overrides());
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    public record Row(String id, String overridesJson, String actor, String reason,
                      String requestHash, String createdAt) {
    }

    /** 지금 유효한 오버레이 + 출처. 출처가 없으면 운영이 "이 값이 어디서 왔나"를 확신할 수 없다. */
    public record Current(String revisionId, String overridesJson, Map<String, Object> overrides,
                          String actor, String reason, String createdAt) {

        public static Current none() {
            return new Current(null, "{}", Map.of(), null, null, null);
        }

        public boolean isEmpty() {
            return overrides == null || overrides.isEmpty();
        }
    }

    private record Resolved(EconomyService.Economy economy, String revisionId, GrowthTuning tuning) {
    }
}
