package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * {@code GET /api/notices/active} 계약 (#248 §2.1 · §5 server 1·2·6).
 *
 * <p><b>이 클래스가 지키는 성질</b>: "지금 보여야 하는 공지가 무엇인가"는 <b>서버가 정한다</b>.
 * 클라는 기간을 재계산하지 않는다 — 그러면 기기 시계·타임존이 진실이 되고(폰 시계가 하루 빠른
 * 유저에게 점검 공지가 안 뜬다), 규칙이 바뀔 때 조용히 어긋난다(#217 {@code locked} 와 같은 원칙).
 *
 * <p>그래서 경계값은 <b>고정 Clock 빈</b>(@Primary, {@code MatchConditionDateAnchorTest} 와 같은
 * 패턴)으로 밀어 넣는다. 시각을 앞뒤로 움직이면 <b>같은 행</b>이 나타났다 사라져야 한다 —
 * 필터가 실제로 시각을 보고 있음을 증명하는 방식이다(하드코딩된 픽스처로는 증명되지 않는다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class NoticeActiveApiTest extends ApiTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");

    /** 기준 '지금'. 창(window) 픽스처는 전부 이 시각을 기준으로 배치한다. */
    private static final Instant T0 = Instant.parse("2026-07-29T12:00:00Z");

    static final AtomicReference<Instant> NOW = new AtomicReference<>(T0);

    @TestConfiguration
    static class MutableClockConfig {
        @Bean
        @Primary
        Clock testClock() {
            return new Clock() {
                @Override
                public ZoneId getZone() {
                    return KST;
                }

                @Override
                public Clock withZone(ZoneId zone) {
                    return this;
                }

                @Override
                public Instant instant() {
                    return NOW.get();
                }
            };
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @BeforeEach
    void reset() {
        NOW.set(T0);
        jdbcClient.sql("DELETE FROM notices").update();
    }

    // ── 계약 1: 창·스위치·삭제를 서버가 전부 거른다 ──────────────────────────

    /**
     * 다섯 가지 제외 사유가 <b>각각</b> 실제로 거른다. 하나라도 필터가 빠지면 여기서 죽는다.
     *
     * <p>제외 사유를 한 테스트에 모은 이유: "활성 공지"의 정의는 다섯 조건의 <b>연립</b>이고,
     * 조건 하나만 남겨 두면 나머지를 지워도 통과하는 테스트가 된다.
     */
    @Test
    void serverFiltersOutEverythingThatShouldNotBeShownRightNow() {
        insert("N-LIVE", "지금 보이는 공지", 0, "2026-07-29T00:00:00Z", "2026-07-31T00:00:00Z", 1, null);
        insert("N-FUTURE", "아직 시작 전", 0, "2026-08-01T00:00:00Z", null, 1, null);
        insert("N-PAST", "이미 끝남", 0, null, "2026-07-28T00:00:00Z", 1, null);
        insert("N-OFF", "스위치 off", 0, null, null, 0, null);
        insert("N-DELETED", "soft delete 됨", 0, null, null, 1, "2026-07-20T00:00:00Z");

        assertThat(ids(activeNotices())).containsExactly("N-LIVE");
    }

    /** 기간이 없는 공지는 항상 보인다(NULL = 즉시 시작 / 무기한). */
    @Test
    void notALLNoticesNeedAWindow() {
        insert("N-ALWAYS", "상시 공지", 0, null, null, 1, null);
        assertThat(ids(activeNotices())).containsExactly("N-ALWAYS");
    }

    // ── 계약 1-b: 시각이 실제로 판정에 쓰인다(경계값) ─────────────────────────

    /**
     * <b>같은 행</b>이 시각에 따라 나타났다 사라진다 — 필터가 상수가 아니라 시계를 보고 있다는 증명.
     * 경계는 <b>양끝 포함</b>이다(시작 정각에 뜨고, 종료 정각까지 보인다).
     */
    @Test
    void theSameNoticeAppearsAndDisappearsAsTimeMoves() {
        insert("N-WINDOW", "창 안에서만", 0, "2026-07-29T12:00:00Z", "2026-07-29T13:00:00Z", 1, null);

        NOW.set(Instant.parse("2026-07-29T11:59:59Z"));
        assertThat(ids(activeNotices())).as("시작 1초 전").isEmpty();

        NOW.set(Instant.parse("2026-07-29T12:00:00Z"));
        assertThat(ids(activeNotices())).as("시작 정각 = 포함").containsExactly("N-WINDOW");

        NOW.set(Instant.parse("2026-07-29T13:00:00Z"));
        assertThat(ids(activeNotices())).as("종료 정각 = 포함").containsExactly("N-WINDOW");

        NOW.set(Instant.parse("2026-07-29T13:00:01Z"));
        assertThat(ids(activeNotices())).as("종료 1초 후").isEmpty();
    }

    // ── 계약 2: 정렬 ────────────────────────────────────────────────────────

    /**
     * 정렬 = {@code priority DESC, starts_at DESC, id DESC}. 클라는 받은 순서를 그대로 쌓는다
     * (스택 팝업 — hero 컨펌 Q1), 그러니 "무엇이 맨 앞인가"는 서버가 정하는 값이다.
     *
     * <p>삽입 순서를 일부러 뒤섞어 둔다 — DB 기본 순서(rowid)로 우연히 맞는 것을 배제한다.
     */
    @Test
    void orderIsPriorityThenStartsAtThenId() {
        insert("N-B", "우선순위 낮음/최신", 0, "2026-07-29T10:00:00Z", null, 1, null);
        insert("N-D", "동률 tie-break: id 역순 뒤", 5, "2026-07-29T09:00:00Z", null, 1, null);
        insert("N-A", "우선순위 낮음/오래됨", 0, "2026-07-29T08:00:00Z", null, 1, null);
        insert("N-C", "동률 tie-break: id 역순 앞", 5, "2026-07-29T09:00:00Z", null, 1, null);
        insert("N-TOP", "최우선", 10, "2026-07-29T01:00:00Z", null, 1, null);

        assertThat(ids(activeNotices()))
                // priority 10 → priority 5 두 건(startsAt 동률이라 id DESC) → priority 0 두 건(startsAt DESC)
                .containsExactly("N-TOP", "N-D", "N-C", "N-B", "N-A");
    }

    // ── 계약 6: 공개(인증 불필요) ────────────────────────────────────────────

    /**
     * <b>토큰 없이 200</b> (#248 Q5 — {@code CurrencyConfigApiTest.configIsReachableWithoutAuth} 와 같은 결).
     *
     * <p>이걸 401 로 두면 <b>점검 공지가 가장 필요한 순간</b>(로그인이 안 되는 순간)에 정확히
     * 안 보인다. #232 독립검증 BL-1(부팅 1회 호출이 401 나서 세션 전체가 망가짐)의 반복이다.
     * 내용은 전체 브로드캐스트라 유저별 데이터가 0이다.
     *
     * <p>이 테스트는 {@code WebMvcConfig} 가 공지 피드를 인증 뒤로 되돌리면 <b>실제로 깨진다</b>(변이체 킬).
     * ⚠️ 단, #297 이 {@code "/api/notices/{id}"} 를 같은 목록에 넣은 뒤로 두 패턴은 <b>겹친다</b>
     * ({@code {id}} 가 {@code active} 세그먼트도 매칭한다) — 즉 {@code "/api/notices/active"} 한 줄만
     * 지우는 변이는 이 테스트로 잡히지 않는다. 잡히는 것은 <b>공지 경로가 목록에서 사라지는</b> 변이다.
     */
    @Test
    void activeNoticesAreReachableWithoutAuth() {
        insert("N-PUBLIC", "점검 안내", 0, null, null, 1, null);

        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/active"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ids(notices(res.getBody()))).containsExactly("N-PUBLIC");
    }

    /** 로그인한 유저도 같은 것을 본다(공개화가 인증 경로를 깨뜨리지 않았다). */
    @Test
    void authenticatedUsersSeeTheSameFeed() {
        insert("N-BOTH", "공지", 0, null, null, 1, null);

        ResponseEntity<Map> res = authGet("/api/notices/active", login("notice_reader"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(ids(notices(res.getBody()))).containsExactly("N-BOTH");
    }

    /** 활성 0건이어도 200 + 빈 배열이다(클라가 {@code notices.length} 를 그대로 만져도 안전). */
    @Test
    void emptyFeedIsAnEmptyArrayNotAnError() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/active"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(notices(res.getBody())).isEmpty();
    }

    /**
     * 팝업이 그리는 데 필요한 필드가 전부 실리고 — <b>그 외에는 아무것도 안 실린다</b>.
     *
     * <p>{@code containsOnlyKeys} 인 이유(독립검증 m5): 이 엔드포인트는 <b>인증 없이 공개</b>다.
     * 긍정 단언만 있으면 나중에 admin 뷰를 재사용하거나 필드를 얹었을 때 운영 전용 정보
     * ({@code createdBy} · {@code deletedAt} · 내부 상태)가 조용히 새어도 아무도 안 잡는다.
     * 필드를 늘리려면 이 목록을 <b>의식적으로</b> 고쳐야 한다.
     */
    @Test
    void payloadCarriesExactlyWhatThePopupNeedsAndNothingMore() {
        insert("N-FIELDS", "제목", 7, "2026-07-29T00:00:00Z", "2026-07-31T00:00:00Z", 1, null);
        jdbcClient.sql("UPDATE notices SET revision = 4, body = ? WHERE id = 'N-FIELDS'")
                .param("본문\n둘째 줄").update();

        Map<String, Object> notice = activeNotices().get(0);

        assertThat(notice).containsOnlyKeys(
                "id", "revision", "title", "body", "startsAt", "endsAt", "priority");
        assertThat(notice).containsEntry("id", "N-FIELDS")
                .containsEntry("revision", 4)          // 억제 키의 절반 — 빠지면 오탈자 수정본이 안 보인다
                .containsEntry("title", "제목")
                .containsEntry("body", "본문\n둘째 줄")
                .containsEntry("priority", 7)
                .containsEntry("startsAt", "2026-07-29T00:00:00Z")
                .containsEntry("endsAt", "2026-07-31T00:00:00Z");
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private void insert(String id, String title, int priority, String startsAt, String endsAt,
                        int active, String deletedAt) {
        jdbcClient.sql("""
                        INSERT INTO notices(id, title, body, starts_at, ends_at, active, priority, revision,
                                            deleted_at, created_by, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)
                        """)
                .params(id, title, "본문 " + id, startsAt, endsAt, active, priority, deletedAt,
                        T0.toString(), T0.toString())
                .update();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> activeNotices() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/active"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return notices(res.getBody());
    }

    @SuppressWarnings("unchecked")
    private static List<Map<String, Object>> notices(Map<String, Object> body) {
        return (List<Map<String, Object>>) body.get("notices");
    }

    private static List<String> ids(List<Map<String, Object>> notices) {
        return notices.stream().map(n -> (String) n.get("id")).toList();
    }
}
