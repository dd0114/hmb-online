package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.time.Clock;
import java.time.Instant;
import java.time.ZoneId;
import java.util.HashMap;
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
 * 공지 admin CRUD + 감사 원장 (#248 §2.2 · §5 server 3·4·5·6).
 *
 * <p><b>economy(#209) 운영과 같은 것</b>: admin 게이트 · 사유 필수 · <b>성공·실패 모두</b>
 * {@code admin_ops_audit}(V18) 기록 · 재배포 0.
 * <b>다른 것</b>: 공지는 발행물의 파생이 아니라 운영자가 만드는 데이터라, override 파일도
 * 리로드 호출도 없다 — <b>쓰면 곧 다음 조회에 반영된다</b>. 그래서 이 클래스의 핵심 테스트는
 * "200 을 받았다"가 아니라 <b>"쓴 것이 유저 피드에 그대로 나타난다"</b>를 본다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
// 실행 순서를 **고정**한다. 순서가 자유로우면 "우연히 먼저 도는 덕에 통과하는" 테스트가 섞이고,
// 메서드 하나를 추가·개명한 무관한 사람이 빨간 CI 를 물려받는다(독립검증 m3 — 실제로
// everyActionKindIsRecordedUnderItsOwnName 이 그 상태였다). 고정 + reset() 이 원장까지 비우는
// 두 장치가 함께 있어야 각 테스트가 진짜로 독립이다.
@org.junit.jupiter.api.TestMethodOrder(org.junit.jupiter.api.MethodOrderer.MethodName.class)
class AdminNoticeOpsTest extends ApiTestBase {

    private static final String ADMIN_NICK = "noticeadmin";
    private static final String ADMIN_PW = "notice-admin-pw-1234";

    private static final ZoneId KST = ZoneId.of("Asia/Seoul");
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
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    @BeforeEach
    void reset() {
        NOW.set(T0);
        jdbcClient.sql("DELETE FROM notices").update();
        // 원장도 비운다 — 안 비우면 "이 테스트가 남긴 행"과 "앞 테스트가 남긴 행"을 구분할 수 없어
        // containsExactly 류 단언이 **실행 순서에 기대게** 된다(독립검증 m3).
        jdbcClient.sql("DELETE FROM admin_ops_audit").update();
    }

    // ── 게이트(§5-6) ───────────────────────────────────────────────────────

    /**
     * 비-admin 은 <b>모든</b> 공지 엔드포인트에서 403이고 <b>부수효과가 0</b>이다.
     * (상태코드만 보면 "403 인데 행이 생겼다"를 못 잡는다 — AdminGateTest 가 배운 규율.)
     */
    @Test
    void everyNoticeOpsEndpointIsBehindTheAdminGate() {
        String user = login("notice_plain");
        long auditBefore = auditCount();

        assertThat(authGet("/api/admin/notices", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authGet("/api/admin/notices/history", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authPost("/api/admin/notices", user,
                Map.of("title", "t", "body", "b", "reason", "x"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authPut("/api/admin/notices/ANY", user,
                Map.of("title", "t", "body", "b", "reason", "x"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authPost("/api/admin/notices/ANY/active", user,
                Map.of("active", false, "reason", "x"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);
        assertThat(authDelete("/api/admin/notices/ANY?reason=x", user, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.FORBIDDEN);

        assertThat(noticeCount()).as("403 인데 공지 행이 생겼다").isZero();
        assertThat(auditCount()).as("403 인데 원장이 늘었다").isEqualTo(auditBefore);
    }

    // ── 쓰면 곧 반영(§5 web 1 의 서버측 전제) ────────────────────────────────

    /**
     * <b>이 모듈의 존재 이유</b>: 운영자가 저장하면 <b>재배포·리로드 없이</b> 다음 유저 조회에
     * 나타난다. economy 는 override + reload 2단계였지만 공지는 DB 가 SoT 라 1단계다.
     */
    @Test
    void whatAdminWritesShowsUpInTheUserFeedImmediately() {
        assertThat(publicIds()).isEmpty();

        String id = created(create(Map.of(
                "title", "7/30 정기 점검",
                "body", "02:00~04:00 서버 점검이 있습니다.",
                "priority", 10,
                "reason", "점검 공지")));

        assertThat(publicIds()).containsExactly(id);
        assertThat(publicNotice(id)).containsEntry("title", "7/30 정기 점검")
                .containsEntry("revision", 1)
                .containsEntry("priority", 10);
    }

    // ── §5-3: revision 범프 규칙(변이체 킬 대상) ───────────────────────────

    /**
     * <b>revision 은 제목·본문이 실제로 바뀔 때만 오른다.</b>
     *
     * <p>왜 이 규칙이 값이 아니라 성질인가: 클라 24시간 억제 키가 {@code id@revision} 이다.
     * <ul>
     *   <li>내용 무관 변경(노출 토글·우선순위·기간)에 범프하면 → <b>전원 재표시</b>(운영자가 우선순위
     *       하나 만졌다고 전 유저에게 팝업이 다시 뜬다).</li>
     *   <li>내용 변경에 범프하지 않으면 → <b>오탈자 수정본이 억제된 유저에게 영원히 안 보인다</b>.</li>
     * </ul>
     *
     * <p><b>변이체 킬</b>: 구현을 "PUT 이면 항상 +1"로 바꾸면 아래 (2)(3)(4)가 깨지고,
     * "절대 안 올림"으로 바꾸면 (5)(6)이 깨진다. 한쪽만 있는 테스트는 둘 중 하나를 놓친다.
     */
    @Test
    void revisionBumpsOnlyWhenTitleOrBodyActuallyChanges() {
        String id = created(create(Map.of("title", "원본 제목", "body", "원본 본문", "reason", "생성")));
        assertThat(revisionOf(id)).as("(1) 생성 직후").isEqualTo(1);

        // (2) 같은 내용으로 다시 저장 — 운영 화면은 전체 폼을 그대로 PUT 한다.
        update(id, Map.of("title", "원본 제목", "body", "원본 본문", "reason", "변경 없이 저장"));
        assertThat(revisionOf(id)).as("(2) 내용 동일 재저장").isEqualTo(1);

        // (3) 우선순위·기간만 변경
        update(id, Map.of("title", "원본 제목", "body", "원본 본문", "priority", 5,
                "startsAt", "2026-07-29T00:00:00Z", "endsAt", "2026-08-05T00:00:00Z",
                "reason", "노출 순서 조정"));
        assertThat(revisionOf(id)).as("(3) 우선순위·기간만 변경").isEqualTo(1);

        // (4) 노출 토글 off → on
        setActive(id, false, "임시 내림");
        setActive(id, true, "다시 올림");
        assertThat(revisionOf(id)).as("(4) 노출 토글").isEqualTo(1);

        // (5) 제목 변경
        update(id, Map.of("title", "고친 제목", "body", "원본 본문", "reason", "오탈자 수정"));
        assertThat(revisionOf(id)).as("(5) 제목 변경").isEqualTo(2);

        // (6) 본문 변경
        update(id, Map.of("title", "고친 제목", "body", "고친 본문", "reason", "내용 보강"));
        assertThat(revisionOf(id)).as("(6) 본문 변경").isEqualTo(3);

        // 유저 피드도 새 revision 을 본다 = 클라 억제 키가 실제로 달라진다.
        assertThat(publicNotice(id)).containsEntry("revision", 3);
    }

    /**
     * <b>동시 수정이 revision 을 잃어버리지 않는다</b>(모듈 규율 "상태 전이는 CAS").
     *
     * <p>수정은 read(현재 revision) → write 다. 두 운영자가 같은 공지를 동시에 고치면 둘 다
     * revision 1 을 읽고 둘 다 2 를 쓴다 = <b>한 번의 내용 변경이 사라진다</b>. 클라 억제 키가
     * {@code id@revision} 이므로 그 손실은 곧 "고친 내용이 억제된 유저에게 안 보인다"이다.
     *
     * <p>단언은 개수가 아니라 <b>불변식</b>이다: {@code 최종 revision == 1 + 성공한 내용변경 수}.
     * CAS 가 있으면 진 쪽이 409 를 받아 성공 수에서 빠지므로 항상 성립하고, 없으면 덮어쓴 만큼
     * 어긋난다. 스케줄링에 기대는 단언(예: "409 가 반드시 1건")을 피해 부하 상황에서도 흔들리지 않는다.
     */
    @Test
    void concurrentUpdatesNeverLoseARevisionBump() throws Exception {
        String admin = adminToken();
        String id = created(create(Map.of("title", "경합", "body", "본문 0", "reason", "생성")));

        int writers = 6;
        var start = new java.util.concurrent.CountDownLatch(1);
        var pool = java.util.concurrent.Executors.newFixedThreadPool(writers);
        try {
            List<java.util.concurrent.Future<HttpStatus>> futures = new java.util.ArrayList<>();
            for (int i = 0; i < writers; i++) {
                final int n = i;
                futures.add(pool.submit(() -> {
                    start.await();
                    @SuppressWarnings("unchecked")
                    ResponseEntity<Map> res = authPut("/api/admin/notices/" + id, admin,
                            Map.of("title", "경합", "body", "본문 " + (n + 1), "reason", "동시 수정 " + n),
                            Map.class);
                    return HttpStatus.valueOf(res.getStatusCode().value());
                }));
            }
            start.countDown();

            int applied = 0;
            for (var f : futures) {
                HttpStatus status = f.get(30, java.util.concurrent.TimeUnit.SECONDS);
                assertThat(status).as("성공 아니면 409 여야 한다(조용한 200 이 문제다)")
                        .isIn(HttpStatus.OK, HttpStatus.CONFLICT);
                if (status == HttpStatus.OK) {
                    applied++;
                }
            }
            assertThat(applied).as("전부 졌으면 이 검사가 공허해진다").isPositive();
            assertThat(revisionOf(id))
                    .as("동시 수정 중 revision 범프가 유실됐다 — 고친 내용이 억제된 유저에게 안 보인다")
                    .isEqualTo(1 + applied);
        } finally {
            pool.shutdownNow();
        }
    }

    // ── §5-4: 성공·실패 모두 원장에 남는다 ─────────────────────────────────

    /**
     * <b>성공 행은 before/after 스냅샷이 실재해야 한다.</b>
     *
     * <p>이전 버전은 {@code detailJson.contains("error")} 만 봤는데, 실패 detail 에는 {@code error}
     * 키가 <b>항상</b> 들어가므로 그 단언은 동어반복이었다 — 실제로 성공 경로의 {@code before} 를
     * 통째로 지워도 605건 중 하나도 안 깨졌다(독립검증 변이체 A2 생존). 그래서 키 존재가 아니라
     * <b>값이 변경 전/후와 일치하는지</b>를 본다.
     */
    @Test
    void auditSnapshotsCarryTheActualBeforeAndAfterValues() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "원본 제목", "body", "원본 본문", "reason", "생성 사유")));

        Map<String, Object> createEntry = latestHistory(admin);
        assertThat(createEntry.get("action")).isEqualTo("notice_create");
        assertThat(createEntry.get("result")).isEqualTo("ok");
        assertThat(createEntry.get("reason")).isEqualTo("생성 사유");
        assertThat(createEntry.get("actor")).isEqualTo(ADMIN_NICK);
        // 생성은 before 가 없는 게 사실이다(대상이 없었다) — after 만 실재해야 한다.
        Map<String, Object> createDetail = detailOf(createEntry);
        assertThat(createDetail.get("before")).isNull();
        assertThat(snapshot(createDetail, "after")).containsEntry("title", "원본 제목")
                .containsEntry("revision", 1);

        update(id, Map.of("title", "고친 제목", "body", "고친 본문", "reason", "내용 수정"));

        Map<String, Object> updateDetail = detailOf(latestHistory(admin));
        // ★ 변이체 A2 킬 지점 — before 를 안 실으면 여기서 죽는다.
        assertThat(snapshot(updateDetail, "before")).containsEntry("title", "원본 제목")
                .containsEntry("body", "원본 본문")
                .containsEntry("revision", 1);
        assertThat(snapshot(updateDetail, "after")).containsEntry("title", "고친 제목")
                .containsEntry("body", "고친 본문")
                .containsEntry("revision", 2);
    }

    /**
     * <b>거절된 시도도 이력이고, 그 행만 보고 "어느 공지에 무엇을 넣으려 했나"가 복원돼야 한다</b>
     * (독립검증 B2).
     *
     * <p>이전 구현은 {@code before = requireLive(id)} 가 모든 검증기 <b>뒤</b>에 있어, 검증에서
     * 튕기면 원장에 {@code {"before":null,"after":null,"error":"reason 은 필수입니다…"}} 만 남았다.
     * 운영자가 공지 셋을 연달아 손보다 하나가 400 으로 튕기면 <b>세 줄이 전부 똑같아</b> 어느
     * 공지였는지 알 수 없다 — AC §2.2 가 막으려던 상황 그대로였다.
     */
    @Test
    void aRejectedAttemptRecordsWhichNoticeAndWhatWasAttempted() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "원본 제목", "body", "원본 본문", "reason", "생성")));
        long before = auditCount();

        Map<String, Object> noReason = new HashMap<>();
        noReason.put("title", "사유 없이 바꾸려던 제목");
        noReason.put("body", "본문");
        ResponseEntity<Map> rejected = authPut("/api/admin/notices/" + id, admin, noReason, Map.class);
        assertThat(rejected.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(auditCount()).as("거절된 시도가 원장에 안 남았다").isEqualTo(before + 1);
        Map<String, Object> entry = latestHistory(admin);
        assertThat(entry.get("action")).isEqualTo("notice_update");
        assertThat(entry.get("result")).isEqualTo("failed");

        Map<String, Object> detail = detailOf(entry);
        assertThat(detail.get("noticeId")).as("대상 id 가 실패 행에서 복원되지 않는다").isEqualTo(id);
        assertThat(snapshot(detail, "before")).as("당시 상태 스냅샷").containsEntry("title", "원본 제목");
        assertThat(snapshot(detail, "attempted")).as("무엇을 넣으려 했나")
                .containsEntry("title", "사유 없이 바꾸려던 제목");
        assertThat((String) detail.get("error")).contains("reason");

        // 거절은 부수효과 0 — 제목이 안 바뀌었다.
        assertThat(titleOf(id)).isEqualTo("원본 제목");
    }

    /** 생성 실패는 대상 행이 없다 — 그래서 {@code attempted}(요청 원문)가 유일한 복원 단서다. */
    @Test
    void aRejectedCreateRecordsWhatWasAttempted() {
        String admin = adminToken();
        assertThat(authPost("/api/admin/notices", admin,
                Map.of("title", "x".repeat(101), "body", "본문", "reason", "너무 긴 제목"), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        Map<String, Object> detail = detailOf(latestHistory(admin));
        assertThat(snapshot(detail, "attempted")).containsEntry("body", "본문");
        assertThat((String) snapshot(detail, "attempted").get("title")).hasSize(101);
    }

    /** 네 가지 액션이 각각 자기 이름으로 남는다(원장에서 "무슨 일이 있었나"가 복원 가능하다). */
    @Test
    void everyActionKindIsRecordedUnderItsOwnName() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "액션", "body", "본문", "reason", "생성")));
        update(id, Map.of("title", "액션2", "body", "본문", "reason", "수정"));
        setActive(id, false, "내림");
        delete(id, "삭제");

        List<String> actions = historyOf(admin).stream().map(e -> (String) e.get("action")).toList();
        assertThat(actions).containsExactly(   // 최신순
                "notice_delete", "notice_active", "notice_update", "notice_create");
    }

    // ── MAJ-1: PUT 의 전체 치환 규약을 놀랍지 않게 만든다 ──────────────────

    /**
     * <b>PUT 은 부분 패치가 아니라 전체 치환이다</b> — 안 보낸 기간·우선순위는 <b>지워진다</b>.
     *
     * <p>독립검증이 이걸 MAJ-1 으로 잡았다(예약 공지에 제목만 고쳐 보냈더니 SCHEDULED 가
     * 즉시 전체공개·영구노출로 바뀜). 규약 자체는 유지하되 <b>계약으로 박아</b>서, 나중에 누가
     * "부분 패치인 줄 알았다"고 말할 수 없게 한다. web 폼은 항상 전체 필드를 보내야 한다.
     */
    @Test
    void updateIsAFullReplaceNotAPatch() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "예약 공지", "body", "본문", "priority", 9,
                "startsAt", "2026-08-01T00:00:00Z", "endsAt", "2026-09-01T00:00:00Z",
                "reason", "생성")));
        assertThat(adminNotice(admin, id)).containsEntry("status", "SCHEDULED")
                .containsEntry("priority", 9);

        update(id, Map.of("title", "예약 공지", "body", "본문", "reason", "제목만 손댔다고 생각한 저장"));

        Map<String, Object> after = adminNotice(admin, id);
        assertThat(after.get("startsAt")).as("전체 치환 — 안 보낸 기간은 지워진다").isNull();
        assertThat(after.get("endsAt")).isNull();
        assertThat(after).containsEntry("priority", 0)
                .containsEntry("status", "LIVE");
    }

    /**
     * <b>수정 바디의 {@code active} 는 400 이다</b> — 조용히 무시하지 않는다(MAJ-1).
     *
     * <p>전체 치환 규약에서 한 필드만 무시하는 것이 가장 나쁜 비대칭이다: 운영자는 200 을 받고
     * "내렸다"고 믿는데 공지는 계속 유저에게 뜬다. 되돌릴 곳(전용 엔드포인트)을 메시지에 담아
     * 막다른 길을 만들지 않는다.
     */
    @Test
    void activeCannotBeChangedThroughUpdate() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "제목", "body", "본문", "reason", "생성")));

        ResponseEntity<Map> res = authPut("/api/admin/notices/" + id, admin,
                Map.of("title", "제목", "body", "본문", "active", false, "reason", "내리려던 시도"), Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat((String) res.getBody().get("message")).contains("/active");
        assertThat(adminNotice(admin, id)).as("400 인데 상태가 변했다").containsEntry("active", true);
        // 거절도 원장에 남고, 대상과 시도가 복원된다.
        assertThat(detailOf(latestHistory(admin))).containsEntry("noticeId", id);
    }

    // ── A1: 삭제된 공지는 모든 쓰기에서 없는 것이다 ─────────────────────────

    /**
     * soft delete 된 공지는 <b>수정·토글·재삭제가 전부 404</b> 다.
     *
     * <p>복구(undelete) 기능이 없는 상태에서 삭제된 행을 쓰기 가능하게 두면 "삭제했는데 유저에게
     * 떴다"가 가능해진다. {@code requireLive} 를 {@code require} 로 되돌리면 여기서 죽는다(변이체 A1).
     */
    @Test
    void deletedNoticesAre404ForEveryWriteOperation() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "삭제될 공지", "body", "본문", "reason", "생성")));
        delete(id, "잘못 올림");

        assertThat(authPut("/api/admin/notices/" + id, admin,
                Map.of("title", "되살리기", "body", "본문", "reason", "r"), Map.class).getStatusCode())
                .as("삭제된 공지 수정").isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authPost("/api/admin/notices/" + id + "/active", admin,
                Map.of("active", true, "reason", "r"), Map.class).getStatusCode())
                .as("삭제된 공지 재노출").isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authDelete("/api/admin/notices/" + id + "?reason=r", admin, Map.class).getStatusCode())
                .as("재삭제").isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(publicIds()).as("어떤 시도로도 되살아나지 않는다").isEmpty();
    }

    /**
     * 공지 이력은 <b>공지 액션만</b> 담는다. 원장 테이블은 economy(#209)와 공용이므로, 필터가
     * 느슨하면 운영자가 "공지 이력"을 보다가 남의 액션을 보게 된다.
     */
    @Test
    void historyIsScopedToNoticeActions() {
        String admin = adminToken();
        create(Map.of("title", "공지", "body", "본문", "reason", "생성"));

        // 사유 없는 economy 리로드 = 400 + economy_reload/failed 원장 행(같은 테이블).
        assertThat(authPost("/api/admin/economy/reload", admin, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(historyOf(admin)).isNotEmpty()
                .allSatisfy(e -> assertThat((String) e.get("action")).startsWith("notice_"));
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit WHERE action = 'economy_reload'")
                .query(Long.class).single()).as("전제: 남의 액션이 실제로 원장에 있다").isPositive();
    }

    /**
     * <b>{@code LIKE 'notice\_%' ESCAPE '\'} 의 escape 가 왜 있는가</b>(독립검증 A4).
     *
     * <p>{@code _} 는 LIKE 의 단일문자 와일드카드다. escape 를 빼면 {@code notice_%} 가
     * {@code noticeXcreate} 같은 <b>남의 액션까지</b> 잡는다. 원장은 economy(#209)·유닛 카탈로그(#207)와
     * 공용 테이블이고 앞으로도 트랙이 늘어나므로, 이름이 비슷한 액션이 실제로 생길 수 있다.
     * 그 상황을 원장에 직접 만들어 두고 안 섞이는지 본다 — escape 를 지우면 여기서 죽는다.
     */
    @Test
    void historyDoesNotLeakLookalikeActionNames() {
        String admin = adminToken();
        create(Map.of("title", "진짜 공지 액션", "body", "본문", "reason", "생성"));
        insertRawAudit("noticeXcreate");   // '_' 를 와일드카드로 읽으면 걸려든다
        insertRawAudit("noticesomething");

        assertThat(historyOf(admin)).hasSize(1)
                .allSatisfy(e -> assertThat((String) e.get("action")).isEqualTo("notice_create"));
    }

    // ── §5-5: 입력 검증 400 ────────────────────────────────────────────────

    @Test
    void validationRejectsBadInputAndCreatesNothing() {
        String admin = adminToken();

        assertRejected(admin, Map.of("title", "", "body", "본문", "reason", "r"), "빈 제목");
        assertRejected(admin, Map.of("title", "x".repeat(101), "body", "본문", "reason", "r"), "제목 101자");
        assertRejected(admin, Map.of("title", "제목", "body", "", "reason", "r"), "빈 본문");
        assertRejected(admin, Map.of("title", "제목", "body", "b".repeat(2001), "reason", "r"), "본문 2001자");
        assertRejected(admin, Map.of("title", "제목", "body", "본문", "reason", "r",
                "startsAt", "2026-08-10T00:00:00Z", "endsAt", "2026-08-01T00:00:00Z"), "기간 역전");
        assertRejected(admin, Map.of("title", "제목", "body", "본문", "reason", "r",
                "priority", 100000), "priority 범위 초과");
        assertRejected(admin, Map.of("title", "제목", "body", "본문", "reason", "r",
                "startsAt", "내일부터"), "파싱 불가한 시각");
        // 오프셋 없는 로컬 시각은 거부한다 — 서버가 존을 추측하면 공지가 9시간 틀린 시각에 뜬다.
        assertRejected(admin, Map.of("title", "제목", "body", "본문", "reason", "r",
                "startsAt", "2026-07-30T09:00:00"), "오프셋 없는 로컬 시각");
        assertRejected(admin, Map.of("title", "제목", "body", "본문"), "사유 누락");

        assertThat(noticeCount()).as("거절된 요청이 행을 만들었다").isZero();
    }

    /** 오프셋 표기는 받아서 UTC 로 정규화한다 — 운영자가 손으로 UTC 를 계산하다 하루를 틀리지 않게. */
    @Test
    void offsetTimesAreAcceptedAndNormalizedToUtcSeconds() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "KST 예약", "body", "본문", "reason", "r",
                "startsAt", "2026-07-30T09:00:00+09:00")));

        assertThat(adminNotice(admin, id)).containsEntry("startsAt", "2026-07-30T00:00:00Z");
    }

    /** 경계는 <b>포함</b>이다 — 100자 제목·2000자 본문은 통과한다(off-by-one 방지). */
    @Test
    void lengthLimitsAreInclusiveAtTheBoundary() {
        String id = created(create(Map.of("title", "x".repeat(100), "body", "b".repeat(2000), "reason", "경계")));
        assertThat(id).isNotBlank();
    }

    // ── §5: soft delete(Q6) ────────────────────────────────────────────────

    /**
     * 삭제는 <b>행을 지우지 않는다</b>. 감사 원장이 참조하는 대상이 사라지면 "무슨 공지를 왜
     * 내렸나"를 이력으로 복원할 수 없다 — 목록에서 안 보이면 운영상 삭제와 동등하다.
     */
    @Test
    void deleteIsSoftAndKeepsTheRowForTheAuditTrail() {
        String id = created(create(Map.of("title", "삭제될 공지", "body", "본문", "reason", "생성")));
        assertThat(publicIds()).containsExactly(id);

        delete(id, "잘못 올림");

        assertThat(publicIds()).as("유저 피드에서 사라진다").isEmpty();
        assertThat(rowExists(id)).as("행은 남는다(하드 삭제 없음)").isTrue();
        assertThat(adminNotice(adminToken(), id)).containsEntry("status", "DELETED");
    }

    // ── §5: admin 목록 = 전체 + 서버 판정 상태 ──────────────────────────────

    /**
     * admin 목록은 <b>중지·만료·삭제까지 전부</b> 보여주고, 상태를 <b>서버가 판정해서</b> 같이 내린다.
     * 화면이 다시 계산하면 유저 피드 규칙과 조용히 갈라진다(같은 데이터에 두 개의 진실).
     */
    @Test
    void adminListShowsEverythingWithAServerJudgedStatus() {
        String admin = adminToken();

        String live = created(create(Map.of("title", "지금", "body", "b", "reason", "r")));
        String scheduled = created(create(Map.of("title", "예약", "body", "b", "reason", "r",
                "startsAt", "2026-08-01T00:00:00Z")));
        String expired = created(create(Map.of("title", "만료", "body", "b", "reason", "r",
                "endsAt", "2026-07-29T11:00:00Z")));
        String off = created(create(Map.of("title", "중지", "body", "b", "reason", "r")));
        setActive(off, false, "내림");
        String deleted = created(create(Map.of("title", "삭제", "body", "b", "reason", "r")));
        delete(deleted, "삭제");

        Map<String, String> statuses = adminNotices(admin).stream()
                .collect(java.util.stream.Collectors.toMap(n -> (String) n.get("id"),
                        n -> (String) n.get("status")));

        assertThat(statuses).containsEntry(live, "LIVE")
                .containsEntry(scheduled, "SCHEDULED")
                .containsEntry(expired, "EXPIRED")
                .containsEntry(off, "OFF")
                .containsEntry(deleted, "DELETED");

        // 유저 피드는 LIVE 한 건만 본다 — 두 목록이 같은 규칙의 두 얼굴임을 못박는다.
        assertThat(publicIds()).containsExactly(live);
    }

    /** 상태는 <b>시계를 따라 움직인다</b>(고정 문자열이 아니다) — 예약 공지가 때가 되면 LIVE 가 된다. */
    @Test
    void statusFollowsTheClock() {
        String admin = adminToken();
        String id = created(create(Map.of("title", "예약", "body", "b", "reason", "r",
                "startsAt", "2026-08-01T00:00:00Z", "endsAt", "2026-08-02T00:00:00Z")));

        assertThat(adminNotice(admin, id)).containsEntry("status", "SCHEDULED");

        NOW.set(Instant.parse("2026-08-01T06:00:00Z"));
        assertThat(adminNotice(admin, id)).containsEntry("status", "LIVE");
        assertThat(publicIds()).containsExactly(id);

        NOW.set(Instant.parse("2026-08-03T00:00:00Z"));
        assertThat(adminNotice(admin, id)).containsEntry("status", "EXPIRED");
        assertThat(publicIds()).isEmpty();
    }

    /**
     * 없는 공지에 대한 수정·토글·삭제는 404 다(400 으로 뭉개면 운영자가 원인을 모른다).
     *
     * <p><b>바디까지 잘못된 경우에도 404 다</b> — 대상 조회가 검증보다 <b>먼저</b> 오기 때문이다(B2).
     * 이 순서가 바로 "실패 원장에 대상 id 가 남는다"를 만드는 것이고, 진단 순서로도 옳다:
     * 없는 공지에 "reason 이 필요합니다"라고 답하면 운영자는 사유를 채워 다시 보내고 또 실패한다.
     */
    @Test
    void operationsOnAMissingNoticeAre404EvenWhenTheBodyIsAlsoInvalid() {
        String admin = adminToken();
        assertThat(authPut("/api/admin/notices/NOPE", admin,
                Map.of("title", "t", "body", "b", "reason", "r"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authPost("/api/admin/notices/NOPE/active", admin,
                Map.of("active", false, "reason", "r"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authDelete("/api/admin/notices/NOPE?reason=r", admin, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);

        // 사유 누락 + 없는 id → 400 이 아니라 404(대상 부재가 더 강한 진단이다).
        assertThat(authPut("/api/admin/notices/NOPE", admin,
                Map.of("title", "t", "body", "b"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(authDelete("/api/admin/notices/NOPE", admin, Map.class).getStatusCode())
                .isEqualTo(HttpStatus.NOT_FOUND);
    }

    // ── helpers ────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private Map<String, Object> create(Map<String, Object> body) {
        ResponseEntity<Map> res = authPost("/api/admin/notices", adminToken(), body, Map.class);
        assertThat(res.getStatusCode()).as("생성 실패: " + res.getBody()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private static String created(Map<String, Object> view) {
        return (String) view.get("id");
    }

    @SuppressWarnings("unchecked")
    private void update(String id, Map<String, Object> body) {
        ResponseEntity<Map> res = authPut("/api/admin/notices/" + id, adminToken(), body, Map.class);
        assertThat(res.getStatusCode()).as("수정 실패: " + res.getBody()).isEqualTo(HttpStatus.OK);
    }

    @SuppressWarnings("unchecked")
    private void setActive(String id, boolean active, String reason) {
        ResponseEntity<Map> res = authPost("/api/admin/notices/" + id + "/active", adminToken(),
                Map.of("active", active, "reason", reason), Map.class);
        assertThat(res.getStatusCode()).as("토글 실패: " + res.getBody()).isEqualTo(HttpStatus.OK);
    }

    @SuppressWarnings("unchecked")
    private void delete(String id, String reason) {
        ResponseEntity<Map> res = authDelete("/api/admin/notices/" + id + "?reason=" + enc(reason),
                adminToken(), Map.class);
        assertThat(res.getStatusCode()).as("삭제 실패: " + res.getBody()).isEqualTo(HttpStatus.OK);
    }

    private void assertRejected(String admin, Map<String, Object> body, String why) {
        @SuppressWarnings("unchecked")
        ResponseEntity<Map> res = authPost("/api/admin/notices", admin, body, Map.class);
        assertThat(res.getStatusCode()).as(why).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> adminNotices(String admin) {
        ResponseEntity<Map> res = authGet("/api/admin/notices", admin, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("notices");
    }

    private Map<String, Object> adminNotice(String admin, String id) {
        return adminNotices(admin).stream().filter(n -> id.equals(n.get("id"))).findFirst().orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> publicNotices() {
        ResponseEntity<Map> res = rest.getForEntity(baseUrl("/api/notices/active"), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) res.getBody().get("notices");
    }

    private List<String> publicIds() {
        return publicNotices().stream().map(n -> (String) n.get("id")).toList();
    }

    private Map<String, Object> publicNotice(String id) {
        return publicNotices().stream().filter(n -> id.equals(n.get("id"))).findFirst().orElseThrow();
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> historyOf(String admin) {
        return authGet("/api/admin/notices/history", admin, List.class).getBody();
    }

    private Map<String, Object> latestHistory(String admin) {
        return historyOf(admin).get(0);
    }

    @SuppressWarnings("unchecked")
    private String adminToken() {
        ResponseEntity<Map> res = rest.postForEntity(baseUrl("/api/auth/login"),
                Map.of("nickname", ADMIN_NICK, "provider", "local", "password", ADMIN_PW), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) res.getBody().get("token");
    }

    /** 원장 행의 {@code detailJson} 을 실제로 열어 본다 — 키 존재가 아니라 값을 단언하기 위해. */
    @SuppressWarnings("unchecked")
    private static Map<String, Object> detailOf(Map<String, Object> auditEntry) {
        try {
            return MAPPER.readValue((String) auditEntry.get("detailJson"), Map.class);
        } catch (Exception e) {
            throw new IllegalStateException("detailJson 파싱 실패: " + auditEntry.get("detailJson"), e);
        }
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> snapshot(Map<String, Object> detail, String key) {
        Object value = detail.get(key);
        assertThat(value).as(key + " 스냅샷이 원장에 없다").isNotNull();
        return (Map<String, Object>) value;
    }

    /** 남의 트랙이 같은 원장에 append 한 상황을 만든다(액션 이름만 비슷한 행). */
    private void insertRawAudit(String action) {
        String adminId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(ADMIN_NICK)
                .query(String.class).single();
        jdbcClient.sql("""
                        INSERT INTO admin_ops_audit(id, actor_user_id, action, result, reason, detail_json, created_at)
                        VALUES (?, ?, ?, 'ok', '남의 트랙', '{}', ?)
                        """)
                .params(online.hmb.common.Ulid.next(), adminId, action, T0.toString())
                .update();
    }

    private static String enc(String s) {
        return java.net.URLEncoder.encode(s, java.nio.charset.StandardCharsets.UTF_8);
    }

    private int revisionOf(String id) {
        return jdbcClient.sql("SELECT revision FROM notices WHERE id = ?").param(id)
                .query(Integer.class).single();
    }

    private String titleOf(String id) {
        return jdbcClient.sql("SELECT title FROM notices WHERE id = ?").param(id)
                .query(String.class).single();
    }

    private boolean rowExists(String id) {
        return jdbcClient.sql("SELECT COUNT(*) FROM notices WHERE id = ?").param(id)
                .query(Long.class).single() == 1L;
    }

    private long noticeCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM notices").query(Long.class).single();
    }

    private long auditCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit").query(Long.class).single();
    }
}
