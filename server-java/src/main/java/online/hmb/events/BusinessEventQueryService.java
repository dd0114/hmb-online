package online.hmb.events;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.common.ApiException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Service;

/**
 * <b>비즈니스 이벤트 조회</b>(#492, admin 전용) — 스트림 + <b>유저별 퍼널</b>.
 *
 * <p>hero 가 밝힌 목적이 <i>"심사위원들이 게임을 어디까지 플레이해봤나"</i> 이므로 1급 산출물은
 * 종류별 총량이 아니라 <b>유저별 도달 지점</b>이다({@link #funnel}). 스트림({@link #page})은 그
 * 한 칸을 눌렀을 때 "무슨 일이 있었나"를 보여주는 뒷받침이다.
 *
 * <p><b>이 서비스가 이 테이블의 유일한 조회 소유자다</b> — {@code admin_ops_audit} 의 조회 SQL 이
 * 4개 서비스에 복붙된 전례를 반복하지 않는다(#492 R6-3).
 *
 * <p>⚠️ 이 빈은 {@code AdminRouteGuard.ADMIN_ONLY_BEANS} 에 등록돼 있다 — 이걸 주입받는 핸들러는
 * 어느 패키지에 있든 {@code /api/admin/} 접두사 밖에 매핑되면 <b>부팅이 죽는다</b>.
 * {@link BusinessEventRecorder}(쓰기)는 <b>일부러 별개 클래스</b>다: 훅이 붙는 컨트롤러
 * (덱·상점·매치·리그·원정)는 admin 이 아니고, 한 클래스로 합치면 그 전부가 게이트 위반이 된다.
 */
@Service
public class BusinessEventQueryService {

    private static final Logger log = LoggerFactory.getLogger(BusinessEventQueryService.class);

    private final JdbcClient jdbcClient;
    private final ObjectMapper objectMapper;
    private final int pageSizeDefault;
    private final int pageSizeMax;
    private final int funnelMaxUsers;

    public BusinessEventQueryService(JdbcClient jdbcClient,
                                     ObjectMapper objectMapper,
                                     @Value("${hmb.events.page-size-default:50}") int pageSizeDefault,
                                     @Value("${hmb.events.page-size-max:200}") int pageSizeMax,
                                     @Value("${hmb.events.funnel-max-users:500}") int funnelMaxUsers) {
        this.jdbcClient = jdbcClient;
        this.objectMapper = objectMapper;
        this.pageSizeDefault = pageSizeDefault;
        this.pageSizeMax = pageSizeMax;
        this.funnelMaxUsers = funnelMaxUsers;
    }

    // ── GET /api/admin/events ───────────────────────────────────────────

    /** 스트림 한 페이지. {@code props} 는 <b>파싱된 객체</b>로 나간다(문자열이면 클라가 또 파싱한다). */
    public EventPage page(String event, String userId, String mode, Integer limit, Integer offset) {
        int effLimit = clamp(limit == null ? pageSizeDefault : limit, 1, pageSizeMax);
        int effOffset = Math.max(0, offset == null ? 0 : offset);

        StringBuilder where = new StringBuilder(" WHERE 1=1");
        List<Object> params = new ArrayList<>();
        if (event != null && !event.isBlank()) {
            // 오타 난 필터가 "0건"으로 조용히 거짓말하지 않게 한다(감사 리더 선례).
            if (!BusinessEvent.KNOWN.contains(event.trim())) {
                throw ApiException.validation("알 수 없는 event 입니다: " + event);
            }
            where.append(" AND e.event = ?");
            params.add(event.trim());
        }
        if (userId != null && !userId.isBlank()) {
            where.append(" AND e.user_id = ?");
            params.add(userId.trim());
        }
        if (mode != null && !mode.isBlank()) {
            // mode 는 별도 컬럼이 아니라 props 안이다 — 매치를 종류별 이벤트로 쪼개지 않기로 한
            // D1 의 귀결이다(쪼개면 매치 1건이 두 번 세어진다).
            where.append(" AND json_extract(e.props_json, '$.mode') = ?");
            params.add(mode.trim());
        }

        long total = jdbcClient.sql("SELECT COUNT(*) FROM business_events e" + where)
                .params(params).query(Long.class).single();

        List<Object> pageParams = new ArrayList<>(params);
        pageParams.add(effLimit);
        pageParams.add(effOffset);
        List<EventRow> items = jdbcClient.sql("""
                        SELECT e.id, e.event, e.user_id, e.occurred_at, e.props_json, u.nickname
                        FROM business_events e LEFT JOIN users u ON u.id = e.user_id"""
                        + where
                        // id 가 ULID(시간순)라 같은 초 안의 tie-break 가 곧 발생 순서다.
                        + " ORDER BY e.occurred_at DESC, e.id DESC LIMIT ? OFFSET ?")
                .params(pageParams).query(this::mapEvent).list();

        return new EventPage(items, total, effLimit, effOffset);
    }

    // ── GET /api/admin/events/funnel ────────────────────────────────────

    /**
     * 유저 1행 × 단계 도달 여부. <b>정렬은 {@code lastSeenAt DESC}</b> — 심사 중에 방금 움직인
     * 사람이 맨 위에 있어야 한다.
     *
     * <p>집계는 SQL 한 방이다(유저 수만큼 도는 대신). practice/league/away 는 {@code match_start} 의
     * {@code props.mode} 로 가른다 — 이벤트를 쪼개지 않은 D1 과 같은 축이라 두 화면이 다른 말을 하지 않는다.
     */
    public FunnelResponse funnel() {
        List<FunnelUser> users = jdbcClient.sql("""
                        SELECT e.user_id                                     AS user_id,
                               u.nickname                                    AS nickname,
                               MIN(e.occurred_at)                            AS first_seen,
                               MAX(e.occurred_at)                            AS last_seen,
                               COUNT(*)                                      AS event_count,
                               MAX(CASE WHEN e.event = 'user_signup'         THEN 1 ELSE 0 END) AS r_signup,
                               MAX(CASE WHEN e.event = 'tutorial_complete'   THEN 1 ELSE 0 END) AS r_tutorial,
                               MAX(CASE WHEN e.event = 'deck_save'           THEN 1 ELSE 0 END) AS r_deck,
                               MAX(CASE WHEN e.event = 'gacha_pull'          THEN 1 ELSE 0 END) AS r_gacha,
                               MAX(CASE WHEN e.event = 'match_start'
                                         AND json_extract(e.props_json, '$.mode') = 'practice'
                                        THEN 1 ELSE 0 END)                   AS r_practice,
                               MAX(CASE WHEN e.event = 'match_start'
                                         AND json_extract(e.props_json, '$.mode') = 'league'
                                        THEN 1 ELSE 0 END)                   AS r_league,
                               MAX(CASE WHEN e.event = 'match_start'
                                         AND json_extract(e.props_json, '$.mode') = 'away'
                                        THEN 1 ELSE 0 END)                   AS r_away,
                               SUM(CASE WHEN e.event = 'match_finish'        THEN 1 ELSE 0 END) AS matches_finished
                        FROM business_events e LEFT JOIN users u ON u.id = e.user_id
                        GROUP BY e.user_id
                        ORDER BY last_seen DESC, e.user_id DESC
                        LIMIT ?
                        """)
                .param(funnelMaxUsers)
                .query((rs, rowNum) -> new FunnelUser(
                        rs.getString("user_id"),
                        rs.getString("nickname"),
                        rs.getString("first_seen"),
                        rs.getString("last_seen"),
                        new Reached(
                                rs.getInt("r_signup") == 1,
                                rs.getInt("r_tutorial") == 1,
                                rs.getInt("r_deck") == 1,
                                rs.getInt("r_gacha") == 1,
                                rs.getInt("r_practice") == 1,
                                rs.getInt("r_league") == 1,
                                rs.getInt("r_away") == 1),
                        rs.getLong("matches_finished"),
                        rs.getLong("event_count")))
                .list();
        return new FunnelResponse(Instant.now().toString(), users);
    }

    // ── 매핑 ────────────────────────────────────────────────────────────

    private EventRow mapEvent(java.sql.ResultSet rs, int rowNum) throws java.sql.SQLException {
        return new EventRow(
                rs.getString("id"),
                rs.getString("event"),
                rs.getString("user_id"),
                rs.getString("nickname"),
                rs.getString("occurred_at"),
                parseProps(rs.getString("props_json")));
    }

    /** 깨진 props 를 표시하는 키 — "속성이 없다"와 "속성이 깨졌다"를 화면에서 가른다. */
    static final String PARSE_ERROR_KEY = "_parseError";

    /** 깨진 원문(잘라서) — 무엇이 깨졌는지 보려면 원문이 필요하다. */
    static final String RAW_KEY = "_raw";

    private static final int RAW_MAX = 500;

    /**
     * props 는 <b>객체</b>로 내려간다. 깨진 행 하나가 페이지 전체를 500 으로 만들면 안 되므로
     * 파싱 실패는 객체로 낮춘다(원장은 append-only 라 고쳐 쓸 수도 없다).
     *
     * <p>⚠️ 단 <b>빈 객체로 낮추지 않는다</b>(AC7 패널 5R 엣지케이스 렌즈). 그러면 "속성이 애초에
     * 없었다(props_json NULL)"와 "속성이 깨져서 못 읽었다"가 화면에서 <b>완전히 같아 보인다</b> —
     * 관측 화면이 자기 결손을 숨기는 셈이라 계측으로서 최악이다. 깨진 행은 {@link #PARSE_ERROR_KEY}
     * 와 원문 일부를 달고 나가 <b>눈에 띄게</b> 한다.
     */
    private Map<String, Object> parseProps(String json) {
        if (json == null || json.isBlank()) {
            return Map.of();
        }
        try {
            Map<String, Object> parsed = objectMapper.readValue(json, new TypeReference<>() {
            });
            return parsed == null ? Map.of() : parsed;
        } catch (Exception e) {
            log.warn("business_events.props_json 파싱 실패 — 깨진 행으로 표시: {}", e.toString());
            Map<String, Object> broken = new LinkedHashMap<>();
            broken.put(PARSE_ERROR_KEY, true);
            broken.put(RAW_KEY, json.length() > RAW_MAX ? json.substring(0, RAW_MAX) + "…" : json);
            return broken;
        }
    }

    private static int clamp(int value, int min, int max) {
        return Math.max(min, Math.min(max, value));
    }

    // ── 응답 계약 (#492 D3 · 동결) ──────────────────────────────────────

    public record EventRow(String id, String event, String userId, String nickname,
                           String occurredAt, Map<String, Object> props) {
    }

    public record EventPage(List<EventRow> items, long total, int limit, int offset) {
    }

    /** 단계 도달 여부 — "그 이벤트를 1건 이상 남겼는가". */
    public record Reached(boolean signup, boolean tutorial, boolean deck, boolean gacha,
                          boolean practice, boolean league, boolean away) {
    }

    public record FunnelUser(String userId, String nickname, String firstSeenAt, String lastSeenAt,
                             Reached reached, long matchesFinished, long eventCount) {
    }

    public record FunnelResponse(String generatedAt, List<FunnelUser> users) {
    }
}
