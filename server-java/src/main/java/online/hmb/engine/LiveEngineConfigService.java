package online.hmb.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.TreeMap;
import online.hmb.common.ApiException;
import org.springframework.http.HttpStatus;
import online.hmb.common.Ulid;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * <b>라이브 계수 오버레이</b>(#383) — 지금 서버가 "새 매치에 실어 보낼" `EngineConfig` 계수 오버레이.
 * 설계 SoT = {@code docs/plan-v5/live-engine-config.md}.
 *
 * <p><b>이 클래스가 하지 않는 것</b>이 중요하다:
 * <ul>
 *   <li><b>진행 중 매치를 건드리지 않는다.</b> 값은 매치 <b>생성 시점</b>에
 *       {@code matches.config_overrides_json} 으로 <b>복사</b>되고, 그 뒤로 그 매치는 자기 컬럼만
 *       읽는다. 이 서비스를 조회하는 코드 경로가 매치 진행 중에 하나도 없다 — 그게 #241
 *       (버전 범프 배포가 진행 중 매치를 FAILED 로 밀어낸 사건) 재발 방지를 규율이 아니라
 *       <b>구조</b>로 만드는 자리다.</li>
 *   <li><b>검증하지 않는다.</b> "이 값으로 경기가 성립하는가"는 엔진을 손에 든 러너만 답할 수 있다
 *       ({@code POST /config/validate}). 그 게이트는 admin 레이어가 통과시킨 뒤에 여기로 온다.</li>
 * </ul>
 *
 * <p><b>원장은 append-only</b>다. 매치가 리비전 id 로 근거를 가리키므로 행을 덮어쓰면 과거 매치의
 * 근거가 소급으로 바뀐다. 롤백 = 직전 내용을 <b>새 리비전으로 다시 쓰는 것</b>, 기본값 복귀 =
 * 빈 오버레이({@code {}}) 리비전.
 */
@Service
public class LiveEngineConfigService {

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;

    /**
     * 현재 리비전 캐시. 매치 생성 경로에서 매번 읽히므로 캐시하되, <b>권위는 DB</b>이고 쓰기 직후
     * 무효화한다({@code volatile} — 다중 스레드에서 즉시 보인다).
     * {@code null} = 아직 안 읽었다(= 다음 조회에서 DB 를 본다).
     */
    private volatile Current cached;

    public LiveEngineConfigService(JdbcClient jdbcClient, ObjectMapper objectMapper) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
    }

    /** 지금 유효한 오버레이. 리비전이 하나도 없으면 {@link Current#none()}. */
    public Current current() {
        Current snapshot = cached;
        if (snapshot == null) {
            snapshot = load();
            cached = snapshot;
        }
        return snapshot;
    }

    /**
     * 새 매치에 박을 스냅샷. <b>빈 오버레이는 "없음"과 같게 취급한다</b> — 러너에 빈 객체를 보내는
     * 것과 아무 것도 안 보내는 것은 결과가 같지만, 와이어에 키가 없는 편이 "이 기능 이전과 동일한
     * 요청"이라는 사실을 관측 가능하게 만든다(계약 {@code T-J8}).
     */
    public Pin pinForNewMatch() {
        Current c = current();
        if (c.isEmpty()) {
            // ⚠️ 오버레이는 null 이지만 <b>리비전 id 는 남긴다</b>(독립검증 m6). 둘 다 null 로 두면
            // "이 기능 이전에 만들어진 매치"와 "명시적 롤백 리비전 하에서 만들어진 매치"가 DB 에서
            // 구별되지 않는다 — 원장이 있는데 그 매치가 어느 리비전 아래 있었는지 답할 수 없게 된다.
            // 러너에 실리는 것은 오버레이뿐이라 와이어는 그대로다(T-J8 무영향).
            return new Pin(null, c.revisionId());
        }
        return new Pin(c.overridesJson(), c.revisionId());
    }

    /**
     * 리비전 append. <b>검증은 호출부(admin) 책임</b>이다.
     *
     * @param idemKey     null 이면 멱등 없음. 같은 키 + 같은 {@code requestHash} 는 기존 리비전을
     *                    그대로 돌려주고, 같은 키 + <b>다른</b> 내용은 409 다 — 멱등키는 "같은 의도의
     *                    재전송"을 뜻하므로, 내용이 다르면 그건 재전송이 아니라 사고다.
     * @param requestHash 요청 원문 해시. 멱등 판정의 <b>유일</b> 기준 — 필드를 하나씩 비교하면
     *                    빠뜨린 필드가 곧 구멍이다(#323 우편함이 두 번 뚫린 형태).
     */
    public synchronized Current recordRevision(String actorUserId, Map<String, Object> overrides,
                                               String effectiveHash, String reason,
                                               String idemKey, String requestHash) {
        if (idemKey != null && !idemKey.isBlank()) {
            Optional<Row> existing = findByIdem(idemKey);
            if (existing.isPresent()) {
                Row row = existing.get();
                if (!row.requestHash().equals(requestHash)) {
                    // 멱등키 충돌은 이 리포의 admin 관례대로 code=CONFLICT 다(#209·#323 과 동형).
                    throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                            "같은 Idempotency-Key 로 다른 내용이 왔습니다(키를 새로 발급하세요)");
                }
                return toCurrent(row);   // 같은 의도의 재전송 — 새 행을 만들지 않는다.
            }
        }

        String json = canonicalJson(overrides);
        String id = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO engine_config_revisions(id, overrides_json, effective_hash,
                                                            actor_user_id, reason, idem_key,
                                                            request_hash, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(id, json, effectiveHash, actorUserId, reason, idemKey, requestHash,
                        Instant.now().toString())
                .update();
        cached = null;   // 다음 조회가 DB 를 본다.
        return current();
    }

    /**
     * <b>"현재 값" 을 정하는 정렬 = 삽입 순서({@code seq})</b>.
     *
     * <p>다른 표들은 {@code created_at DESC, id DESC} 로 정렬하지만 그건 <b>표시 순서</b>라 동률이
     * 미관 문제로 끝난다. 여기서는 순서가 곧 <b>동작</b>이다 — 최신 행 하나가 다음 매치에 박히는
     * 값이다. 그래서 "대체로 맞는" 정렬로는 부족하다.
     *
     * <p>후보 둘 다 <b>동률에서 깨진다</b>:
     * <ul>
     *   <li>{@code created_at}: {@code Instant.now().toString()} 은 나노초가 0 이면 소수부를 생략해
     *       {@code …T12:00:00Z} 가 {@code …T12:00:00.400Z} 보다 사전순으로 <b>크다</b>(독립검증 m2).</li>
     *   <li>{@code id}(ULID): 48bit ms + <b>80bit 난수</b>라 <b>같은 밀리초 안에서는 난수가 순서를
     *       정한다</b>({@code Ulid.next()} 는 단조가 아니다). m2 수습이 여기로 옮겼다가 이 결함이
     *       3차 게이트에서 실제로 발화했다 — 연속 PUT 두 번이 같은 ms 에 들어가면 <b>롤백이 반반
     *       확률로 무시된다</b>. 테스트에서 재현된 그대로가 운영에서도 참이다.</li>
     * </ul>
     *
     * <p>그래서 이 표만 PK 가 {@code seq INTEGER PRIMARY KEY AUTOINCREMENT} 다(V37) — <b>재사용하지
     * 않는 단조 증가</b>를 스키마가 보장한다. SQLite {@code rowid} 로도 되지만 그건 문서화된 보장이
     * 아니라 구현 세부이고 {@code VACUUM} 이 재배치할 수 있다(독립검증 m10) — 장애 대응 중 손으로
     * VACUUM 을 치는 일은 충분히 있을 수 있다. 계약 =
     * {@code EngineConfigSnapshotTest.sameMillisecondRevisionsStillOrderByInsertion}.
     *
     * <p>최근 리비전 이력(누가·언제·왜·무엇을) — {@link #load()} 도 같은 정렬을 쓴다.
     */
    public List<Row> history(int limit) {
        int capped = Math.max(1, Math.min(limit, 100));
        return jdbcClient.sql("""
                        SELECT r.id, r.overrides_json, r.effective_hash, r.reason, r.request_hash,
                               r.created_at, u.nickname AS actor
                        FROM engine_config_revisions r JOIN users u ON u.id = r.actor_user_id
                        ORDER BY r.seq DESC
                        LIMIT ?
                        """)
                .param(capped)
                .query((rs, n) -> new Row(rs.getString("id"), rs.getString("overrides_json"),
                        rs.getString("effective_hash"), rs.getString("actor"), rs.getString("reason"),
                        rs.getString("request_hash"), rs.getString("created_at")))
                .list();
    }

    // ── 내부 ────────────────────────────────────────────────────────────

    /** 현재 = 마지막으로 삽입된 리비전. 정렬 근거는 {@link #history(int)} 의 주석. */
    private Current load() {
        return jdbcClient.sql("""
                        SELECT r.id, r.overrides_json, r.effective_hash, r.reason, r.request_hash,
                               r.created_at, u.nickname AS actor
                        FROM engine_config_revisions r JOIN users u ON u.id = r.actor_user_id
                        ORDER BY r.seq DESC
                        LIMIT 1
                        """)
                .query((rs, n) -> new Row(rs.getString("id"), rs.getString("overrides_json"),
                        rs.getString("effective_hash"), rs.getString("actor"), rs.getString("reason"),
                        rs.getString("request_hash"), rs.getString("created_at")))
                .optional()
                .map(this::toCurrent)
                .orElseGet(Current::none);
    }

    private Optional<Row> findByIdem(String idemKey) {
        return jdbcClient.sql("""
                        SELECT r.id, r.overrides_json, r.effective_hash, r.reason, r.request_hash,
                               r.created_at, u.nickname AS actor
                        FROM engine_config_revisions r JOIN users u ON u.id = r.actor_user_id
                        WHERE r.idem_key = ?
                        """)
                .param(idemKey)
                .query((rs, n) -> new Row(rs.getString("id"), rs.getString("overrides_json"),
                        rs.getString("effective_hash"), rs.getString("actor"), rs.getString("reason"),
                        rs.getString("request_hash"), rs.getString("created_at")))
                .optional();
    }

    private Current toCurrent(Row row) {
        return new Current(row.id(), row.overridesJson(), readJson(row.overridesJson()),
                row.effectiveHash(), row.actor(), row.reason(), row.createdAt());
    }

    /**
     * 키를 정렬한 정본 JSON. 해시·diff·감사가 요청의 키 순서에 흔들리지 않게 하는 조각이며,
     * 같은 내용이 항상 같은 바이트가 되어 "무엇이 바뀌었나"를 문자열 비교로 답할 수 있게 한다.
     */
    private String canonicalJson(Map<String, Object> overrides) {
        try {
            return objectMapper.writeValueAsString(new TreeMap<>(overrides == null ? Map.of() : overrides));
        } catch (JsonProcessingException e) {
            throw ApiException.validation("overrides 직렬화에 실패했습니다: " + e.getMessage());
        }
    }

    private JsonNode readJson(String json) {
        try {
            return objectMapper.readTree(json);
        } catch (JsonProcessingException e) {
            // 원장에 든 값이 파싱 불가라는 것은 코드 결함이다 — 조용히 기본값으로 눕히지 않는다.
            throw new IllegalStateException("engine_config_revisions.overrides_json 파싱 실패: " + json, e);
        }
    }

    // ── DTO ─────────────────────────────────────────────────────────────

    public record Row(String id, String overridesJson, String effectiveHash, String actor,
                      String reason, String requestHash, String createdAt) {
    }

    /** 지금 유효한 오버레이 + 출처. 출처가 없으면 운영이 "이 값이 어디서 왔나"를 확신할 수 없다. */
    public record Current(String revisionId, String overridesJson, JsonNode overrides,
                          String effectiveHash, String actor, String reason, String createdAt) {

        public static Current none() {
            return new Current(null, "{}", com.fasterxml.jackson.databind.node.JsonNodeFactory.instance
                    .objectNode(), null, null, null, null);
        }

        /** 오버레이가 실질적으로 없다 = 러너 기본값 그대로. */
        public boolean isEmpty() {
            return overrides == null || overrides.isEmpty();
        }
    }

    /** 매치에 박을 값. 둘 다 null = 오버레이 없음. */
    public record Pin(String overridesJson, String revisionId) {
    }
}
