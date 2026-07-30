package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * 우편함 <b>admin 쪽</b> 계약(#323): 발송 멱등 · 검증 · 브로드캐스트 · 회수 · 감사 · 게이트.
 *
 * <p>거절 케이스는 상태코드만 보지 않는다 — <b>부수효과 0</b>(캠페인 행·수신 행·지갑)을 함께 단언한다.
 * "400 인데 절반 보내졌다"가 이 도메인에서 가장 비싼 실패다(회수도 재발송도 어렵다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminMailSendTest extends ApiTestBase {

    private static final String ADMIN_NICK = "mailsend_admin";
    private static final String ADMIN_PW = "mailsend-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    // ── 멱등 ─────────────────────────────────────────────────────────────

    /** 같은 키 + 같은 내용 = 재전송. <b>200</b>(201 이 아니다) + {@code applied:false} + 우편은 한 통. */
    @Test
    void resendingWithTheSameKeyAndBodyDoesNotSendTwice() {
        String admin = adminToken();
        String userId = user("ml_idem");

        HttpResult first = send(admin, targeted(userId, 100L), "idem-same-1");
        assertThat(first.status()).as(first.body()).isEqualTo(HttpStatus.CREATED);
        assertThat(asMap(first).get("applied")).isEqualTo(true);

        HttpResult second = send(admin, targeted(userId, 100L), "idem-same-1");
        assertThat(second.status()).as(second.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(second).get("applied")).isEqualTo(false);
        assertThat(asMap(second).get("campaignId")).isEqualTo(asMap(first).get("campaignId"));

        assertThat(campaignCount("idem-same-")).isEqualTo(1);
        assertThat(inboxCount(userId)).isEqualTo(1);
    }

    /**
     * 같은 키 + <b>다른 내용</b> = 다른 요청이다. 409 로 거절한다.
     *
     * <p>조용히 삼키면(200 applied:false) 운영자는 금액을 잘못 넣고 정정 재전송했을 때
     * <b>성공했다고 믿는데 아무 일도 일어나지 않는다</b> — {@code AdminPointsService} 가 실측으로
     * 겪은 함정이고, 여기선 대상이 전체 유저일 수 있어 더 비싸다.
     */
    @Test
    void sameKeyWithDifferentContentIsRejected() {
        String admin = adminToken();
        String userId = user("ml_conf");

        assertThat(send(admin, targeted(userId, 100L), "idem-conflict-1").status())
                .isEqualTo(HttpStatus.CREATED);

        HttpResult changed = send(admin, targeted(userId, 99999L), "idem-conflict-1");
        assertThat(changed.status()).as(changed.body()).isEqualTo(HttpStatus.CONFLICT);

        assertThat(campaignCount("idem-conflict-")).as("두 번째는 아무것도 만들지 않는다").isEqualTo(1);
        assertThat(inboxCount(userId)).isEqualTo(1);
    }

    /**
     * <b>같은 키 · 같은 인원수 · 다른 수신자 = 다른 요청이다.</b>
     *
     * <p>독립검증 BLOCKER-1 이 정확히 이 구멍이었다: 멱등 비교가 대상을 <b>인원 "수"</b>로만 봐서,
     * 같은 키로 수신자만 바꾼 요청이 200 재생으로 삼켜졌다 — 운영자는 B 에게 보냈다고 믿는데
     * <b>B 는 아무것도 받지 못한다</b>. 금액만 바꾸는 기존 계약은 이 축을 구조적으로 못 본다.
     */
    @Test
    void sameKeyWithDifferentRecipientsIsRejected() {
        String admin = adminToken();
        String a = user("ml_rcp_a");
        String b = user("ml_rcp_b");

        assertThat(send(admin, targeted(a, 100L), "idem-rcp-1").status()).isEqualTo(HttpStatus.CREATED);

        HttpResult swapped = send(admin, targeted(b, 100L), "idem-rcp-1");
        assertThat(swapped.status()).as(swapped.body()).isEqualTo(HttpStatus.CONFLICT);

        assertThat(inboxCount(a)).isEqualTo(1);
        assertThat(inboxCount(b)).as("삼켜지면 여기가 0 인 채로 200 이 돌아온다").isZero();
        assertThat(campaignCount("idem-rcp-")).isEqualTo(1);
    }

    /**
     * <b>상대 만료(expiresInDays)로 보낸 뒤 초가 지나 같은 바디를 재전송해도 200 재생</b>이어야 한다.
     *
     * <p>독립검증 BLOCKER-2: 멱등 비교가 <b>파생된 절대 시각</b>을 보던 탓에 1초만 지나도 같은 바디가
     * "다른 내용"이 되어 409 가 났다 — 그것도 멱등키가 존재하는 정확히 그 상황(타임아웃 후 재전송)에서.
     * 안내대로 새 키를 쓰면 두 번째 캠페인이 생겨 <b>전 수신자에게 이중 지급</b>된다.
     */
    @Test
    void relativeExpiryResendIsStillTheSameRequest() throws InterruptedException {
        String admin = adminToken();
        String userId = user("ml_relexp");

        Map<String, Object> body = targeted(userId, 10L);
        body.put("expiresInDays", 14);

        HttpResult first = send(admin, body, "idem-relexp-1");
        assertThat(first.status()).as(first.body()).isEqualTo(HttpStatus.CREATED);

        // 초가 바뀌도록 기다린다 — 파생 시각 비교였다면 여기서 409 가 난다.
        Thread.sleep(1_100);

        HttpResult again = send(admin, body, "idem-relexp-1");
        assertThat(again.status()).as(again.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(again).get("applied")).isEqualTo(false);
        assertThat(asMap(again).get("campaignId")).isEqualTo(asMap(first).get("campaignId"));
        assertThat(inboxCount(userId)).as("두 번째 우편이 생기면 이중 지급이다").isEqualTo(1);
    }

    /**
     * 회수 상태가 <b>유저 화면에도</b> 반영된다 — 목록이 EXPIRED, 뱃지는 0.
     *
     * <p>독립검증 MAJOR-4: {@code MailService.state()} 에서 회수 판정을 지워도 전 스위트가 green
     * 이었다. 그 상태의 실제 화면은 <b>뱃지는 0인데 목록엔 살아 있는 [받기] 버튼</b>이고, 누르면
     * 410 이다 — "뱃지와 목록이 어긋난다"를 금지한 계약이 정작 회수 축을 안 보고 있었다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void revokedMailShowsAsExpiredInTheUsersList() {
        String admin = adminToken();
        String token = login("ml_rvstate");
        String userId = userIdOf("ml_rvstate");

        HttpResult sent = send(admin, targeted(userId, 500L), "idem-rvstate-1");
        String campaignId = (String) asMap(sent).get("campaignId");

        Map<String, Object> before = asMap(get("/api/mails", token));
        assertThat(((List<Map<String, Object>>) before.get("mails")).get(0).get("state")).isEqualTo("UNREAD");
        assertThat(((Number) before.get("unread")).intValue()).isEqualTo(1);

        postJsonAuth("/api/admin/mails/" + campaignId + "/revoke", admin,
                Map.of("reason", "오발송"), null);

        Map<String, Object> after = asMap(get("/api/mails", token));
        assertThat(((List<Map<String, Object>>) after.get("mails")).get(0).get("state"))
                .as("회수는 유저에게 만료와 같은 얼굴이다")
                .isEqualTo("EXPIRED");
        assertThat(((Number) after.get("unread")).intValue()).isZero();
    }

    /** 검증 실패한 회수도 감사에 남는다 — 발송과 같은 규율(독립검증 MINOR-2). */
    @Test
    void revokeWithoutReasonIsAudited() {
        String admin = adminToken();
        String userId = user("ml_rvaudit");
        String campaignId = (String) asMap(send(admin, targeted(userId, 10L), "idem-rvaudit-1"))
                .get("campaignId");

        long before = auditRows("mail_revoke", "failed");
        HttpResult res = postJsonAuth("/api/admin/mails/" + campaignId + "/revoke", admin, Map.of(), null);
        assertThat(res.status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(auditRows("mail_revoke", "failed")).isEqualTo(before + 1);
    }

    /**
     * 수신자 <b>순서</b>만 다른 재전송은 같은 요청이다(독립검증 m1 — 정렬에 계약이 없었다).
     *
     * <p>정렬을 빼면 `[a,b]` 와 `[b,a]` 가 다른 해시가 되어 <b>같은 의도의 재전송이 409</b> 가 되고,
     * 운영자가 안내대로 새 키를 쓰면 두 번 발행된다(BL-2 와 같은 함정의 다른 입구).
     */
    @Test
    void recipientOrderDoesNotChangeTheRequest() {
        String admin = adminToken();
        String a = user("ml_ord_a");
        String b = user("ml_ord_b");

        Map<String, Object> first = base();
        first.put("audience", "USERS");
        first.put("userIds", List.of(a, b));
        assertThat(send(admin, first, "idem-order-1").status()).isEqualTo(HttpStatus.CREATED);

        Map<String, Object> reversed = base();
        reversed.put("audience", "USERS");
        reversed.put("userIds", List.of(b, a));
        HttpResult again = send(admin, reversed, "idem-order-1");

        assertThat(again.status()).as(again.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(again).get("applied")).isEqualTo(false);
        assertThat(inboxCount(a)).isEqualTo(1);
        assertThat(inboxCount(b)).isEqualTo(1);
    }

    /**
     * 같은 시각의 <b>표기</b>만 다른 재전송은 같은 요청이다(독립검증 3R m4 — 계약이 없었다).
     *
     * <p>{@code …T00:00:00Z} 와 {@code …T00:00:00.000Z} 는 같은 순간인데 문자열이 달라 409 가 났다 —
     * BLOCKER-2 와 같은 함정의 좁은 버전이고, 안내대로 새 키를 쓰면 이중 지급이다.
     * ⚠️ 정규화는 <b>시계를 읽지 않으므로</b> BLOCKER-2 를 되살리지 않는다 — 그 계약
     * ({@code relativeExpiryResendIsStillTheSameRequest})이 같이 서 있어야 이 둘이 함께 성립한다.
     */
    @Test
    void sameInstantWrittenDifferentlyIsTheSameRequest() {
        String admin = adminToken();
        String userId = user("ml_tsfmt");

        Map<String, Object> plain = targeted(userId, 30L);
        plain.put("expiresAt", "2099-01-01T00:00:00Z");
        assertThat(send(admin, plain, "idem-tsfmt-1").status()).isEqualTo(HttpStatus.CREATED);

        Map<String, Object> withMillis = targeted(userId, 30L);
        withMillis.put("expiresAt", "2099-01-01T00:00:00.000Z");
        HttpResult again = send(admin, withMillis, "idem-tsfmt-1");

        assertThat(again.status()).as(again.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(again).get("applied")).isEqualTo(false);
        assertThat(inboxCount(userId)).as("두 통이 되면 이중 지급이다").isEqualTo(1);

        // 진짜로 다른 시각이면 여전히 409 여야 한다(정규화가 구분을 지우지 않았는지).
        Map<String, Object> shifted = targeted(userId, 30L);
        shifted.put("expiresAt", "2099-01-01T00:00:01Z");
        assertThat(send(admin, shifted, "idem-tsfmt-1").status()).isEqualTo(HttpStatus.CONFLICT);
    }

    // ── 브로드캐스트 ──────────────────────────────────────────────────────

    /**
     * {@code audience=ALL} = <b>발송 시점에 존재하는 유저 전원</b>. 이후 가입자는 대상이 아니다 —
     * 패치 보상의 사유(그 패치를 겪었다)가 나중에 온 사람에게는 성립하지 않는다.
     */
    @Test
    void broadcastReachesEveryoneWhoExistedAtSendTimeAndNobodyAfter() {
        String admin = adminToken();
        String before1 = user("ml_all_a");
        String before2 = user("ml_all_b");

        Map<String, Object> body = base();
        body.put("audience", "ALL");
        HttpResult res = send(admin, body, "idem-all-1");
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.CREATED);

        long users = userCount();
        assertThat(((Number) asMap(res).get("targetCount")).longValue()).isEqualTo(users);
        assertThat(inboxCount(before1)).isEqualTo(1);
        assertThat(inboxCount(before2)).isEqualTo(1);

        String after = user("ml_late");
        assertThat(inboxCount(after)).as("발송 뒤 가입자는 대상이 아니다").isZero();
    }

    // ── 검증(거절은 전부 부수효과 0) ───────────────────────────────────────

    @Test
    void rejectsUnknownUserUnknownCardNegativeAndOverCapAttachments() {
        String admin = adminToken();
        String userId = user("ml_rej");

        Map<String, Object> unknownUser = base();
        unknownUser.put("audience", "USERS");
        unknownUser.put("userIds", List.of("no-such-user"));
        expectRejected(send(admin, unknownUser, "idem-reject-1"), "없는 유저");

        Map<String, Object> unknownCard = targeted(userId, 0L);
        unknownCard.put("attachments", Map.of("points", 0, "gems", 0,
                "players", List.of(Map.of("playerId", "P99999", "count", 1))));
        expectRejected(send(admin, unknownCard, "idem-reject-2"), "없는 카드");

        Map<String, Object> negative = targeted(userId, -100L);
        expectRejected(send(admin, negative, "idem-reject-3"), "음수 첨부");

        Map<String, Object> tooMuch = targeted(userId, 999_999_999L);
        expectRejected(send(admin, tooMuch, "idem-reject-4"), "상한 초과");

        Map<String, Object> noReason = targeted(userId, 100L);
        noReason.remove("reason");
        expectRejected(send(admin, noReason, "idem-reject-5"), "사유 없음");

        assertThat(campaignCount("idem-reject-")).as("거절은 아무것도 남기지 않는다").isZero();
        assertThat(inboxCount(userId)).isZero();
    }

    /** 첨부 0 = 텍스트 전용 안내. <b>유효하다</b>(거절하면 운영이 공지 아닌 개인 안내를 못 보낸다). */
    @Test
    void textOnlyMailIsValid() {
        String admin = adminToken();
        String userId = user("ml_text");

        assertThat(send(admin, targeted(userId, 0L), "idem-text-1").status())
                .isEqualTo(HttpStatus.CREATED);
        assertThat(inboxCount(userId)).isEqualTo(1);
    }

    /** 만료는 <b>유저 행에 스냅샷</b>된다 — 캠페인 만료를 나중에 당겨도 받아 든 사람의 마감은 안 줄어든다. */
    @Test
    void expiryIsSnapshottedOntoTheUserRow() {
        String admin = adminToken();
        String userId = user("ml_exp");

        Map<String, Object> body = targeted(userId, 10L);
        body.put("expiresInDays", 14);
        assertThat(send(admin, body, "idem-expiry-1").status()).isEqualTo(HttpStatus.CREATED);

        String snapshot = jdbcClient.sql("SELECT expires_at FROM user_mails WHERE user_id = ?")
                .param(userId).query(String.class).single();
        assertThat(snapshot).isNotNull().endsWith("Z");
    }

    /** 만료 미지정 = <b>무기한</b>(hero 확정 ③). */
    @Test
    void noExpiryMeansForever() {
        String admin = adminToken();
        String userId = user("ml_fvr");

        assertThat(send(admin, targeted(userId, 10L), "idem-forever-1").status())
                .isEqualTo(HttpStatus.CREATED);
        String snapshot = jdbcClient.sql("SELECT expires_at FROM user_mails WHERE user_id = ?")
                .param(userId).query(String.class).optional().orElse(null);
        assertThat(snapshot).isNull();
    }

    // ── 회수 ─────────────────────────────────────────────────────────────

    /**
     * 회수는 <b>미수령분만</b> 막는다. 이미 받은 사람의 지갑은 건드리지 않는다 — 원장을 되감는 것은
     * 별개의 조작이고, 우편함이 그 두 번째 경로가 되면 "왜 줄었나"의 답이 두 곳이 된다.
     */
    @Test
    void revokeBlocksUnclaimedOnlyAndLeavesClaimedAlone() {
        String admin = adminToken();
        String claimerToken = login("ml_rv_a");
        String claimerId = userIdOf("ml_rv_a");
        String lateToken = login("ml_rv_b");
        String lateId = userIdOf("ml_rv_b");

        Map<String, Object> body = base();
        body.put("audience", "USERS");
        body.put("userIds", List.of(claimerId, lateId));
        body.put("attachments", Map.of("points", 777, "gems", 0, "players", List.of()));
        HttpResult sent = send(admin, body, "idem-revoke-1");
        assertThat(sent.status()).as(sent.body()).isEqualTo(HttpStatus.CREATED);
        String campaignId = (String) asMap(sent).get("campaignId");

        String claimerMail = firstMailId(claimerToken);
        assertThat(post("/api/mails/" + claimerMail + "/claim", claimerToken).status())
                .isEqualTo(HttpStatus.OK);
        long claimedBalance = points(claimerId);

        HttpResult revoked = postJsonAuth("/api/admin/mails/" + campaignId + "/revoke", admin,
                Map.of("reason", "오발송 수습"), null);
        assertThat(revoked.status()).as(revoked.body()).isEqualTo(HttpStatus.OK);
        assertThat(((Number) asMap(revoked).get("unclaimed")).longValue()).isEqualTo(1);

        // 이미 받은 쪽 — 잔액 그대로
        assertThat(points(claimerId)).isEqualTo(claimedBalance);

        // 아직 안 받은 쪽 — 410, 지급 0
        long lateBefore = points(lateId);
        String lateMail = firstMailId(lateToken);
        assertThat(post("/api/mails/" + lateMail + "/claim", lateToken).status())
                .isEqualTo(HttpStatus.GONE);
        assertThat(points(lateId)).isEqualTo(lateBefore);
    }

    // ── 감사 ─────────────────────────────────────────────────────────────

    /** 성공도 실패도 남는다 — <b>시도 자체가 이력</b>이다(economy·공지 운영과 같은 규율). */
    @Test
    void bothSuccessAndFailureAreAudited() {
        String admin = adminToken();
        String userId = user("ml_aud");

        String reason = "감사 계약 " + java.util.UUID.randomUUID();
        Map<String, Object> good = targeted(userId, 42L);
        good.put("reason", reason);
        send(admin, good, "idem-audit-ok");

        Map<String, Object> bad = base();
        bad.put("audience", "USERS");
        bad.put("userIds", List.of("no-such-user"));
        bad.put("reason", reason);
        send(admin, bad, "idem-audit-fail");

        // 사유로 스코프 — 같은 DB 를 쓰는 다른 테스트의 발송과 섞이지 않게.
        assertThat(auditCount("mail_send", "ok", reason)).isEqualTo(1);
        assertThat(auditCount("mail_send", "failed", reason)).isEqualTo(1);

        HttpResult history = get("/api/admin/mails/history", admin);
        assertThat(history.status()).isEqualTo(HttpStatus.OK);
        assertThat(history.body()).contains("mail_send");
    }

    /** 발송 이력은 수령 통계를 같이 싣는다 — 운영의 첫 질문이 "몇 명이 받았나"다. */
    @Test
    @SuppressWarnings("unchecked")
    void campaignListCarriesClaimStats() {
        String admin = adminToken();
        String token = login("ml_stat");
        String userId = userIdOf("ml_stat");

        HttpResult sent = send(admin, targeted(userId, 55L), "idem-stats-1");
        String campaignId = (String) asMap(sent).get("campaignId");
        post("/api/mails/" + firstMailId(token) + "/claim", token);

        Map<String, Object> listed = asMap(get("/api/admin/mails", admin));
        List<Map<String, Object>> campaigns = (List<Map<String, Object>>) listed.get("campaigns");
        Map<String, Object> mine = campaigns.stream()
                .filter(c -> campaignId.equals(c.get("id")))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("발송한 캠페인이 목록에 없다"));
        assertThat(((Number) mine.get("targetCount")).intValue()).isEqualTo(1);
        assertThat(((Number) mine.get("claimedCount")).intValue()).isEqualTo(1);
    }

    // ── 게이트 ───────────────────────────────────────────────────────────

    /** 일반 유저는 발송할 수 없다. 이 경로는 <b>재화를 발행</b>하므로 게이트가 뚫리면 곧 경제 붕괴다. */
    @Test
    void ordinaryUsersCannotSend() {
        String token = login("ml_user");
        String userId = userIdOf("ml_user");

        HttpResult res = send(token, targeted(userId, 1_000_000L), "idem-gate-1");
        assertThat(res.status()).isIn(HttpStatus.FORBIDDEN, HttpStatus.UNAUTHORIZED);
        assertThat(campaignCount("idem-gate-")).isZero();
        assertThat(inboxCount(userId)).isZero();
    }

    private void expectRejected(HttpResult res, String what) {
        assertThat(res.status()).as(what + " → " + res.body()).isEqualTo(HttpStatus.BAD_REQUEST);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    private Map<String, Object> base() {
        Map<String, Object> body = new HashMap<>();
        body.put("title", "테스트 발송");
        body.put("body", "본문");
        body.put("attachments", Map.of("points", 0, "gems", 0, "players", List.of()));
        body.put("reason", "계약 테스트");
        return body;
    }

    private Map<String, Object> targeted(String userId, long points) {
        Map<String, Object> body = base();
        body.put("audience", "USERS");
        body.put("userIds", List.of(userId));
        body.put("attachments", Map.of("points", points, "gems", 0, "players", List.of()));
        return body;
    }

    private HttpResult send(String token, Map<String, Object> body, String idemKey) {
        return postJsonAuth("/api/admin/mails", token, body, idemKey);
    }

    @SuppressWarnings("unchecked")
    private String firstMailId(String token) {
        Map<String, Object> inbox = asMap(get("/api/mails", token));
        return (String) ((List<Map<String, Object>>) inbox.get("mails")).get(0).get("id");
    }

    /**
     * ⚠️ 테스트 DB 는 <b>클래스 단위로 공유</b>된다 — 전체 COUNT 로 단언하면 앞 테스트의 발송이
     * 섞여 실행 순서에 따라 통과/실패가 갈린다(실제로 그렇게 깨졌다). 이 테스트가 쓴 멱등키
     * 접두사로만 센다.
     */
    private long campaignCount(String idemPrefix) {
        return jdbcClient.sql("SELECT COUNT(*) FROM mail_campaigns WHERE idem_key LIKE ?")
                .param(idemPrefix + "%")
                .query(Long.class).single();
    }

    private long inboxCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM user_mails WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long userCount() {
        return jdbcClient.sql("SELECT COUNT(*) FROM users").query(Long.class).single();
    }

    private long auditRows(String action, String result) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_ops_audit WHERE action = ? AND result = ?")
                .params(action, result)
                .query(Long.class).single();
    }

    private long auditCount(String action, String result, String reason) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM admin_ops_audit WHERE action = ? AND result = ? AND reason = ?")
                .params(action, result, reason)
                .query(Long.class).single();
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private String user(String nickname) {
        login(nickname);
        return userIdOf(nickname);
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private String adminToken() {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }

    private HttpResult get(String path, String token) {
        try {
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(baseUrl(path)))
                            .header("Authorization", "Bearer " + token)
                            .GET().build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private HttpResult post(String path, String token) {
        return postJsonAuth(path, token, Map.of(), null);
    }

    private HttpResult postJsonAuth(String path, String token, Map<String, Object> body, String idemKey) {
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl(path)))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + token);
            if (idemKey != null) {
                builder.header("Idempotency-Key", idemKey);
            }
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    builder.POST(java.net.http.HttpRequest.BodyPublishers.ofString(
                            MAPPER.writeValueAsString(body))).build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
