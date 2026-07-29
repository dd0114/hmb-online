package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;
import online.hmb.notice.Notices;
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
 * {@code GET /api/notices/{id}} <b>상태별 응답 코드</b> 계약 (#297 AC2, hero 확정표).
 *
 * <pre>
 *   LIVE                        → 200 + 본문
 *   EXPIRED · OFF               → 410 (앱이 "기간이 지난 공지입니다" 로 안내하고 로비로 보낸다)
 *   SCHEDULED · DELETED · 없는id → 404 (아직 공개 안 한 예약 공지가 링크로 새는 것을 막는다)
 * </pre>
 *
 * <p><b>왜 410 과 404 를 나누는가</b>: 끝난 공지는 "있었는데 끝났다"를 알려 주는 편이 친절하고
 * (유저가 링크가 깨졌다고 오해하지 않는다), <b>예약 공지는 존재 자체를 숨겨야 한다</b> —
 * 410 은 "그 id 는 실재한다"를 흘리므로 공개 전 공지의 존재가 링크로 새어 나간다.
 * 그래서 SCHEDULED 는 없는 id 와 <b>구분 불가능</b>해야 한다.
 *
 * <p><b>이 테스트가 지키는 진짜 성질 = 규칙이 한 곳에만 있다</b>. 기대 상태를 픽스처에서
 * {@link Notices#status} 로 <b>직접 계산</b>해 대조한다 — 컨트롤러가 기간·스위치 규칙을 다시 적으면
 * (예: SQL 에 {@code WHERE active=1 AND ends_at >= now} 를 심으면) 판정기와 갈라지는 순간 여기서 죽는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class NoticeByIdStatusTest extends ApiTestBase {

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
    private static final Instant T0 = Instant.parse("2026-07-29T12:00:00Z");
    static final AtomicReference<Instant> NOW = new AtomicReference<>(T0);

    /**
     * hero 확정표 그 자체. <b>모든</b> {@link Notices.Status} 가 여기 있어야 한다
     * ({@link #everyStatusHasADecision} 이 강제) — 새 상태가 생기면 "무슨 코드를 줄지"를
     * 반드시 결정하게 만들어, 기본값으로 조용히 200 이 새는 길을 막는다.
     */
    private static final Map<Notices.Status, HttpStatus> EXPECTED = new LinkedHashMap<>(Map.of(
            Notices.Status.LIVE, HttpStatus.OK,
            Notices.Status.EXPIRED, HttpStatus.GONE,
            Notices.Status.OFF, HttpStatus.GONE,
            Notices.Status.SCHEDULED, HttpStatus.NOT_FOUND,
            Notices.Status.DELETED, HttpStatus.NOT_FOUND));

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

    /** 결정표에 구멍이 없다 — 상태가 추가되면 여기서 먼저 죽는다. */
    @Test
    void everyStatusHasADecision() {
        assertThat(EXPECTED.keySet()).containsExactlyInAnyOrder(Notices.Status.values());
    }

    // ── 케이스 5종 + 없는 id = 6 ────────────────────────────────────────────

    /** LIVE = 200 + 본문. 공유 링크의 정상 경로다. */
    @Test
    void liveNoticeIs200WithBody() {
        Row row = new Row("N-LIVE", "2026-07-29T00:00:00Z", "2026-07-31T00:00:00Z", 1, null);
        ResponseEntity<Map> res = assertMatchesTable(row, Notices.Status.LIVE);
        assertThat(res.getBody()).containsEntry("id", "N-LIVE").containsEntry("title", "제목 N-LIVE");
    }

    /** EXPIRED = 410. 본문은 주지 않는다 — 앱이 "기간이 지난 공지입니다"만 띄운다. */
    @Test
    void expiredNoticeIs410() {
        Row row = new Row("N-EXPIRED", null, "2026-07-28T00:00:00Z", 1, null);
        ResponseEntity<Map> res = assertMatchesTable(row, Notices.Status.EXPIRED);
        assertThat(res.getBody()).doesNotContainKeys("title", "body");
    }

    /** OFF(운영 스위치 내림) = 410. 기간과 무관하게 "지금은 끝난 것"으로 안내한다. */
    @Test
    void switchedOffNoticeIs410() {
        Row row = new Row("N-OFF", null, null, 0, null);
        ResponseEntity<Map> res = assertMatchesTable(row, Notices.Status.OFF);
        assertThat(res.getBody()).doesNotContainKeys("title", "body");
    }

    /**
     * SCHEDULED = 404. <b>이 이슈의 핵심 가드</b> — 아직 공개하지 않은 예약 공지가 링크로 새면
     * 운영이 준비 중인 내용(점검 일정·이벤트)이 먼저 퍼진다.
     *
     * <p>변이체 킬: 매핑을 200 으로 바꾸면 여기서 죽는다. 게다가 {@link #scheduledIsIndistinguishableFromAbsent}
     * 가 "410 으로 바꾸는" 우회(존재를 흘리는 쪽)까지 막는다.
     */
    @Test
    void scheduledNoticeIs404() {
        Row row = new Row("N-SCHEDULED", "2026-08-01T00:00:00Z", null, 1, null);
        ResponseEntity<Map> res = assertMatchesTable(row, Notices.Status.SCHEDULED);
        assertThat(res.getBody()).doesNotContainKeys("title", "body");
    }

    /** DELETED(soft delete) = 404. 지운 공지는 링크로도 되살아나지 않는다. */
    @Test
    void deletedNoticeIs404() {
        Row row = new Row("N-DELETED", null, null, 1, "2026-07-20T00:00:00Z");
        assertMatchesTable(row, Notices.Status.DELETED);
    }

    /** 없는 id = 404. */
    @Test
    void unknownIdIs404() {
        assertThat(get("N-NOPE").getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── 존재 누출 방지 ──────────────────────────────────────────────────────

    /**
     * 예약 공지는 <b>없는 id 와 응답이 완전히 같다</b>(상태코드 + 본문).
     *
     * <p>코드만 404 로 맞추고 메시지에 "아직 시작 전"이라고 적으면 존재가 새는 것은 그대로다.
     * 링크를 넣어 보는 것만으로 "그런 공지가 준비 중이다"를 알 수 있으면 안 된다.
     */
    @Test
    void scheduledIsIndistinguishableFromAbsent() {
        insert(new Row("N-FUTURE", "2026-08-01T00:00:00Z", null, 1, null));

        ResponseEntity<Map> scheduled = get("N-FUTURE");
        ResponseEntity<Map> absent = get("N-NEVER-EXISTED");

        assertThat(scheduled.getStatusCode()).isEqualTo(absent.getStatusCode());
        assertThat(scheduled.getBody()).isEqualTo(absent.getBody());
    }

    // ── 시각이 실제로 판정에 쓰인다 ─────────────────────────────────────────

    /**
     * <b>같은 행</b>이 시각에 따라 404 → 200 → 410 으로 움직인다.
     *
     * <p>고정 픽스처 5개만으로는 "상태 컬럼을 읽어 분기했을 뿐"인 구현도 통과한다. 시계를 움직여
     * 같은 행의 코드가 바뀌는 것을 보여야 판정이 {@link Notices#status} 의 <b>시간 규칙</b>에서
     * 파생됐다는 증명이 된다(경계는 양끝 포함 — {@code /active} 와 같은 규칙이다).
     */
    @Test
    void theSameNoticeMovesThroughTheTableAsTimeMoves() {
        insert(new Row("N-WINDOW", "2026-07-29T12:00:00Z", "2026-07-29T13:00:00Z", 1, null));

        NOW.set(Instant.parse("2026-07-29T11:59:59Z"));
        assertThat(get("N-WINDOW").getStatusCode()).as("시작 1초 전 = 예약(숨김)").isEqualTo(HttpStatus.NOT_FOUND);

        NOW.set(Instant.parse("2026-07-29T12:00:00Z"));
        assertThat(get("N-WINDOW").getStatusCode()).as("시작 정각 = 포함").isEqualTo(HttpStatus.OK);

        NOW.set(Instant.parse("2026-07-29T13:00:00Z"));
        assertThat(get("N-WINDOW").getStatusCode()).as("종료 정각 = 포함").isEqualTo(HttpStatus.OK);

        NOW.set(Instant.parse("2026-07-29T13:00:01Z"));
        assertThat(get("N-WINDOW").getStatusCode()).as("종료 1초 후 = 끝남").isEqualTo(HttpStatus.GONE);
    }

    /**
     * 강한 차단 사유가 이긴다 — 삭제된 <b>동시에</b> 기간이 끝난 공지는 410 이 아니라 404 다.
     *
     * <p>{@link Notices#status} 의 우선순위(DELETED → OFF → EXPIRED → SCHEDULED → LIVE)를
     * 컨트롤러가 자기 순서로 다시 적으면(예: 기간을 먼저 보면) 여기서 갈라진다.
     */
    @Test
    void strongestBlockWins() {
        Row row = new Row("N-BOTH", null, "2026-07-28T00:00:00Z", 0, "2026-07-20T00:00:00Z");
        assertMatchesTable(row, Notices.Status.DELETED);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    /**
     * 픽스처를 넣고 → {@link Notices#status} 로 <b>기대 상태를 직접 계산</b>해 의도와 맞는지 확인한 뒤
     * → HTTP 코드가 결정표와 같은지 본다. 두 번째 단계가 "픽스처가 사실 다른 상태였다"는 거짓 통과를 막는다.
     */
    private ResponseEntity<Map> assertMatchesTable(Row row, Notices.Status intended) {
        insert(row);

        Notices.Status derived = Notices.status(
                row.active() == 1, row.deletedAt(), row.startsAt(), row.endsAt(), Notices.now(clockNow()));
        assertThat(derived).as("픽스처 %s 의 실제 상태", row.id()).isEqualTo(intended);

        ResponseEntity<Map> res = get(row.id());
        assertThat(res.getStatusCode()).as("%s(%s)", row.id(), derived).isEqualTo(EXPECTED.get(derived));
        return res;
    }

    private static Clock clockNow() {
        return Clock.fixed(NOW.get(), KST);
    }

    @SuppressWarnings("unchecked")
    private ResponseEntity<Map> get(String id) {
        return rest.getForEntity(baseUrl("/api/notices/" + id), Map.class);
    }

    private record Row(String id, String startsAt, String endsAt, int active, String deletedAt) {
    }

    private void insert(Row row) {
        jdbcClient.sql("""
                        INSERT INTO notices(id, title, body, starts_at, ends_at, active, priority, revision,
                                            deleted_at, created_by, created_at, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, 0, 1, ?, NULL, ?, ?)
                        """)
                .params(row.id(), "제목 " + row.id(), "본문 " + row.id(), row.startsAt(), row.endsAt(),
                        row.active(), row.deletedAt(), T0.toString(), T0.toString())
                .update();
    }
}
