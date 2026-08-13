package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.Map;
import online.hmb.events.BusinessEventQueryService;
import online.hmb.events.BusinessEventRecorder;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#496</b> — 멱등 엔드포인트의 재호출이 이벤트 스트림을 도배하지 않는다.
 *
 * <h2>무엇이 문제였나</h2>
 * {@code POST /api/me/tutorial-complete} 는 멱등이다(몇 번을 불러도 덱은 한 번만 생긴다). 그런데
 * 훅은 <b>호출마다 무조건 1행</b>을 남겼다. 퍼널 수치는 멀쩡했다 — tutorial 칸이
 * {@code MAX(CASE WHEN event='tutorial_complete' …)} 라 "1건 이상"이고 재호출에 둔감하다.
 * 망가지는 것은 <b>스트림의 신호 대 잡음비</b>다: 모달을 여러 번 닫은 유저 하나가 스트림 상단을
 * 같은 줄로 덮고, 그게 스트림을 읽는 유일한 이유("이 유저가 무엇을 했나"를 시간순으로 본다)를 갉는다.
 *
 * <h2>게이트를 플래그가 아니라 스트림에 둔 이유 (③이 그 계약)</h2>
 * "{@code users.tutorial_done} 이 0 → 1 로 바뀌는 순간에만 기록"으로도 재호출은 막힌다. 그러나
 * {@code record} 는 예외를 전부 삼키는 best-effort 라 <b>첫 기록이 실패하는 경로가 실재</b>하고,
 * 그때 플래그는 이미 1 이라 그 유저는 <b>영영 기록되지 않는다</b> — 퍼널이 그를 "튜토리얼 미도달"로
 * 오독한다. 결과물(스트림)을 보면 <b>자가 치유</b>한다.
 *
 * <h2>공허해지지 않게</h2>
 * ①의 "1행"은 <b>②의 퍼널 무회귀</b>와 같이 봐야 한다 — 훅을 통째로 지워도 ①은 통과하기 때문이다
 * (0행 ≠ 1행이라 실제로는 죽지만, "적게 남기는 것"이 목적인 계약은 언제나 이 방향으로 공허해질
 * 위험이 있어 반대 방향 단언을 붙인다). ③은 <b>①의 반대 방향</b>을 건다: 억제가 결손 고착으로
 * 바뀌지 않았는가.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class BusinessEventRecordOnceTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private BusinessEventRecorder recorder;

    @Resource
    private BusinessEventQueryService queryService;

    // ── ① 멱등 재호출 N 회 → 스트림엔 정확히 1행 ──────────────────────────

    @SuppressWarnings("rawtypes")
    @Test
    void repeatingTheIdempotentTutorialCallLeavesExactlyOneRowInTheStream() {
        String token = login("once_repeat");
        String userId = userIdOf("once_repeat");

        for (int i = 0; i < 5; i++) {
            ResponseEntity<Map> res = authPost("/api/me/tutorial-complete", token, null, Map.class);
            assertThat(res.getStatusCode())
                    .as("멱등 엔드포인트는 몇 번을 불러도 200 이다(억제는 스트림에서만 일어난다)")
                    .isEqualTo(HttpStatus.OK);
        }

        assertThat(countOf(userId, "tutorial_complete"))
                .as("멱등 호출 5회가 스트림에 5행을 쌓으면 안 된다(#496)")
                .isEqualTo(1);
    }

    // ── ② 퍼널 무회귀 — 잡음만 없애고 1급 지표는 그대로 ────────────────────

    @SuppressWarnings("rawtypes")
    @Test
    void suppressingTheNoiseDoesNotCostTheFunnelItsTutorialFlag() {
        String token = login("once_funnel");
        String userId = userIdOf("once_funnel");

        for (int i = 0; i < 3; i++) {
            authPost("/api/me/tutorial-complete", token, null, Map.class);
        }

        BusinessEventQueryService.FunnelResponse funnel = queryService.funnel();
        BusinessEventQueryService.FunnelUser row = funnel.users().stream()
                .filter(u -> u.userId().equals(userId))
                .findFirst()
                .orElseThrow(() -> new AssertionError("퍼널에 그 유저가 없다 — 훅이 통째로 죽었다"));

        assertThat(row.reached().tutorial())
                .as("중복 억제가 도달 판정을 깎으면 안 된다(고치려던 것은 잡음뿐이다)")
                .isTrue();
        assertThat(row.eventCount())
                .as("가입 1 + 튜토리얼 1 — 재호출이 여기에도 안 쌓인다")
                .isEqualTo(2);
    }

    // ── ③ 자가 치유 — 첫 기록이 실패한 상태에서 재호출하면 기록된다 ──────────

    /**
     * 억제의 축이 "플래그가 넘어갔나"였다면 이 시나리오에서 <b>영영 0행</b>이다. 스트림을 보므로
     * 다음 호출이 남긴다. 첫 기록 실패는 {@code record} 의 예외 봉인 때문에 <b>조용히</b> 일어나므로
     * (호출부는 반환값도 안 본다) 실제로 있을 수 있는 상태다 — 그것을 행 삭제로 재현한다.
     */
    @SuppressWarnings("rawtypes")
    @Test
    void aFailedFirstRecordIsHealedByTheNextCallInsteadOfBeingLockedOut() {
        String token = login("once_heal");
        String userId = userIdOf("once_heal");

        authPost("/api/me/tutorial-complete", token, null, Map.class);
        assertThat(countOf(userId, "tutorial_complete")).isEqualTo(1);

        // "첫 기록이 실패했다"의 재현: 플래그(users.tutorial_done)는 1 인데 스트림엔 행이 없는 상태.
        jdbcClient.sql("DELETE FROM business_events WHERE user_id = ? AND event = 'tutorial_complete'")
                .param(userId).update();
        assertThat(jdbcClient.sql("SELECT tutorial_done FROM users WHERE id = ?")
                .param(userId).query(Integer.class).single())
                .as("이 시나리오의 전제 — 플래그는 이미 넘어가 있다")
                .isEqualTo(1);

        authPost("/api/me/tutorial-complete", token, null, Map.class);

        assertThat(countOf(userId, "tutorial_complete"))
                .as("플래그 전이로 게이트했다면 여기서 0 이다 — 억제가 결손 고착이 되면 안 된다(#496)")
                .isEqualTo(1);
    }

    // ── ④ 무영향 규칙 유지: 중복 검사가 던져도 이벤트를 잃지 않는다(fail-open) ─

    /**
     * 중복 검사는 <b>부가 목적</b>이고 본 목적은 이벤트를 남기는 것이다. 그래서 조회가 실패하면
     * 건너뛰는 게 아니라 <b>그냥 기록</b>해야 한다 — {@code probe} 의 fallback 이 {@code false} 인 이유.
     * 표를 지워 조회를 실제로 던지게 만든다(존재하지 않는 테이블 = SQL 예외).
     */
    @Test
    void whenTheDuplicateCheckItselfFailsTheEventIsStillRecorded() {
        String userId = "01JZZZONCEFAILOPEN00000001";
        jdbcClient.sql("ALTER TABLE business_events RENAME TO business_events_hidden").update();
        try {
            // 조회도 기록도 전부 던지지만 호출부로는 아무것도 새지 않는다(예외 봉인).
            recorder.recordOnce("tutorial_complete", userId, () -> Map.of("grantedDeck", true));
        } finally {
            jdbcClient.sql("ALTER TABLE business_events_hidden RENAME TO business_events").update();
        }

        // 표가 돌아온 뒤 다시 부르면 기록된다 — 검사 실패가 그 유저를 영구 차단하지 않았다.
        recorder.recordOnce("tutorial_complete", userId, () -> Map.of("grantedDeck", true));
        assertThat(countOf(userId, "tutorial_complete"))
                .as("fail-open — 중복 검사 실패가 이벤트를 잃게 만들면 안 된다")
                .isEqualTo(1);
    }

    /** 계측이 꺼져 있으면 중복 조회조차 돌지 않는다(오버헤드 0 — probe 의 성질). */
    @Test
    void theRollbackSwitchSkipsTheDuplicateQueryToo() {
        String userId = "01JZZZONCEDISABLED0000001";
        jdbcClient.sql("ALTER TABLE business_events RENAME TO business_events_hidden").update();
        try {
            BusinessEventRecorder off = new BusinessEventRecorder(jdbcClient, new com.fasterxml.jackson.databind.ObjectMapper(), false);
            // 표가 없는데도 던지지 않는다 = 조회에 도달하지 않았다.
            off.recordOnce("tutorial_complete", userId, () -> Map.of("grantedDeck", true));
        } finally {
            jdbcClient.sql("ALTER TABLE business_events_hidden RENAME TO business_events").update();
        }
        assertThat(countOf(userId, "tutorial_complete")).isZero();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private long countOf(String userId, String event) {
        return jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = ? AND event = ?")
                .params(userId, event).query(Long.class).single();
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }
}
