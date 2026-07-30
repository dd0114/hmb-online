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
 * 우편함 <b>유저 쪽</b> 계약(#323): 목록 · 뱃지 · 열람 · 수령 · 만료 · 격리.
 *
 * <p>수령 단정은 <b>4중</b>이다(지갑 · 원장 · 보유풀 · 상태). 하나만 보면 "원장은 썼는데 지갑이 안
 * 움직였다" 같은 부분 적용을 놓친다 — {@code AdminPointsTest} 가 세운 규율을 그대로 따른다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class MailboxApiTest extends ApiTestBase {

    private static final String ADMIN_NICK = "mail_admin";
    private static final String ADMIN_PW = "mail-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    // ── 수령 ─────────────────────────────────────────────────────────────

    @Test
    @SuppressWarnings("unchecked")
    void claimGrantsThroughTheExistingWalletLedgerAndRosterPaths() {
        String admin = adminToken();
        String token = login("mail_claimer");
        String userId = userIdOf("mail_claimer");
        String card = someCardId();

        long pointsBefore = points(userId);
        long gemsBefore = gems(userId);
        int cardBefore = owned(userId, card);

        send(admin, targeted(userId, 1500L, 7L, card, 2), "idem-claim-1");

        Map<String, Object> inbox = asMap(get("/api/mails", token));
        List<Map<String, Object>> mails = (List<Map<String, Object>>) inbox.get("mails");
        assertThat(mails).hasSize(1);
        assertThat(mails.get(0).get("state")).isEqualTo("UNREAD");
        assertThat(((Number) inbox.get("unread")).intValue()).isEqualTo(1);

        String mailId = (String) mails.get(0).get("id");
        HttpResult res = post("/api/mails/" + mailId + "/claim", token);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);

        Map<String, Object> claim = asMap(res);
        assertThat(claim.get("applied")).isEqualTo(true);
        Map<String, Object> wallet = (Map<String, Object>) claim.get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(pointsBefore + 1500L);

        // 1) 지갑
        assertThat(points(userId)).isEqualTo(pointsBefore + 1500L);
        assertThat(gems(userId)).isEqualTo(gemsBefore + 7L);
        // 2) 원장 — reason='mail_claim', ref_id = 우편물 id (기존 멱등 인덱스에 얹힌다)
        assertThat(ledgerDelta("point_ledger", userId, mailId)).isEqualTo(1500L);
        assertThat(ledgerDelta("gem_ledger", userId, mailId)).isEqualTo(7L);
        // 3) 보유풀
        assertThat(owned(userId, card)).isEqualTo(cardBefore + 2);
        // 4) 상태 — 수령한 우편물은 목록에 남고(무엇을 받았는지 되짚을 수 있어야 한다) 뱃지에선 빠진다
        Map<String, Object> after = asMap(get("/api/mails", token));
        assertThat(((List<Map<String, Object>>) after.get("mails")).get(0).get("state")).isEqualTo("CLAIMED");
        assertThat(((Number) after.get("unread")).intValue()).isZero();
    }

    /**
     * 더블탭. <b>실패가 아니라 사실대로</b> — 200 {@code applied:false} + 현재 잔액이고,
     * <b>두 번째 지급은 없다</b>(원장 행도 1개 그대로).
     */
    @Test
    void claimingTwiceGrantsOnlyOnce() {
        String admin = adminToken();
        String token = login("mail_double");
        String userId = userIdOf("mail_double");

        send(admin, targeted(userId, 900L, 0L, null, 0), "idem-double-1");
        String mailId = firstMailId(token);

        assertThat(post("/api/mails/" + mailId + "/claim", token).status()).isEqualTo(HttpStatus.OK);
        long afterFirst = points(userId);

        HttpResult second = post("/api/mails/" + mailId + "/claim", token);
        assertThat(second.status()).as(second.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(second).get("applied")).isEqualTo(false);

        assertThat(points(userId)).isEqualTo(afterFirst);
        assertThat(ledgerRows("point_ledger", userId, mailId)).isEqualTo(1);
    }

    // ── 뱃지 ─────────────────────────────────────────────────────────────

    /**
     * <b>읽어도 안 받았으면 계속 센다.</b> 이게 뱃지가 지켜야 하는 유일한 케이스다 — 읽음만으로
     * 끄면 열어 보고 안 받은 보상이 조용히 사라진다.
     */
    @Test
    void readingDoesNotClearTheBadgeWhileTheRewardIsStillUnclaimed() {
        String admin = adminToken();
        String token = login("mail_readbadge");
        String userId = userIdOf("mail_readbadge");

        send(admin, targeted(userId, 100L, 0L, null, 0), "idem-readbadge-1");
        String mailId = firstMailId(token);

        assertThat(post("/api/mails/" + mailId + "/read", token).status()).isEqualTo(HttpStatus.OK);
        assertThat(unread(token)).as("읽었지만 아직 안 받았다").isEqualTo(1);

        post("/api/mails/" + mailId + "/claim", token);
        assertThat(unread(token)).as("받고 나서야 꺼진다").isZero();
    }

    /** 첨부 없는 안내 메일은 <b>읽으면</b> 꺼진다(받을 게 없으므로). */
    @Test
    void textOnlyMailClearsTheBadgeOnRead() {
        String admin = adminToken();
        String token = login("mail_textonly");
        String userId = userIdOf("mail_textonly");

        send(admin, targeted(userId, 0L, 0L, null, 0), "idem-textonly-1");
        String mailId = firstMailId(token);
        assertThat(unread(token)).isEqualTo(1);

        post("/api/mails/" + mailId + "/read", token);
        assertThat(unread(token)).isZero();
    }

    /**
     * <b>뱃지와 목록은 같은 판정을 쓴다</b>(단일 정의 = {@code MailService.ACTIONABLE}).
     *
     * <p>변이체 킬: 뱃지 SQL 과 상태 계산이 갈라지면 "뱃지엔 1인데 열어 보면 할 게 없다"가 되고,
     * 그 순간 유저는 뱃지를 믿지 않게 된다. 여러 상태를 한 수신함에 섞어 두고 <b>관계식</b>으로 건다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void badgeMatchesTheList() {
        String admin = adminToken();
        String token = login("mail_badgesync");
        String userId = userIdOf("mail_badgesync");

        send(admin, targeted(userId, 100L, 0L, null, 0), "idem-sync-unread");  // 안 읽음
        send(admin, targeted(userId, 200L, 0L, null, 0), "idem-sync-read");    // 읽고 안 받음
        send(admin, targeted(userId, 300L, 0L, null, 0), "idem-sync-claimed"); // 수령 완료
        send(admin, targeted(userId, 400L, 0L, null, 0), "idem-sync-expired"); // 만료

        List<Map<String, Object>> mails = mails(token);
        assertThat(mails).hasSize(4);
        // 최신순이라 발송 역순. 제목이 아니라 원장 금액으로 특정한다(제목은 언제든 바뀐다).
        String readOnly = idOfMailWithPoints(mails, 200);
        String claimed = idOfMailWithPoints(mails, 300);
        String expired = idOfMailWithPoints(mails, 400);

        post("/api/mails/" + readOnly + "/read", token);
        post("/api/mails/" + claimed + "/claim", token);
        expire(expired);

        Map<String, Object> inbox = asMap(get("/api/mails", token));
        List<Map<String, Object>> after = (List<Map<String, Object>>) inbox.get("mails");
        long actionable = after.stream()
                .filter(m -> {
                    String state = (String) m.get("state");
                    Map<String, Object> att = (Map<String, Object>) m.get("attachments");
                    boolean hasAtt = ((Number) att.get("points")).longValue() != 0
                            || ((Number) att.get("gems")).longValue() != 0
                            || !((List<?>) att.get("players")).isEmpty();
                    return "UNREAD".equals(state) || ("READ".equals(state) && hasAtt);
                })
                .count();
        assertThat(((Number) inbox.get("unread")).longValue())
                .as("뱃지 수 == 목록에서 아직 할 일인 것의 수")
                .isEqualTo(actionable);
        assertThat(actionable).isEqualTo(2);   // 안 읽음 1 + 읽고 안 받음 1
    }

    // ── 만료 ─────────────────────────────────────────────────────────────

    /**
     * hero 확정 ④ — <b>만료된 미수령도 목록에 남는다</b>(놓쳤다는 사실이 보여야 한다).
     * 대신 상태는 EXPIRED, 수령은 410, 뱃지에는 세지 않는다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void expiredMailStaysInTheListButCannotBeClaimedAndIsNotCounted() {
        String admin = adminToken();
        String token = login("mail_expired");
        String userId = userIdOf("mail_expired");

        send(admin, targeted(userId, 5000L, 0L, null, 0), "idem-expired-1");
        String mailId = firstMailId(token);
        long before = points(userId);
        expire(mailId);

        Map<String, Object> inbox = asMap(get("/api/mails", token));
        List<Map<String, Object>> mails = (List<Map<String, Object>>) inbox.get("mails");
        assertThat(mails).as("목록에서 사라지지 않는다").hasSize(1);
        assertThat(mails.get(0).get("state")).isEqualTo("EXPIRED");
        assertThat(((Number) inbox.get("unread")).intValue()).as("뱃지엔 안 센다").isZero();

        HttpResult res = post("/api/mails/" + mailId + "/claim", token);
        assertThat(res.status()).isEqualTo(HttpStatus.GONE);
        assertThat(points(userId)).as("만료 거절에 부수효과 0").isEqualTo(before);
    }

    /**
     * <b>이미 받은 우편이 나중에 만료·회수돼도 재요청은 200</b>(독립검증 m3).
     *
     * <p>설계 §3.3 = "0행이면 이미 수령 → 200, 유저에게 실패로 보일 이유가 없다". 만료·회수 검사를
     * CAS <b>앞</b>에 두면 이 교집합이 410 이 된다 — 이미 받은 사람에게 "수령 기간이 지났습니다"가
     * 뜬다. 그래서 조건을 전부 CAS 안에 넣고, 못 가져간 이유를 행을 다시 읽어 구분한다.
     */
    @Test
    void claimedMailStays200EvenAfterItExpires() {
        String admin = adminToken();
        String token = login("mail_late_exp");
        String userId = userIdOf("mail_late_exp");

        send(admin, targeted(userId, 700L, 0L, null, 0), "idem-lateexp-1");
        String mailId = firstMailId(token);

        assertThat(post("/api/mails/" + mailId + "/claim", token).status()).isEqualTo(HttpStatus.OK);
        long afterClaim = points(userId);

        expire(mailId);   // 받은 **뒤에** 기한이 지난다

        HttpResult again = post("/api/mails/" + mailId + "/claim", token);
        assertThat(again.status()).as(again.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(again).get("applied")).isEqualTo(false);
        assertThat(points(userId)).isEqualTo(afterClaim);
    }

    // ── 격리 ─────────────────────────────────────────────────────────────

    /** 남의 우편물은 <b>404</b>. 403 은 "그 id 는 실재한다"를 흘린다(공지 단건과 같은 규율). */
    @Test
    void anotherUsersMailIsIndistinguishableFromAbsent() {
        String admin = adminToken();
        String ownerToken = login("mail_owner");
        String ownerId = userIdOf("mail_owner");
        String strangerToken = login("mail_stranger");
        String strangerId = userIdOf("mail_stranger");

        send(admin, targeted(ownerId, 1000L, 0L, null, 0), "idem-isolation-1");
        String mailId = firstMailId(ownerToken);
        long before = points(strangerId);

        HttpResult claim = post("/api/mails/" + mailId + "/claim", strangerToken);
        assertThat(claim.status()).isEqualTo(HttpStatus.NOT_FOUND);
        HttpResult absent = post("/api/mails/does-not-exist/claim", strangerToken);
        assertThat(absent.status()).as("없는 id 와 같은 코드").isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(points(strangerId)).isEqualTo(before);
        assertThat(mails(strangerToken)).as("남의 우편물은 목록에도 없다").isEmpty();
    }

    /**
     * 홈 헤더가 쓰는 <b>두 숫자</b>가 {@code GET /api/me} 에 실린다 — 뱃지(`unread`)와
     * 진입점 유무(`total`). 목록을 받지 않고도 헤더를 그릴 수 있어야 왕복이 늘지 않는다(설계 §3.4).
     *
     * <p>⚠️ `total` 은 <b>수령·만료와 무관하게</b> 센다 — 다 받은 뒤에도 우편함은 열려야 한다
     * (무엇을 받았는지 되짚는 자리). `unread` 만 보고 진입점을 숨기면 그 이력이 사라진다.
     */
    @Test
    @SuppressWarnings("unchecked")
    void meCarriesBadgeAndEntryPointCount() {
        String admin = adminToken();
        String token = login("mail_me");
        String userId = userIdOf("mail_me");

        send(admin, targeted(userId, 10L, 0L, null, 0), "idem-me-1");

        Map<String, Object> me = asMap(get("/api/me", token));
        Map<String, Object> mail = (Map<String, Object>) me.get("mail");
        assertThat(mail).as("/api/me 에 mail 필드가 있어야 한다").isNotNull();
        assertThat(((Number) mail.get("unread")).intValue()).isEqualTo(1);
        assertThat(((Number) mail.get("total")).intValue()).isEqualTo(1);

        // 받고 나면 뱃지는 0 이지만 **진입점은 남는다**.
        post("/api/mails/" + firstMailId(token) + "/claim", token);
        Map<String, Object> after = (Map<String, Object>) asMap(get("/api/me", token)).get("mail");
        assertThat(((Number) after.get("unread")).intValue()).isZero();
        assertThat(((Number) after.get("total")).intValue()).isEqualTo(1);
    }

    // ── helpers ──────────────────────────────────────────────────────────

    /** 만료를 시간 대신 데이터로 만든다 — 테스트가 실제로 며칠을 기다릴 수는 없다. */
    private void expire(String mailId) {
        jdbcClient.sql("UPDATE user_mails SET expires_at = '2000-01-01T00:00:00Z' WHERE id = ?")
                .param(mailId)
                .update();
    }

    private Map<String, Object> targeted(String userId, long points, long gems, String cardId, int cardCount) {
        Map<String, Object> attachments = new HashMap<>();
        attachments.put("points", points);
        attachments.put("gems", gems);
        attachments.put("players", cardId == null ? List.of()
                : List.of(Map.of("playerId", cardId, "count", cardCount)));

        Map<String, Object> body = new HashMap<>();
        body.put("audience", "USERS");
        body.put("userIds", List.of(userId));
        body.put("title", "테스트 우편");
        body.put("body", "본문");
        body.put("attachments", attachments);
        body.put("reason", "계약 테스트");
        return body;
    }

    private void send(String adminToken, Map<String, Object> body, String idemKey) {
        HttpResult res = postJsonAuth("/api/admin/mails", adminToken, body, idemKey);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.CREATED);
    }

    @SuppressWarnings("unchecked")
    private List<Map<String, Object>> mails(String token) {
        HttpResult res = get("/api/mails", token);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        return (List<Map<String, Object>>) asMap(res).get("mails");
    }

    private String firstMailId(String token) {
        return (String) mails(token).get(0).get("id");
    }

    private int unread(String token) {
        return ((Number) asMap(get("/api/mails", token)).get("unread")).intValue();
    }

    @SuppressWarnings("unchecked")
    private String idOfMailWithPoints(List<Map<String, Object>> mails, long points) {
        return mails.stream()
                .filter(m -> ((Number) ((Map<String, Object>) m.get("attachments")).get("points"))
                        .longValue() == points)
                .map(m -> (String) m.get("id"))
                .findFirst()
                .orElseThrow(() -> new IllegalStateException("첨부 " + points + " 인 우편물이 없다"));
    }

    private String someCardId() {
        return jdbcClient.sql("SELECT id FROM players ORDER BY id LIMIT 1")
                .query(String.class)
                .single();
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long gems(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private int owned(String userId, String playerId) {
        return jdbcClient.sql("SELECT COALESCE(SUM(count), 0) FROM user_players WHERE user_id = ? AND player_id = ?")
                .params(userId, playerId)
                .query(Integer.class).single();
    }

    private long ledgerDelta(String table, String userId, String refId) {
        return jdbcClient.sql("SELECT COALESCE(SUM(delta), 0) FROM " + table
                        + " WHERE user_id = ? AND reason = 'mail_claim' AND ref_id = ?")
                .params(userId, refId)
                .query(Long.class).single();
    }

    private int ledgerRows(String table, String userId, String refId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM " + table
                        + " WHERE user_id = ? AND reason = 'mail_claim' AND ref_id = ?")
                .params(userId, refId)
                .query(Integer.class).single();
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

    HttpResult postJsonAuth(String path, String token, Map<String, Object> body, String idemKey) {
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
