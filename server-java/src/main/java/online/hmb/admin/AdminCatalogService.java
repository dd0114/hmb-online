package online.hmb.admin;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import online.hmb.common.TxRunner;
import online.hmb.common.Ulid;
import online.hmb.growth.GrowthService;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * 어드민 유닛 카탈로그(#207 파트 A) — <b>배포 없이</b> 유닛을 추가/수정/비활성화하고 <b>모든 변경을
 * 원장에 남긴다</b>.
 *
 * <p><b>왜 players 를 직접 고치는가</b>(오버레이 테이블이 아니라): 소비자
 * ({@code GachaService}·{@code TradeService}·{@code GrowthService}·{@code CatalogController}·
 * {@code LeagueService}·{@code MatchService}…)가 전부 {@code SELECT … FROM players} 를 한다.
 * 오버레이를 두면 그 5~6곳을 전부 병합 쿼리로 바꿔야 하고, 한 곳만 빠뜨려도 "어드민이 고쳤는데
 * 저기서만 옛날 값"이 된다. 대신 시드 재임포트에 덮이지 않게 {@code players.admin_locked} 를 세우는
 * 방식을 택했다(#207 웨이브1 §1.1 B안) — 소비자 코드는 <b>한 줄도 바뀌지 않는다</b>.
 *
 * <p><b>3중 트랜잭션</b>({@link AdminPointsService} 규약 계승): 변경 성공 시
 * ① {@code players} UPDATE/INSERT ② {@code admin_catalog_audit} INSERT ③ {@code admin_locked} 세팅이
 * <b>한 트랜잭션</b>이다. "값은 바뀌었는데 이력이 없다" 나 "이력은 있는데 값이 안 바뀌었다" 가 존재할 수 없고,
 * 특히 <b>잠금 없이 값만 바뀌면 다음 부팅에 조용히 되돌아간다</b>(운영자는 성공했다고 믿는데).
 *
 * <p><b>멱등</b>: {@code Idempotency-Key} 헤더는 선택. 같은 키 재전송 = 200 재생(감사 중복 0),
 * <b>같은 키 다른 내용 = 409</b>. 포인트 API 가 "같은 키 다른 금액"을 조용히 삼켜 운영 함정이 됐던
 * 실패를 그대로 따른다 — 여기서 "내용"은 <b>요청이 지정한 필드들</b>이고, 기록된 after 스냅샷의
 * 같은 필드와 비교한다. 헤더가 없으면 서버가 ULID 를 채번하며 그 요청은 재전송 보호를 받지 못한다
 * (응답의 {@code idempotencyKey} 로 관측 가능).
 *
 * <p><b>멱등 스코프</b>는 {@code (action, player_id, idem_key)} 다. 단 {@code unit_create} 만
 * {@code (action, idem_key)} 로 본다 — 생성은 <b>id 를 서버가 채번</b>하므로 대상별 스코프로는
 * 재전송을 식별할 수 없고, 그러면 같은 키로 재전송할 때마다 <b>새 유닛이 계속 생긴다</b>.
 *
 * <p><b>멱등은 사전조회가 아니라 DB 제약이 지킨다</b>(#207 blocker B1). 사전조회
 * ({@link #findAudit})는 check-then-act 라 <b>동시 요청을 나란히 통과시킨다</b> — 실측으로 같은 키
 * 10발 동시 POST 가 유닛 2개를 만들고 8건이 500 이었으며, 그 뒤 <b>순차</b> 요청까지 영구 500 이 됐다
 * (감사에 같은 키 2행이 남아 단일행 조회가 터졌다). 그래서 ① {@code V15} 부분 유니크 인덱스
 * {@code (action, idem_key) WHERE action='unit_create'} 를 <b>백스톱</b>으로 두고 ② 그 위반을
 * <b>재전송으로 재해석</b>해 승자의 감사행으로 재생/409 하며 ③ 사전조회는 단일행을 가정하지 않는다
 * (정렬 후 한 행). 사전조회는 이제 <b>빠른 경로</b>일 뿐 정확성의 근거가 아니다.
 *
 * <p><b>권한 검사 코드가 여기에도 컨트롤러에도 없다</b> — {@code /api/admin/} 접두사 +
 * {@link AdminInterceptor} + {@link AdminRouteGuard}(이 빈은 admin 전용 목록에 등록돼 있다)가 담당한다.
 */
@Service
public class AdminCatalogService {

    /** 감사 action 열거 — V14 의 CHECK 와 일치해야 한다. */
    public static final String ACTION_CREATE = "unit_create";
    public static final String ACTION_UPDATE = "unit_update";
    public static final String ACTION_DEACTIVATE = "unit_deactivate";
    public static final String ACTION_ACTIVATE = "unit_activate";
    public static final String ACTION_OVERRIDE_RESET = "unit_override_reset";

    private static final Set<String> ACTIONS = Set.of(ACTION_CREATE, ACTION_UPDATE,
            ACTION_DEACTIVATE, ACTION_ACTIVATE, ACTION_OVERRIDE_RESET);

    /** DB CHECK 와 동일한 허용값(계약 열거 — 튜닝값이 아니라 스키마 미러). */
    private static final List<String> POSITIONS = List.of("GK", "DF", "MF", "FW");
    private static final List<String> GRADES = List.of("BRONZE", "SILVER", "GOLD", "DIA", "LEGEND");
    private static final Set<String> PERSONALITIES = Set.of("FIERY", "CALM", "GLASS", "AMBITIOUS");

    /** shared PlayerAttributes 9종 — 순서 고정(스냅샷·export 안정). */
    private static final List<String> ATTR_KEYS = List.of(
            "technical", "mental", "physical", "passing", "shooting",
            "tackling", "pace", "stamina", "positioning");

    /** 어드민이 만든 행의 data_version 라벨 — 시드 버전과 구분된다(어디서 온 값인지 한눈에). */
    static final String ADMIN_DATA_VERSION = "admin";

    /** 생성이 기록하는 changedFields — 신규 행이므로 전 필드. 응답과 감사가 같은 값을 쓴다. */
    private static final List<String> CREATE_FIELDS =
            List.of("id", "name", "position", "grade", "attributes", "personality", "active");

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final ObjectMapper objectMapper;
    private final GrowthService growthService;

    private final int pageSizeDefault;
    private final int pageSizeMax;
    private final int auditRecentLimit;
    private final int reasonMaxChars;
    private final int nameMaxChars;
    private final String idPrefix;
    private final int idDigits;
    private final int attrMin;
    private final int attrMax;
    private final int createRetryMaxAttempts;
    private final long createRetryBackoffMs;

    public AdminCatalogService(JdbcClient jdbcClient,
                               TxRunner txRunner,
                               ObjectMapper objectMapper,
                               GrowthService growthService,
                               @Value("${hmb.admin.catalog.page-size-default}") int pageSizeDefault,
                               @Value("${hmb.admin.catalog.page-size-max}") int pageSizeMax,
                               @Value("${hmb.admin.catalog.audit-recent-limit}") int auditRecentLimit,
                               @Value("${hmb.admin.catalog.reason-max-chars}") int reasonMaxChars,
                               @Value("${hmb.admin.catalog.name-max-chars}") int nameMaxChars,
                               @Value("${hmb.admin.catalog.id-prefix}") String idPrefix,
                               @Value("${hmb.admin.catalog.id-digits}") int idDigits,
                               @Value("${hmb.admin.catalog.attr-min}") int attrMin,
                               @Value("${hmb.admin.catalog.attr-max}") int attrMax,
                               @Value("${hmb.admin.catalog.create-retry.max-attempts}") int createRetryMaxAttempts,
                               @Value("${hmb.admin.catalog.create-retry.backoff-ms}") long createRetryBackoffMs) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.objectMapper = objectMapper;
        this.growthService = growthService;
        this.pageSizeDefault = pageSizeDefault;
        this.pageSizeMax = pageSizeMax;
        this.auditRecentLimit = auditRecentLimit;
        this.reasonMaxChars = reasonMaxChars;
        this.nameMaxChars = nameMaxChars;
        this.idPrefix = idPrefix;
        this.idDigits = idDigits;
        this.attrMin = attrMin;
        this.attrMax = attrMax;
        this.createRetryMaxAttempts = Math.max(1, createRetryMaxAttempts);
        this.createRetryBackoffMs = Math.max(0, createRetryBackoffMs);
    }

    // ══════════════════════════ 조회 ══════════════════════════

    /** 목록 — q(id/이름 부분일치)·grade·position·active 필터 + 페이징. */
    public UnitPage list(String q, String grade, String position, Boolean active,
                         Integer limit, Integer offset) {
        int effLimit = clamp(limit == null ? pageSizeDefault : limit, 1, pageSizeMax);
        int effOffset = Math.max(0, offset == null ? 0 : offset);

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> params = new ArrayList<>();
        if (q != null && !q.isBlank()) {
            // LIKE 와일드카드를 리터럴로 — 검색어 '%' 하나로 전량 매칭되는 걸 막는다(AdminUserQueryService 규약).
            where.append(" AND (id LIKE ? ESCAPE '\\' OR name LIKE ? ESCAPE '\\')");
            String like = "%" + escapeLike(q.trim()) + "%";
            params.add(like);
            params.add(like);
        }
        if (grade != null && !grade.isBlank()) {
            where.append(" AND grade = ?");
            params.add(requireEnum(grade, GRADES, "grade"));
        }
        if (position != null && !position.isBlank()) {
            where.append(" AND position = ?");
            params.add(requireEnum(position, POSITIONS, "position"));
        }
        if (active != null) {
            where.append(" AND active = ?");
            params.add(active ? 1 : 0);
        }

        long total = jdbcClient.sql("SELECT COUNT(*) FROM players" + where)
                .params(params).query(Long.class).single();

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(effLimit);
        pageParams.add(effOffset);
        List<UnitRow> items = jdbcClient.sql(
                        "SELECT id, name, position, grade, attributes_json, personality, active,"
                                + " admin_locked, data_version FROM players" + where
                                + " ORDER BY id LIMIT ? OFFSET ?")
                .params(pageParams).query(this::mapUnit).list();

        return new UnitPage(items, total, effLimit, effOffset);
    }

    /** 상세 — 유닛 + 보유 규모(영향 범위) + 최근 감사 이력. */
    public UnitDetail detail(String playerId) {
        UnitRow unit = requireUnit(playerId);
        long ownerCount = jdbcClient.sql("SELECT COUNT(*) FROM user_players WHERE player_id = ?")
                .param(playerId).query(Long.class).single();
        long ownedTotal = jdbcClient.sql("SELECT COALESCE(SUM(count), 0) FROM user_players WHERE player_id = ?")
                .param(playerId).query(Long.class).single();
        List<AuditRow> recent = auditPage(playerId, null, null, null, null, auditRecentLimit, 0).items();
        return new UnitDetail(unit, new Holdings(ownerCount, ownedTotal), recent);
    }

    /** 감사 이력 조회 — playerId·actor·action·기간 필터. */
    public AuditPage auditPage(String playerId, String actorUserId, String action,
                               String from, String to, Integer limit, Integer offset) {
        int effLimit = clamp(limit == null ? pageSizeDefault : limit, 1, pageSizeMax);
        int effOffset = Math.max(0, offset == null ? 0 : offset);

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> params = new ArrayList<>();
        if (playerId != null && !playerId.isBlank()) {
            where.append(" AND player_id = ?");
            params.add(playerId.trim());
        }
        if (actorUserId != null && !actorUserId.isBlank()) {
            where.append(" AND actor_user_id = ?");
            params.add(actorUserId.trim());
        }
        if (action != null && !action.isBlank()) {
            if (!ACTIONS.contains(action.trim())) {
                throw ApiException.validation("알 수 없는 action 입니다: " + action);
            }
            where.append(" AND action = ?");
            params.add(action.trim());
        }
        // created_at 은 Instant.toString() (ISO-8601 UTC) 이라 문자열 비교가 곧 시간 비교다.
        if (from != null && !from.isBlank()) {
            where.append(" AND created_at >= ?");
            params.add(from.trim());
        }
        if (to != null && !to.isBlank()) {
            where.append(" AND created_at <= ?");
            params.add(to.trim());
        }

        long total = jdbcClient.sql("SELECT COUNT(*) FROM admin_catalog_audit" + where)
                .params(params).query(Long.class).single();

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(effLimit);
        pageParams.add(effOffset);
        List<AuditRow> items = jdbcClient.sql(
                        "SELECT id, actor_user_id, player_id, action, before_json, after_json,"
                                + " changed_fields, reason, idem_key, created_at FROM admin_catalog_audit"
                                + where + " ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?")
                .params(pageParams).query(this::mapAudit).list();

        return new AuditPage(items, total, effLimit, effOffset);
    }

    /**
     * 현재 카탈로그를 <b>시드 발행 포맷</b>으로 덤프한다(#207 웨이브1 §1.2).
     *
     * <p>이게 없으면 개편은 <b>그 DB 한 대에만 산다</b> — 새 배포나 테스터 DB 리셋 시 개편 전 상태로
     * 부팅한다(drift). 운영 흐름 = 어드민 API 로 확정 → export → data 도메인이 다음 시드 버전으로
     * 승격 → 커밋. 그래서 키 순서와 형태를 {@code players.v2.1.json} 과 <b>정확히</b> 맞춘다
     * (최상위 배열, {@code id,name,position,grade,attributes,personality}) — 뒤에 {@code active} 만
     * 덧붙인다(additive: 구 소비자는 무시하고, 우리 임포터는 왕복시킨다).
     */
    public List<Map<String, Object>> export() {
        List<UnitRow> rows = jdbcClient.sql(
                        "SELECT id, name, position, grade, attributes_json, personality, active,"
                                + " admin_locked, data_version FROM players ORDER BY id")
                .query(this::mapUnit).list();
        List<Map<String, Object>> out = new ArrayList<>(rows.size());
        for (UnitRow r : rows) {
            Map<String, Object> m = new LinkedHashMap<>();
            m.put("id", r.id());
            m.put("name", r.name());
            m.put("position", r.position());
            m.put("grade", r.grade());
            m.put("attributes", r.attributes());
            m.put("personality", r.personality());
            m.put("active", r.active());
            out.add(m);
        }
        return out;
    }

    // ══════════════════════════ 변경 ══════════════════════════

    /**
     * 신규 유닛 추가 — id 는 서버가 채번(기존 최대 P번호 + 1).
     *
     * <p><b>동시 요청 계약</b>(#207 blocker B1): 같은 {@code Idempotency-Key} 로 N발이 동시에 와도
     * <b>유닛은 정확히 1개</b> 생기고 나머지는 <b>200 재생</b>(내용이 같을 때) 또는 <b>409</b>(내용이
     * 다를 때)다 — 순차 재전송과 <b>동일한</b> 응답이다. 500 은 정의상 나오지 않는다.
     *
     * <p>왜 200 재생인가(전부 409 로 떨어뜨리지 않고): 멱등키의 계약은 "같은 키 = 같은 요청"이고,
     * 클라이언트는 자기 요청이 <b>동시에 중복 전송됐는지</b>를 알 수 없다(재시도·더블클릭·프록시 재전송이
     * 다 같은 모양이다). 동시일 때만 409 를 주면 <b>같은 입력이 타이밍에 따라 다른 상태코드</b>를 내는
     * 셈이라, 클라이언트가 "409 = 내가 뭘 잘못했다"로 오해하고 <b>새 키로 다시 보낸다</b> — 그러면
     * 유닛이 하나 더 생긴다. 여기서 409 는 <b>내용이 다를 때</b>만 쓰는 신호로 남겨 둔다(운영 함정 경고).
     */
    public MutationResult create(String actorUserId, CreateRequest req, String idemKeyHeader) {
        if (req == null) {
            throw ApiException.validation("요청 본문이 필요합니다");
        }
        String reason = requireReason(req.reason());
        String name = requireName(req.name());
        String position = requireEnum(req.position(), POSITIONS, "position");
        String grade = requireEnum(req.grade(), GRADES, "grade");
        String personality = req.personality() == null || req.personality().isBlank()
                ? "CALM" : requireEnum(req.personality(), PERSONALITIES, "personality");
        Map<String, Integer> attributes = requireFullAttributes(req.attributes());
        boolean active = req.active() == null || req.active();
        String idemKey = effectiveIdemKey(idemKeyHeader);

        // 요청이 주장하는 내용 — 재전송 판정(같으면 재생, 다르면 409)의 비교 대상.
        Map<String, Object> requested = Map.of(
                "name", name, "position", position, "grade", grade,
                "personality", personality, "attributes", attributes, "active", active);

        // 생성 재전송 판정은 **대상 무관**(id 를 아직 모른다) — 클래스 주석 참조.
        // ⚠️ 이건 **빠른 경로**일 뿐이다. 경합을 막는 건 아래 트랜잭션 안의 V15 유니크 인덱스다.
        Optional<AuditRow> prior = findAudit(ACTION_CREATE, null, idemKeyHeader);
        if (prior.isPresent()) {
            return replayOrConflict(prior.get(), requested);
        }

        return createWithContention(actorUserId, name, position, grade, personality, attributes,
                active, reason, idemKey, idemKeyHeader, requested);
    }

    /**
     * 생성 트랜잭션 + <b>경합 해소</b>. 트랜잭션 안에서 UNIQUE 위반이 나면 두 가지 뜻 중 하나다.
     *
     * <ul>
     *   <li><b>V15 멱등 인덱스</b> 위반 = 같은 키의 다른 요청이 먼저 커밋했다 → 이건 실패가 아니라
     *       <b>재전송</b>이다. 내 트랜잭션은 통째로 롤백됐으므로(유닛도 감사도 안 남는다) 승자의
     *       감사행을 읽어 순차 재전송과 <b>똑같이</b> 재생/409 한다.</li>
     *   <li><b>players PK</b> 위반 = 두 요청이 같은 번호를 잡았다(키가 서로 다른 동시 생성).
     *       {@link #insertWithNextId} 가 채번과 INSERT 를 한 문장으로 합쳐 <b>정상 경로에서는 더 이상
     *       일어나지 않지만</b>, 일어난다면 그건 진짜 경합이고 <b>재시도하면 해소된다</b> —
     *       롤백 후 다시 읽으면 승자가 이미 커밋해 다음 번호가 나온다. 운영자가 의도한 건
     *       "유닛 2개"이므로 여기서 409 로 떨어뜨리는 건 오답이다.</li>
     * </ul>
     *
     * <p>둘의 구분은 "지금 이 키로 커밋된 감사행이 있나"로 한다(있으면 멱등, 없으면 번호 경합).
     * 상태 추측이 아니라 <b>커밋된 사실</b>로 가른다.
     *
     * <p>{@code SQLITE_BUSY} 도 같은 루프가 흡수한다({@code TradeService} #152 와 동일 사유):
     * WAL 에서 읽기로 시작한 트랜잭션이 쓰기로 승격할 때 그 사이 다른 커넥션이 커밋했으면
     * {@code SQLITE_BUSY_SNAPSHOT} 이 {@code busy_timeout} 을 무시하고 즉시 난다 — 기다림이 아니라
     * <b>트랜잭션 통째 재시도</b>만이 해법이라 재시도는 반드시 {@code txRunner.run} 바깥에 있다.
     *
     * <p>횟수를 소진하면 5xx 가 아니라 <b>409</b> 로 내린다 — 운영자가 재시도하면 되는 상황이지
     * 서버 고장이 아니다. 횟수·백오프는 config({@code hmb.admin.catalog.create-retry.*}).
     */
    private MutationResult createWithContention(String actorUserId, String name, String position,
                                                String grade, String personality,
                                                Map<String, Integer> attributes, boolean active,
                                                String reason, String idemKey, String idemKeyHeader,
                                                Map<String, Object> requested) {
        for (int attempt = 1; ; attempt++) {
            try {
                return txRunner.run(() -> {
                    String newId = insertWithNextId(name, position, grade, attributes, personality, active);
                    UnitRow after = requireUnit(newId);
                    String auditId = writeAudit(actorUserId, newId, ACTION_CREATE, null, after,
                            CREATE_FIELDS, reason, idemKey);
                    return new MutationResult(after, true, idemKey, auditId, CREATE_FIELDS, null);
                });
            } catch (DataAccessException e) {
                boolean unique = SqliteErrors.isUniqueViolation(e);
                if (unique) {
                    // 멱등 백스톱이 걸린 경우 — 승자가 이미 커밋돼 있으므로 반드시 보인다.
                    Optional<AuditRow> winner = findAudit(ACTION_CREATE, null, idemKeyHeader);
                    if (winner.isPresent()) {
                        return replayOrConflict(winner.get(), requested);
                    }
                }
                if (!unique && !SqliteErrors.isBusy(e)) {
                    throw e;
                }
                if (attempt >= createRetryMaxAttempts) {
                    throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                            "생성 요청이 동시에 몰려 처리하지 못했습니다 — 같은 Idempotency-Key 로 다시 시도하세요");
                }
                sleepQuietly(createRetryBackoffMs * attempt); // 선형 백오프
            }
        }
    }

    private static void sleepQuietly(long millis) {
        if (millis <= 0) {
            return;
        }
        try {
            Thread.sleep(millis);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * 부분 수정. <b>등급 하향은 영향 사전고지 가드</b>(#207 §1.6-1)를 통과해야 한다 —
     * {@code confirmImpact:true} 가 없으면 409 로 거절하고 영향 규모를 응답 detail 에 담는다.
     *
     * <p>{@code attributes} 는 <b>키 단위 병합</b>이다(전체 교체가 아니라). 운영자가 스탯 하나만
     * 고치려고 9개를 전부 다시 적어야 하면 나머지 8개를 옮겨 적다가 틀린다 — 그게 더 큰 사고다.
     */
    public MutationResult update(String actorUserId, String playerId, PatchRequest req, String idemKeyHeader) {
        if (req == null) {
            throw ApiException.validation("요청 본문이 필요합니다");
        }
        String reason = requireReason(req.reason());
        UnitRow before = requireUnit(playerId);

        Map<String, Object> requested = new LinkedHashMap<>();
        String name = before.name();
        if (req.name() != null) {
            name = requireName(req.name());
            requested.put("name", name);
        }
        String position = before.position();
        if (req.position() != null) {
            position = requireEnum(req.position(), POSITIONS, "position");
            requested.put("position", position);
        }
        String grade = before.grade();
        if (req.grade() != null) {
            grade = requireEnum(req.grade(), GRADES, "grade");
            requested.put("grade", grade);
        }
        String personality = before.personality();
        if (req.personality() != null) {
            personality = requireEnum(req.personality(), PERSONALITIES, "personality");
            requested.put("personality", personality);
        }
        Map<String, Integer> attributes = new LinkedHashMap<>(before.attributes());
        if (req.attributes() != null) {
            attributes.putAll(requirePartialAttributes(req.attributes()));
            requested.put("attributes", attributes);
        }
        boolean active = before.active();
        if (req.active() != null) {
            active = req.active();
            requested.put("active", active);
        }
        if (requested.isEmpty()) {
            throw ApiException.validation("변경할 필드가 하나도 없습니다");
        }

        Optional<AuditRow> prior = findAudit(ACTION_UPDATE, playerId, idemKeyHeader);
        if (prior.isPresent()) {
            return replayOrConflict(prior.get(), requested);
        }

        // ── 등급 하향 가드 ──
        GrowthService.GradeChangeImpact impact = null;
        if (!grade.equals(before.grade())) {
            impact = growthService.gradeChangeImpact(playerId, grade);
            boolean downgrade = GRADES.indexOf(grade) < GRADES.indexOf(before.grade());
            if (downgrade && !Boolean.TRUE.equals(req.confirmImpact())) {
                throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                        "등급 하향은 기보유 카드의 유효스탯을 깎습니다(보유 " + impact.affectedUsers() + "명, "
                                + "평균 OVR " + impact.avgOvrDelta() + ", 최대 손실 " + impact.worstOvrDelta()
                                + "). 실행하려면 confirmImpact:true 를 함께 보내세요",
                        impactDetail(impact));
            }
        }

        final String fName = name;
        final String fPosition = position;
        final String fGrade = grade;
        final String fPersonality = personality;
        final Map<String, Integer> fAttributes = attributes;
        final boolean fActive = active;
        final GrowthService.GradeChangeImpact fImpact = impact;
        final String idemKey = effectiveIdemKey(idemKeyHeader);

        return txRunner.run(() -> {
            jdbcClient.sql("""
                            UPDATE players SET name = ?, position = ?, grade = ?, attributes_json = ?,
                                               personality = ?, active = ?, admin_locked = 1
                            WHERE id = ?
                            """)
                    .params(fName, fPosition, fGrade, writeJson(fAttributes), fPersonality,
                            fActive ? 1 : 0, playerId)
                    .update();
            UnitRow after = requireUnit(playerId);
            List<String> changed = diffFields(before, after);
            String auditId = writeAudit(actorUserId, playerId, ACTION_UPDATE, before, after,
                    changed, reason, idemKey);
            return new MutationResult(after, true, idemKey, auditId, changed, fImpact);
        });
    }

    /**
     * 활성/비활성 토글. 액션을 {@code unit_activate}/{@code unit_deactivate} 로 <b>분리</b>해
     * 기록한다 — 이력에서 "언제 뺐고 언제 되돌렸나"가 필드 diff 를 펼치지 않아도 읽힌다.
     *
     * <p>비활성은 <b>신규 획득 경로에서만</b> 뺀다(가챠 풀·트레이드 타깃·도감 미보유분).
     * 이미 가진 카드는 그대로다 — 덱에 편성돼 있어도 경기가 정상 동작한다(계약으로 박제됨).
     */
    public MutationResult setActive(String actorUserId, String playerId, boolean active,
                                    String rawReason, String idemKeyHeader) {
        String reason = requireReason(rawReason);
        UnitRow before = requireUnit(playerId);
        String action = active ? ACTION_ACTIVATE : ACTION_DEACTIVATE;

        Optional<AuditRow> prior = findAudit(action, playerId, idemKeyHeader);
        if (prior.isPresent()) {
            return replayOrConflict(prior.get(), Map.of("active", active));
        }

        String idemKey = effectiveIdemKey(idemKeyHeader);
        return txRunner.run(() -> {
            jdbcClient.sql("UPDATE players SET active = ?, admin_locked = 1 WHERE id = ?")
                    .params(active ? 1 : 0, playerId).update();
            UnitRow after = requireUnit(playerId);
            List<String> changed = diffFields(before, after);
            String auditId = writeAudit(actorUserId, playerId, action, before, after, changed, reason, idemKey);
            return new MutationResult(after, true, idemKey, auditId, changed, null);
        });
    }

    /**
     * 시드 권위로 복원 — {@code admin_locked=0}. <b>값을 되돌리지는 않는다</b>: 다음 부팅의 시드
     * 임포트가 이 행을 다시 덮게 허용할 뿐이다(그게 "시드가 권위"의 의미다). 지금 당장 값이
     * 바뀌길 원하면 PATCH 를 쓴다.
     */
    public MutationResult resetOverride(String actorUserId, String playerId, String rawReason,
                                        String idemKeyHeader) {
        String reason = requireReason(rawReason);
        UnitRow before = requireUnit(playerId);

        Optional<AuditRow> prior = findAudit(ACTION_OVERRIDE_RESET, playerId, idemKeyHeader);
        if (prior.isPresent()) {
            return replayOrConflict(prior.get(), Map.of("adminLocked", false));
        }

        String idemKey = effectiveIdemKey(idemKeyHeader);
        return txRunner.run(() -> {
            jdbcClient.sql("UPDATE players SET admin_locked = 0 WHERE id = ?").param(playerId).update();
            UnitRow after = requireUnit(playerId);
            List<String> changed = diffFields(before, after);
            String auditId = writeAudit(actorUserId, playerId, ACTION_OVERRIDE_RESET, before, after,
                    changed, reason, idemKey);
            return new MutationResult(after, true, idemKey, auditId, changed, null);
        });
    }

    /**
     * <b>유닛 회수</b>(#210) — 잘못 만든 유닛을 카탈로그에서 지우고 P-번호를 비운다.
     *
     * <p><b>왜 필요한가</b>: 오타·잘못된 스탯·잘못된 등급으로 만든 유닛을 되돌릴 방법이
     * {@code deactivate} 뿐이었다. 비활성 유닛은 획득 경로에서만 빠질 뿐 <b>카탈로그에 영원히 남고
     * P-공간을 점유</b>한다. 만든 지 1분 된 실수를 지우는 수단이 수동 DB 개입뿐이었다.
     *
     * <p><b>왜 거의 항상 거부되는가(그리고 그게 옳은가)</b>: {@code players(id)} 를 FK 로 참조하는
     * 표가 <b>여덟</b>이다({@link #REFERENCING_TABLES}). 누군가 한 번이라도 뽑았으면 {@code user_players}
     * 가 가리키고, 그 행을 지우면 <b>유저의 카드가 사라진다</b>. 그래서 참조가 하나라도 있으면
     * <b>409</b> 이고 응답에 어느 표가 몇 건인지 싣는다 — 운영자가 "왜 안 지워지나"에 스스로 답할 수 있게.
     * 실질 적용 범위는 <b>방금 만들어 아무도 손대지 않은 유닛</b>이고, 그게 #210 이 말한 바로 그 경우다.
     *
     * <p><b>감사 이력은 남는다</b>: {@code admin_catalog_audit.player_id} 에는 FK 가 없다(V14 가
     * "삭제·미존재 유닛의 이력도 보존해야 한다"고 명시적으로 그렇게 설계했다). 그래서 지운 뒤에도
     * "이 번호에 무슨 일이 있었나"가 원장에 남는다.
     *
     * <p>⚠️ <b>회수 기록은 {@code admin_ops_audit}(V18) 에 남긴다</b>, {@code admin_catalog_audit} 이
     * 아니라. 후자의 {@code action} 에는 CHECK 제약이 있어 값을 늘리려면 <b>감사 테이블을 통째로
     * 재작성</b>해야 하는데, 이력 원장을 재작성하는 마이그레이션은 이 기능이 감수할 위험이 아니다.
     * V18 은 주석에서 스스로 "다른 도메인도 자기 action 을 append 하면 된다"고 열어 둔 범용 원장이다.
     * <b>대가</b>: 한 유닛의 이력이 두 원장에 나뉜다(생성·수정 = 카탈로그 원장, 회수 = 운영 원장).
     */
    public PurgeResult purge(String actorUserId, String playerId, String rawReason) {
        String reason = requireReason(rawReason);
        UnitRow before = requireUnit(playerId);

        return txRunner.run(() -> {
            // ⚠️ 조회와 삭제가 **한 트랜잭션**이다. 밖에서 세면 "0건 확인 → 그 사이 누군가 뽑음 →
            //    삭제"가 가능하고, 그때 지워지는 것은 유저의 카드다.
            Map<String, Integer> refs = new LinkedHashMap<>();
            for (Map.Entry<String, String> t : REFERENCING_TABLES.entrySet()) {
                int n = jdbcClient.sql("SELECT COUNT(*) FROM " + t.getKey() + " WHERE " + t.getValue())
                        .params(playerId, playerId)
                        .query(Integer.class).single();
                if (n > 0) {
                    refs.put(t.getKey(), n);
                }
            }
            if (!refs.isEmpty()) {
                opsAudit(actorUserId, ACTION_PURGE, "failed", reason,
                        Map.of("playerId", playerId, "blockedBy", refs));
                throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                        "이미 사용 중인 유닛이라 회수할 수 없습니다 — 비활성화(deactivate)를 쓰세요",
                        Map.of("playerId", playerId, "references", refs));
            }
            jdbcClient.sql("DELETE FROM players WHERE id = ?").param(playerId).update();
            opsAudit(actorUserId, ACTION_PURGE, "ok", reason,
                    Map.of("playerId", playerId, "before", snapshot(before)));
            return new PurgeResult(playerId, before.name(), refs);
        });
    }

    /**
     * {@code players(id)} 를 FK 로 참조하는 표 전부(스키마에서 실사). 값은 WHERE 절이고 파라미터를
     * <b>두 개</b> 받는다 — 참조 컬럼이 둘인 표({@code trade_slots})가 있어 형태를 통일했다.
     *
     * <p>⚠️ <b>새 표가 {@code players} 를 참조하면 여기에 추가해라.</b> 빠뜨리면 회수가 그 참조를
     * 못 보고 지워서 FK 위반으로 죽거나(운이 좋은 경우) 데이터가 끊긴다. 계약이 이 목록을
     * 스키마와 대조한다({@code AdminUnitPurgeTest.referencingTablesListMatchesTheSchema}).
     */
    public static final Map<String, String> REFERENCING_TABLES = Map.of(
            "user_players", "player_id = ? AND ? IS NOT NULL",
            "deck_slots", "player_id = ? AND ? IS NOT NULL",
            "gacha_results", "player_id = ? AND ? IS NOT NULL",
            "player_relations", "player_id = ? AND ? IS NOT NULL",
            "growth_applied", "player_id = ? AND ? IS NOT NULL",
            "card_potentials", "player_id = ? AND ? IS NOT NULL",
            "dice_rolls", "player_id = ? AND ? IS NOT NULL",
            "trade_slots", "target_player_id = ? OR demand_player_id = ?");

    public static final String ACTION_PURGE = "unit_purge";

    /** V18 범용 원장에 남기는 회수 기록(위 주석의 근거 참조). */
    private void opsAudit(String actorUserId, String action, String result, String reason,
                          Map<String, Object> detail) {
        jdbcClient.sql("""
                        INSERT INTO admin_ops_audit(id, actor_user_id, action, result, reason, detail_json, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(Ulid.next(), actorUserId, action, result, reason, writeJson(detail),
                        // 이 클래스의 기존 감사(writeAudit)와 **같은 시각 소스**를 쓴다 —
                        // 한 클래스가 두 시계를 쓰면 같은 트랜잭션의 두 원장 행이 어긋난 시각을 갖는다.
                        Instant.now().toString())
                .update();
    }

    /** 회수 결과 — 지운 유닛과, (거부됐다면) 무엇이 막았는지. */
    public record PurgeResult(String playerId, String name, Map<String, Integer> references) {
    }

    // ══════════════════════════ 내부 ══════════════════════════

    /**
     * 새 유닛을 INSERT 하고 <b>서버가 채번한 id</b>({@code P###} = 기존 최대 번호 + 1)를 돌려준다.
     *
     * <p><b>기존 번호를 재사용하지 않는다</b>: {@code user_players.player_id} 가 그 id 를 가리키므로
     * 재사용하면 <b>기보유 유저의 카드가 다른 선수로 바뀐다</b>(이력도 뒤섞인다).
     *
     * <p><b>채번이 Java 가 아니라 SQL 안에 있는 이유</b>(#207 blocker B1 — 여기 있던
     * {@code nextPlayerId()} 를 이 형태로 대체했다). 예전엔 {@code SELECT MAX(...)} 로 번호를 읽고
     * 별도 {@code INSERT} 로 썼다. 그 사이가 <b>비어 있어서</b> 두 요청이 같은 번호를 잡을 수 있었고,
     * 더 나쁘게는 WAL 에서 <b>읽기로 시작한 트랜잭션이 쓰기로 승격</b>하는 모양이라
     * {@code SQLITE_BUSY_SNAPSHOT}(busy_timeout 을 무시하고 즉시 실패) 에 그대로 노출됐다 —
     * 실측으로 10발 동시 생성 중 일부가 재시도를 소진해 거절됐다.
     *
     * <p>지금은 읽기와 쓰기가 <b>한 문장</b>이고 그게 트랜잭션의 <b>첫</b> 문장이라, SQLite 가 처음부터
     * 쓰기 잠금을 잡고 최신 상태를 읽는다: 낡은 스냅샷이 없으니 승격 실패가 없고, 다른 쓰기는
     * {@code busy_timeout} 으로 줄을 선다. <b>번호 경합 자체가 사라진다</b>(재시도로 덮는 게 아니라).
     *
     * <p>옛 주석의 "동시 생성 경합은 PK UNIQUE 위반 → 409" 는 <b>사실이 아니었다</b>: id 를 서버가
     * 채번하므로 같은 키의 재전송끼리도 서로 다른 번호(P182 ≠ P183)를 잡아 PK 는 충돌하지 않았고,
     * 그래서 유닛이 2개 생기고 응답은 409 가 아니라 500 이었다. 같은 키의 중복은 이제
     * {@code V15} 부분 유니크 인덱스가 <b>감사 INSERT 단계에서</b> 막고,
     * {@link #createWithContention} 이 그 위반을 <b>재전송으로</b> 재해석한다.
     *
     * <p>{@code LIKE prefix||'%'} + {@code CAST} 는 접두가 같은 행만 본다(봇 id 등 다른 네임스페이스
     * 제외). 숫자가 아닌 꼬리는 {@code CAST} 가 0/부분값으로 접는데, 그래도 {@code MAX} 는
     * 정상 번호들이 지배하므로 결과가 낮아지지 않는다. 만에 하나 충돌하면 PK 가 잡고 재시도한다.
     */
    private String insertWithNextId(String name, String position, String grade,
                                    Map<String, Integer> attributes, String personality, boolean active) {
        jdbcClient.sql("""
                        INSERT INTO players(id, name, position, grade, attributes_json, data_version,
                                            personality, active, admin_locked)
                        SELECT printf(?, COALESCE(MAX(CAST(SUBSTR(id, ?) AS INTEGER)), 0) + 1),
                               ?, ?, ?, ?, ?, ?, ?, 1
                          FROM players WHERE id LIKE ?
                        """)
                .params(idFormat(), idPrefix.length() + 1, name, position, grade, writeJson(attributes),
                        ADMIN_DATA_VERSION, personality, active ? 1 : 0, idPrefix + "%")
                .update();
        // players 는 rowid 테이블(TEXT PK)이라 방금 쓴 행을 rowid 로 되찾을 수 있다 —
        // 채번을 SQL 이 했으므로 Java 는 결과를 '읽어서' 알아야 한다(다시 계산하면 경합이 되살아난다).
        return jdbcClient.sql("SELECT id FROM players WHERE rowid = last_insert_rowid()")
                .query(String.class).single();
    }

    /** SQLite {@code printf} 포맷 — config 의 접두/자릿수로 조립("P" + 3 → {@code P%03d}). */
    private String idFormat() {
        return idPrefix.replace("%", "%%") + String.format(Locale.ROOT, "%%0%dd", idDigits);
    }

    /**
     * 같은 멱등키의 선행 기록과 <b>요청 내용</b>을 대조한다. 같으면 200 재생(부수효과 0),
     * 다르면 409. 비교 대상은 요청이 <b>지정한 필드</b>뿐 — 지정하지 않은 필드는 의도가 없으므로
     * 비교하지 않는다. {@code reason} 도 비교하지 않는다(운영 메모의 오타 수정 재전송을 막게 된다).
     */
    private MutationResult replayOrConflict(AuditRow prior, Map<String, Object> requested) {
        Map<String, Object> after = prior.after();
        for (Map.Entry<String, Object> e : requested.entrySet()) {
            Object recorded = normalizeForCompare(after.get(e.getKey()));
            Object incoming = normalizeForCompare(e.getValue());
            if (!Objects.equals(recorded, incoming)) {
                throw new ApiException(HttpStatus.CONFLICT, "CONFLICT",
                        "이 Idempotency-Key 는 이미 다른 내용으로 사용됐습니다(필드 '" + e.getKey()
                                + "' 기록값 " + recorded + " ≠ 요청값 " + incoming
                                + "). 내용을 정정하려면 새 Idempotency-Key 로 요청하세요");
            }
        }
        UnitRow current = unit(prior.playerId()).orElse(null);
        return new MutationResult(current, false, prior.idemKey(), prior.id(),
                prior.changedFields(), null);
    }

    /** JSON 왕복으로 타입이 흔들리는 것(Integer↔Long, Boolean↔"true")을 흡수해 값만 비교한다. */
    private Object normalizeForCompare(Object v) {
        if (v instanceof Number n) {
            return n.longValue();
        }
        if (v instanceof Map<?, ?> m) {
            Map<String, Object> out = new LinkedHashMap<>();
            m.forEach((k, val) -> out.put(String.valueOf(k), normalizeForCompare(val)));
            return out;
        }
        return v;
    }

    /**
     * 같은 멱등키의 <b>선행</b> 감사행 — 있으면 그 요청은 재전송이다.
     *
     * <p><b>단일행을 가정하지 않는다</b>(#207 blocker B1). 예전엔 {@code .optional()} 만 붙어 있어
     * 같은 키에 2행이 있으면 {@code IncorrectResultSizeDataAccessException} 이 터졌다 — 한 번 경합을
     * 겪은 DB 에서는 <b>그 키가 영원히 500</b> 이 됐다(순차 요청까지). {@code V15} 인덱스가 새 중복을
     * 막지만, <b>이미 오염된 DB 가 스스로 복구되는 것</b>은 별개 문제다: 마이그레이션이 정리하기 전이거나
     * 정리 대상이 아닌 액션에서도 이 조회는 무너지면 안 된다. 그래서 정렬 후 <b>한 행만</b> 집는다.
     *
     * <p>정렬 키는 {@code (created_at, id)} = <b>최초 성공분</b>이다. {@code V15} 의 정리 UPDATE 가
     * 승자를 고르는 정렬과 <b>동일</b>해서, 정리 전이든 후든 같은 행이 재생된다(둘이 어긋나면
     * 마이그레이션 전후로 재전송 응답이 바뀐다). {@code id} 는 ULID(시간순 단조)라 동시각에도 안정적이다.
     */
    private Optional<AuditRow> findAudit(String action, String playerId, String idemKeyHeader) {
        if (idemKeyHeader == null || idemKeyHeader.isBlank()) {
            return Optional.empty();
        }
        String key = idemKeyHeader.trim();
        String sql = "SELECT id, actor_user_id, player_id, action, before_json, after_json,"
                + " changed_fields, reason, idem_key, created_at FROM admin_catalog_audit"
                + " WHERE action = ? AND idem_key = ?"
                + (playerId == null ? "" : " AND player_id = ?")
                + " ORDER BY created_at, id LIMIT 1";
        var spec = playerId == null
                ? jdbcClient.sql(sql).params(action, key)
                : jdbcClient.sql(sql).params(action, key, playerId);
        return spec.query(this::mapAudit).optional();
    }

    private String writeAudit(String actorUserId, String playerId, String action,
                              UnitRow before, UnitRow after, List<String> changedFields,
                              String reason, String idemKey) {
        String auditId = Ulid.next();
        jdbcClient.sql("""
                        INSERT INTO admin_catalog_audit(id, actor_user_id, player_id, action, before_json,
                                                        after_json, changed_fields, reason, idem_key, created_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """)
                .params(auditId, actorUserId, playerId, action,
                        before == null ? null : writeJson(snapshot(before)),
                        after == null ? null : writeJson(snapshot(after)),
                        String.join(",", changedFields), reason, idemKey, Instant.now().toString())
                .update();
        return auditId;
    }

    /** 감사 스냅샷 형태 — 유닛의 <b>전체</b> 상태(§1.4: diff 가 아니라 스냅샷). */
    private Map<String, Object> snapshot(UnitRow u) {
        Map<String, Object> m = new LinkedHashMap<>();
        m.put("id", u.id());
        m.put("name", u.name());
        m.put("position", u.position());
        m.put("grade", u.grade());
        m.put("attributes", u.attributes());
        m.put("personality", u.personality());
        m.put("active", u.active());
        m.put("adminLocked", u.adminLocked());
        m.put("dataVersion", u.dataVersion());
        return m;
    }

    private List<String> diffFields(UnitRow before, UnitRow after) {
        List<String> changed = new ArrayList<>();
        if (!Objects.equals(before.name(), after.name())) {
            changed.add("name");
        }
        if (!Objects.equals(before.position(), after.position())) {
            changed.add("position");
        }
        if (!Objects.equals(before.grade(), after.grade())) {
            changed.add("grade");
        }
        if (!Objects.equals(before.attributes(), after.attributes())) {
            changed.add("attributes");
        }
        if (!Objects.equals(before.personality(), after.personality())) {
            changed.add("personality");
        }
        if (before.active() != after.active()) {
            changed.add("active");
        }
        if (before.adminLocked() != after.adminLocked()) {
            changed.add("adminLocked");
        }
        return changed;
    }

    private Map<String, Object> impactDetail(GrowthService.GradeChangeImpact impact) {
        Map<String, Object> d = new LinkedHashMap<>();
        d.put("fromGrade", impact.fromGrade());
        d.put("toGrade", impact.toGrade());
        d.put("capLowered", impact.capLowered());
        d.put("affectedUsers", impact.affectedUsers());
        d.put("avgOvrDelta", impact.avgOvrDelta());
        d.put("worstOvrDelta", impact.worstOvrDelta());
        d.put("computed", impact.computed());
        return d;
    }

    private UnitRow requireUnit(String playerId) {
        return unit(playerId).orElseThrow(() -> ApiException.notFound("유닛을 찾을 수 없습니다: " + playerId));
    }

    private Optional<UnitRow> unit(String playerId) {
        if (playerId == null || playerId.isBlank()) {
            return Optional.empty();
        }
        return jdbcClient.sql("""
                        SELECT id, name, position, grade, attributes_json, personality, active,
                               admin_locked, data_version
                        FROM players WHERE id = ?
                        """)
                .param(playerId).query(this::mapUnit).optional();
    }

    private UnitRow mapUnit(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new UnitRow(rs.getString("id"), rs.getString("name"), rs.getString("position"),
                rs.getString("grade"), parseAttributes(rs.getString("attributes_json")),
                rs.getString("personality"), rs.getInt("active") != 0,
                rs.getInt("admin_locked") != 0, rs.getString("data_version"));
    }

    private AuditRow mapAudit(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new AuditRow(rs.getString("id"), rs.getString("actor_user_id"), rs.getString("player_id"),
                rs.getString("action"), readJsonMap(rs.getString("before_json")),
                readJsonMap(rs.getString("after_json")), splitFields(rs.getString("changed_fields")),
                rs.getString("reason"), rs.getString("idem_key"), rs.getString("created_at"));
    }

    // ── 검증 헬퍼 ──

    private String requireReason(String reason) {
        if (reason == null || reason.isBlank()) {
            throw ApiException.validation("reason 은 필수입니다(운영 사유 기록)");
        }
        if (reason.length() > reasonMaxChars) {
            throw ApiException.validation("reason 은 " + reasonMaxChars + "자 이하여야 합니다");
        }
        return reason;
    }

    private String requireName(String name) {
        if (name == null || name.isBlank()) {
            throw ApiException.validation("name 은 필수입니다");
        }
        String trimmed = name.trim();
        if (trimmed.length() > nameMaxChars) {
            throw ApiException.validation("name 은 " + nameMaxChars + "자 이하여야 합니다");
        }
        return trimmed;
    }

    private String requireEnum(String raw, java.util.Collection<String> allowed, String field) {
        String upper = raw == null ? null : raw.trim().toUpperCase(Locale.ROOT);
        if (upper == null || !allowed.contains(upper)) {
            throw ApiException.validation(field + " 는 " + allowed + " 중 하나여야 합니다");
        }
        return upper;
    }

    private Map<String, Integer> requireFullAttributes(Map<String, Object> raw) {
        if (raw == null) {
            throw ApiException.validation("attributes 는 필수입니다(9종 전부)");
        }
        Map<String, Integer> parsed = requirePartialAttributes(raw);
        for (String key : ATTR_KEYS) {
            if (!parsed.containsKey(key)) {
                throw ApiException.validation("attributes 에 '" + key + "' 가 없습니다(9종 전부 필요)");
            }
        }
        Map<String, Integer> ordered = new LinkedHashMap<>();
        ATTR_KEYS.forEach(k -> ordered.put(k, parsed.get(k)));
        return ordered;
    }

    private Map<String, Integer> requirePartialAttributes(Map<String, Object> raw) {
        Map<String, Integer> out = new LinkedHashMap<>();
        for (Map.Entry<String, Object> e : raw.entrySet()) {
            if (!ATTR_KEYS.contains(e.getKey())) {
                throw ApiException.validation("알 수 없는 능력치 키입니다: " + e.getKey());
            }
            if (!(e.getValue() instanceof Number n) || n.doubleValue() != Math.rint(n.doubleValue())) {
                throw ApiException.validation("능력치 '" + e.getKey() + "' 는 정수여야 합니다");
            }
            int v = n.intValue();
            if (v < attrMin || v > attrMax) {
                throw ApiException.validation(
                        "능력치 '" + e.getKey() + "' 는 " + attrMin + "~" + attrMax + " 범위여야 합니다");
            }
            out.put(e.getKey(), v);
        }
        if (out.isEmpty()) {
            throw ApiException.validation("attributes 가 비어 있습니다");
        }
        return out;
    }

    private String effectiveIdemKey(String header) {
        return (header == null || header.isBlank()) ? Ulid.next() : header.trim();
    }

    // ── JSON / 문자열 헬퍼 ──

    /** attributes_json → ATTR_KEYS 순서로 정규화(스냅샷·export·비교 안정). 미지 키는 뒤에 보존. */
    private Map<String, Integer> parseAttributes(String json) {
        Map<String, Integer> out = new LinkedHashMap<>();
        try {
            JsonNode node = objectMapper.readTree(json == null ? "{}" : json);
            for (String key : ATTR_KEYS) {
                if (node.hasNonNull(key)) {
                    out.put(key, node.path(key).asInt());
                }
            }
            node.properties().forEach(e -> {
                if (!out.containsKey(e.getKey()) && e.getValue().isNumber()) {
                    out.put(e.getKey(), e.getValue().asInt());
                }
            });
        } catch (Exception e) {
            throw new IllegalStateException("players.attributes_json 파싱 실패", e);
        }
        return out;
    }

    private String writeJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (Exception e) {
            throw new IllegalStateException("직렬화 실패", e);
        }
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> readJsonMap(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            return objectMapper.readValue(json, Map.class);
        } catch (Exception e) {
            return Map.of();
        }
    }

    private static List<String> splitFields(String csv) {
        if (csv == null || csv.isBlank()) {
            return List.of();
        }
        return List.of(csv.split(","));
    }

    private static int clamp(int v, int min, int max) {
        return Math.max(min, Math.min(v, max));
    }

    private static String escapeLike(String raw) {
        return raw.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_");
    }

    // ══════════════════════════ DTO ══════════════════════════

    public record UnitRow(String id, String name, String position, String grade,
                          Map<String, Integer> attributes, String personality,
                          boolean active, boolean adminLocked, String dataVersion) {
    }

    public record UnitPage(List<UnitRow> items, long total, int limit, int offset) {
    }

    public record Holdings(long owners, long copies) {
    }

    public record UnitDetail(UnitRow unit, Holdings holdings, List<AuditRow> recentAudit) {
    }

    /** before/after 는 <b>전체 스냅샷</b>(§1.4) — 문자열이 아니라 객체로 나간다(운영 UI 가 그대로 렌더). */
    public record AuditRow(String id, String actorUserId, String playerId, String action,
                           Map<String, Object> before, Map<String, Object> after, List<String> changedFields,
                           String reason, String idemKey, String createdAt) {
    }

    public record AuditPage(List<AuditRow> items, long total, int limit, int offset) {
    }

    /**
     * @param applied false = 같은 멱등키의 재전송이라 아무것도 바뀌지 않았다(unit 은 현재값).
     * @param impact  등급 변경이 동반된 경우의 실측 영향(그 외 null).
     */
    public record MutationResult(UnitRow unit, boolean applied, String idempotencyKey, String auditId,
                                 List<String> changedFields, GrowthService.GradeChangeImpact impact) {
    }

    public record CreateRequest(String name, String position, String grade,
                                Map<String, Object> attributes, String personality,
                                Boolean active, String reason) {
    }

    public record PatchRequest(String name, String position, String grade,
                               Map<String, Object> attributes, String personality,
                               Boolean active, Boolean confirmImpact, String reason) {
    }

    public record ReasonRequest(String reason) {
    }
}
