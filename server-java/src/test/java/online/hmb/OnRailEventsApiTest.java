package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.events.BusinessEvent;
import online.hmb.events.BusinessEventQueryService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>#504 D2 — 온레일 관측 입구</b>({@code POST /api/me/onrail-events}).
 *
 * <h2>이 계약이 지키는 것</h2>
 * 조사(#504)가 확정한 결손은 하나였다 — 온레일은 서버에 아무것도 안 남겨서
 * <b>"제안을 못 받았다"와 "제안을 받고 거절했다"의 서버 흔적이 완전히 같다.</b> 그래서
 * ①의 표본은 값 하나가 아니라 <b>그 두 상태가 실제로 갈리는가</b>다(그게 이 웨이브의 존재 이유).
 *
 * <h2>공허해지지 않게</h2>
 * "기록된다"만 걸면 화이트리스트를 통째로 지운 변이체가 통과한다(더 많이 기록되니까). 그래서
 * 반대 방향(②미지 이벤트 거절 · ⑥서버 사실 위조 불가)을 같이 건다. ⑤는 억제가 <b>결손 고착</b>으로
 * 바뀌지 않았는지 — {@code onrail_step} 까지 {@code recordOnce} 로 좁히면 "어디까지 갔나"가 통째로
 * 사라지는데, 그 방향의 변이는 ①④ 만으로는 안 죽는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class OnRailEventsApiTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private BusinessEventQueryService queryService;

    // ── ① 제안 노출 · 거절이 서로 다른 행으로 남는다 (이 웨이브의 존재 이유) ──

    @SuppressWarnings("rawtypes")
    @Test
    void anOfferThatWasShownAndThenDeclinedIsDistinguishableFromOneThatWasNeverShown() {
        String shownToken = login("or_declined");
        String shownId = userIdOf("or_declined");
        assertThat(post(shownToken, BusinessEvent.ONRAIL_OFFER_SHOWN).getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat(post(shownToken, BusinessEvent.ONRAIL_DECLINED).getStatusCode()).isEqualTo(HttpStatus.OK);

        // 대조군 — 하단탭으로 우회해 제안 자체를 못 받은 유저(#504 D1 이 만드는 상태).
        String missedToken = login("or_missed");
        String missedId = userIdOf("or_missed");
        ResponseEntity<Map> missed = post(missedToken,
                Map.of("event", BusinessEvent.ONRAIL_OFFER_MISSED, "path", "/game"));
        assertThat(missed.getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(countOf(shownId, BusinessEvent.ONRAIL_OFFER_SHOWN)).isEqualTo(1);
        assertThat(countOf(shownId, BusinessEvent.ONRAIL_DECLINED)).isEqualTo(1);
        assertThat(countOf(shownId, BusinessEvent.ONRAIL_OFFER_MISSED))
                .as("제안을 받은 유저에겐 우회 이벤트가 없다")
                .isZero();

        assertThat(countOf(missedId, BusinessEvent.ONRAIL_OFFER_MISSED)).isEqualTo(1);
        assertThat(countOf(missedId, BusinessEvent.ONRAIL_DECLINED))
                .as("제안을 못 받은 것은 거절이 아니다 — 이 둘이 갈리지 않으면 #504 는 답을 못 낸다")
                .isZero();
        assertThat(propsOf(missedId, BusinessEvent.ONRAIL_OFFER_MISSED))
                .as("어느 경로로 우회했는지가 같이 남아야 D1 처방을 고를 수 있다")
                .contains("\"path\":\"/game\"");
    }

    // ── ② 미지 이벤트는 400 (조용히 삼키면 오타가 결손으로 굳는다) ──────────

    @SuppressWarnings("rawtypes")
    @Test
    void anUnknownEventIsRejectedRatherThanSilentlyDropped() {
        String token = login("or_unknown");
        String userId = userIdOf("or_unknown");

        assertThat(post(token, "onrail_typo").getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(post(token, "").getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        ResponseEntity<Map> empty = authPost("/api/me/onrail-events", token, Map.of(), Map.class);
        assertThat(empty.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);

        assertThat(totalOf(userId))
                .as("거절된 요청은 부수효과 0")
                .isZero();
    }

    // ── ③ 인증이 먼저다 ───────────────────────────────────────────────────

    @Test
    void reportingRequiresASession() {
        HttpResult res = postJson("/api/me/onrail-events",
                Map.of("event", BusinessEvent.ONRAIL_OFFER_SHOWN));
        assertThat(res.status()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    // ── ④ 한 번뿐인 사건은 유저당 1행 (#496 관용구) ───────────────────────

    @Test
    void repeatedReportsOfAOneTimeEventLeaveExactlyOneRow() {
        String token = login("or_repeat");
        String userId = userIdOf("or_repeat");

        for (int i = 0; i < 5; i++) {
            post(token, BusinessEvent.ONRAIL_ACCEPTED);
        }

        assertThat(countOf(userId, BusinessEvent.ONRAIL_ACCEPTED))
                .as("새로고침·재진입이 스트림을 도배하면 스트림을 읽는 이유가 사라진다")
                .isEqualTo(1);
    }

    // ── ⑤ 스텝은 반복이 의미다 — 억제가 여기까지 오면 진행도가 사라진다 ────

    @Test
    void stepReportsAccumulateSoTheDropOffPointIsReadable() {
        String token = login("or_steps");
        String userId = userIdOf("or_steps");

        List<String> steps = List.of("deck-player", "deck-prompt", "deck-save", "start-match");
        for (String step : steps) {
            post(token, Map.of("event", BusinessEvent.ONRAIL_STEP, "stepId", step));
        }

        assertThat(countOf(userId, BusinessEvent.ONRAIL_STEP))
                .as("스텝을 recordOnce 로 좁히면 '어디서 이탈했나'가 통째로 사라진다")
                .isEqualTo(steps.size());
        assertThat(propsOf(userId, BusinessEvent.ONRAIL_STEP))
                .as("어느 스텝인지가 props 에 남아야 이탈 지점을 읽는다")
                .contains("\"stepId\":\"start-match\"");
    }

    // ── ⑥ 클라는 서버 사실을 위조할 수 없다 ──────────────────────────────

    @Test
    void aClientCannotForgeAServerSideFactThroughThisDoor() {
        String token = login("or_forge");
        String userId = userIdOf("or_forge");

        for (String serverFact : List.of(BusinessEvent.MATCH_FINISH, BusinessEvent.MATCH_START,
                BusinessEvent.TUTORIAL_COMPLETE, BusinessEvent.GACHA_PULL, BusinessEvent.USER_SIGNUP)) {
            assertThat(post(token, serverFact).getStatusCode())
                    .as(serverFact + " 는 서버가 자기 동작 중에 남기는 사실이다 — 이 입구로 들어오면 안 된다")
                    .isEqualTo(HttpStatus.BAD_REQUEST);
        }
        assertThat(totalOf(userId)).isZero();

        assertThat(BusinessEvent.KNOWN)
                .as("기록만 되고 조회 필터가 400 이면 읽을 수 없다")
                .containsAll(BusinessEvent.CLIENT_REPORTABLE);
        assertThat(BusinessEvent.CLIENT_REPORTABLE)
                .as("클라 보고 가능 집합은 KNOWN 의 진부분집합이어야 한다")
                .hasSizeLessThan(BusinessEvent.KNOWN.size());
        assertThat(BusinessEvent.CLIENT_REPORTABLE)
                .as("반복이 의미를 갖는 onrail_step 은 유저당 1행 억제 대상이 아니다")
                .containsAll(BusinessEvent.CLIENT_ONCE_PER_USER);
        assertThat(BusinessEvent.CLIENT_ONCE_PER_USER).doesNotContain(BusinessEvent.ONRAIL_STEP);
    }

    // ── ⑦ 기록한 것을 실제로 읽을 수 있다(조회 필터 무회귀) ────────────────

    @Test
    void theRecordedOnRailEventsAreReadableThroughTheAdminStream() {
        String token = login("or_readback");
        String userId = userIdOf("or_readback");
        post(token, BusinessEvent.ONRAIL_OFFER_SHOWN);
        post(token, Map.of("event", BusinessEvent.ONRAIL_STEP, "stepId", "deck-save"));

        BusinessEventQueryService.EventPage page =
                queryService.page(BusinessEvent.ONRAIL_STEP, userId, null, null, null);
        assertThat(page.items())
                .as("KNOWN 에 안 들면 여기서 400 이 난다 — 기록해 놓고 못 읽는 상태")
                .hasSize(1);
    }

    // ── ⑧ 기록이 실패해도 이 문은 200 이다 (계측이 동선을 막지 않는다) ─────

    /**
     * 무영향 설계의 클라 쪽 절반은 <b>"클라가 응답으로 분기할 것이 없다"</b>이다. 서버가 기록
     * 실패를 5xx 로 올리면 그 전제가 깨지고, 온레일 계측 한 줄이 튜토리얼 화면에 에러를 띄운다.
     *
     * <p>표를 잠시 치워 INSERT 를 <b>실제로 실패시킨다</b> — 예외를 삼키는 코드를 "삼키는지"
     * 확인하려면 던지는 상황을 만들어야 한다(구 롤백 스위치 계약이 쓰는 관용구, #496).
     */
    @SuppressWarnings("rawtypes")
    @Test
    void aFailedWriteStillAnswersOkSoTheTutorialNeverStops() {
        String token = login("or_failopen");
        String userId = userIdOf("or_failopen");

        jdbcClient.sql("ALTER TABLE business_events RENAME TO business_events_hidden_504").update();
        try {
            ResponseEntity<Map> res = post(token, BusinessEvent.ONRAIL_DONE);
            assertThat(res.getStatusCode())
                    .as("계측 실패가 5xx 가 되면 클라가 분기할 것이 생기고, 그 순간 계측이 동선을 막는다")
                    .isEqualTo(HttpStatus.OK);
        } finally {
            jdbcClient.sql("ALTER TABLE business_events_hidden_504 RENAME TO business_events").update();
        }

        assertThat(countOf(userId, BusinessEvent.ONRAIL_DONE))
                .as("삼킨 것은 예외지 사실이 아니다 — 그 호출은 행을 남기지 못했다")
                .isZero();
    }

    // ── helpers ──────────────────────────────────────────────────────────

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> post(String token, String event) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("event", event);
        return authPost("/api/me/onrail-events", token, body, Map.class);
    }

    @SuppressWarnings("rawtypes")
    private ResponseEntity<Map> post(String token, Map<String, Object> body) {
        return authPost("/api/me/onrail-events", token, body, Map.class);
    }

    private long countOf(String userId, String event) {
        return jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = ? AND event = ?")
                .params(userId, event).query(Long.class).single();
    }

    private long totalOf(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM business_events WHERE user_id = ? AND event LIKE 'onrail_%'")
                .param(userId).query(Long.class).single();
    }

    private String propsOf(String userId, String event) {
        return String.join("|", jdbcClient.sql(
                        "SELECT COALESCE(props_json,'') FROM business_events WHERE user_id = ? AND event = ?")
                .params(userId, event).query(String.class).list());
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?")
                .param(nickname).query(String.class).single();
    }
}
