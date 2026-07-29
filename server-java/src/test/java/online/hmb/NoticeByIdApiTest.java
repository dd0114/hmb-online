package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
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
 * {@code GET /api/notices/{id}} 공개 단건 계약 — 공유 딥링크가 읽는 엔드포인트 (#297 AC1·AC3, 에픽 #293).
 *
 * <p><b>이 클래스가 지키는 성질 두 가지</b>
 *
 * <ol>
 *   <li><b>미인증으로 읽힌다</b>. 공유 링크는 <b>정의상 로그인하지 않은 사람이 먼저 연다</b> —
 *       여기에 401 을 두면 카톡으로 받은 링크가 로그인 벽을 먼저 보여 주고, 공지 내용은
 *       영원히 도달하지 않는다. 근거는 {@code /api/notices/active}·{@code /api/config} 와 같다:
 *       유저 스코프 데이터가 0인 전체 브로드캐스트다.
 *       (선례 계약 = {@code NoticeActiveApiTest.activeNoticesAreReachableWithoutAuth})</li>
 *   <li><b>운영 필드가 새지 않는다</b>. 미인증 공개라 응답 키 집합을 <b>정확히</b> 고정한다
 *       (부분집합 단언이 아니다) — 나중에 admin 뷰를 재사용하거나 컬럼을 얹었을 때
 *       {@code active}·{@code deletedAt}·{@code createdBy}·{@code updatedAt} 이 조용히 새는 것을
 *       사람이 눈치채지 못하기 때문이다. 필드를 늘리려면 이 목록을 <b>의식적으로</b> 고쳐야 한다.</li>
 * </ol>
 *
 * <p>상태별 코드(200/410/404)는 {@link NoticeByIdStatusTest} 가 전담한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class NoticeByIdApiTest extends ApiTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    private static final Instant T0 = Instant.parse("2026-07-29T12:00:00Z");
    static final AtomicReference<Instant> NOW = new AtomicReference<>(T0);

    /** 공개 단건 응답의 <b>전부</b>. 여기 없는 키가 응답에 있으면 계약 위반이다. */
    private static final String[] PUBLIC_KEYS =
            {"id", "revision", "title", "body", "startsAt", "endsAt", "priority"};

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

    // ── AC1: 토큰 없이 200 ──────────────────────────────────────────────────

    /**
     * <b>Authorization 헤더가 아예 없는</b> 요청이 200 + 본문을 받는다.
     *
     * <p>변이체 킬: {@code WebMvcConfig.excludePathPatterns} 에서 {@code /api/notices/{id}} 를 빼면
     * 401 이 되어 여기서 죽는다. (남아 있는 {@code /api/notices/active} 패턴은 {@code active}
     * 세그먼트만 매칭하므로 이 경로를 덮지 않는다.)
     */
    @Test
    void reachableWithoutAuth() {
        insertLive("N-SHARED", "공유된 공지");

        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/N-SHARED"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsEntry("id", "N-SHARED");
    }

    /** 로그인한 유저도 <b>같은 것</b>을 본다(공개화가 인증 경로를 깨뜨리지 않았다). */
    @Test
    void authenticatedUsersSeeTheSameNotice() {
        insertLive("N-BOTH", "공유된 공지");

        ResponseEntity<Map> anon = rest.getForEntity(baseUrl("/api/notices/N-BOTH"), Map.class);
        ResponseEntity<Map> authed = authGet("/api/notices/N-BOTH", login("notice_deeplink"), Map.class);

        assertThat(authed.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(authed.getBody()).isEqualTo(anon.getBody());
    }

    /**
     * 팝업이 그리는 데 필요한 값이 <b>전부</b> 실린다 — {@code revision} 포함.
     *
     * <p>{@code revision} 이 빠지면 공유 링크로 연 공지가 클라의 24시간 억제 키({@code id@revision})와
     * 맞물리지 않아 "고친 공지가 안 보인다"가 재발한다(#248 V26 설계근거 2).
     */
    @Test
    void payloadCarriesEverythingThePopupNeeds() {
        insert("N-FIELDS", "제목", "본문\n둘째 줄", 7,
                "2026-07-29T00:00:00Z", "2026-07-31T00:00:00Z", 1, null);
        jdbcClient.sql("UPDATE notices SET revision = 4 WHERE id = 'N-FIELDS'").update();

        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/N-FIELDS"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody())
                .containsEntry("id", "N-FIELDS")
                .containsEntry("revision", 4)
                .containsEntry("title", "제목")
                .containsEntry("body", "본문\n둘째 줄")
                .containsEntry("priority", 7)
                .containsEntry("startsAt", "2026-07-29T00:00:00Z")
                .containsEntry("endsAt", "2026-07-31T00:00:00Z");
    }

    // ── AC3: 운영 필드 미노출(키 집합 동등) ─────────────────────────────────

    /**
     * 응답 키 집합이 화이트리스트와 <b>정확히 일치</b>한다 — 부분집합이 아니다.
     *
     * <p>DB 행에는 {@code active}·{@code deleted_at}·{@code created_by}·{@code created_at}·
     * {@code updated_at} 이 있다. 이 엔드포인트는 <b>인증 없이</b> 열려 있으므로, 조회를
     * {@code SELECT *} 로 바꾸거나 admin DTO 를 재사용하는 순간 운영 정보가 그대로 공개된다.
     * {@code containsOnlyKeys} 만이 그 변이를 잡는다(긍정 단언은 통과시킨다).
     */
    @Test
    void operationalFieldsNeverLeak() {
        insert("N-LEAK", "제목", "본문", 0, null, null, 1, null);
        // created_by 는 users FK 다 — 실제 계정을 만들어 "운영자 흔적이 실린 행"을 재현한다.
        login("notice_operator");
        String operatorId = jdbcClient.sql("SELECT id FROM users WHERE nickname = 'notice_operator'")
                .query(String.class).single();
        jdbcClient.sql("UPDATE notices SET created_by = ? WHERE id = 'N-LEAK'")
                .param(operatorId).update();

        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/N-LEAK"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(res.getBody()).containsOnlyKeys(PUBLIC_KEYS);
        assertThat(res.getBody()).doesNotContainKeys(
                "active", "deletedAt", "createdBy", "updatedAt", "createdAt", "status");
    }

    /**
     * 기간이 없는 공지(NULL = 즉시 시작 / 무기한)도 키가 <b>사라지지 않는다</b>.
     *
     * <p>Jackson 이 null 을 생략하도록 설정되면 클라가 {@code startsAt} 유무로 분기하다 깨진다 —
     * 키는 항상 있고 값이 null 이다.
     */
    @Test
    void nullWindowStillCarriesTheKeys() {
        insert("N-ALWAYS", "상시", "본문", 0, null, null, 1, null);

        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/N-ALWAYS"), Map.class);

        assertThat(res.getBody()).containsOnlyKeys(PUBLIC_KEYS);
        assertThat(res.getBody()).containsEntry("startsAt", null).containsEntry("endsAt", null);
    }

    /**
     * 피드({@code /active})와 단건이 <b>같은 필드 집합</b>을 준다.
     *
     * <p>두 곳이 각자 DTO 를 들면 한쪽에만 필드가 붙어 조용히 갈라진다 — 공유 링크로 연 공지와
     * 로비 팝업이 서로 다른 모양이 되는 순간 web 이 두 벌의 파서를 갖게 된다.
     */
    @Test
    void singleAndFeedShareTheSameShape() {
        insertLive("N-SAME", "같은 모양");

        ResponseEntity<Map> single = rest.getForEntity(baseUrl("/api/notices/N-SAME"), Map.class);
        ResponseEntity<Map> feed = rest.getForEntity(baseUrl("/api/notices/active"), Map.class);

        @SuppressWarnings("unchecked")
        Map<String, Object> fromFeed =
                ((java.util.List<Map<String, Object>>) feed.getBody().get("notices")).get(0);

        assertThat(single.getBody()).isEqualTo(fromFeed);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    private void insertLive(String id, String title) {
        insert(id, title, "본문 " + id, 0, null, null, 1, null);
    }

    private void insert(String id, String title, String body, int priority, String startsAt,
                        String endsAt, int active, String deletedAt) {
        jdbcClient.sql("""
                        INSERT INTO notices(id, title, body, starts_at, ends_at, active, priority, revision,
                                            deleted_at, created_by, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, NULL, ?, ?)
                        """)
                .params(id, title, body, startsAt, endsAt, active, priority, deletedAt,
                        T0.toString(), T0.toString())
                .update();
    }
}
