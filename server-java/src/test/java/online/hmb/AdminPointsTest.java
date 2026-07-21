package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doReturn;

import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>AC-C1</b>: admin 포인트 지급 → 유저 지갑·원장 반영 + 감사 로그.
 *
 * <p>모든 단정은 <b>3중</b>이다(지갑 잔액 · point_ledger 행 · admin_audit 행). 하나만 보면
 * "원장은 썼는데 지갑이 안 움직였다" 같은 부분 적용을 놓친다. 거부 케이스에서는 같은 세 값이
 * <b>전부 불변</b>임을 단정한다 — 상태코드만 보는 테스트는 W1 R2 에서 이미 실패했다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AdminPointsTest extends ApiTestBase {

    private static final String ADMIN_NICK = "pts_admin";
    private static final String ADMIN_PW = "pts-admin-pw-1234";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.admin.nickname", () -> ADMIN_NICK);
        registry.add("hmb.admin.password", () -> ADMIN_PW);
    }

    @Resource
    private JdbcClient jdbcClient;

    /** CHECK 백스톱 경로를 결정론적으로 재현하기 위한 스파이(W1 LocalAuthRaceTest 와 같은 기법). */
    @SpyBean
    private online.hmb.meta.WalletService walletService;

    // ───────────────────────── 지급 / 차감 ─────────────────────────

    @Test
    void grantReflectsInWalletLedgerAndAudit() {
        String admin = adminToken();
        String target = user("pts_grant");

        long walletBefore = points(target);
        long ledgerBefore = adminLedgerCount(target);
        long auditBefore = auditCount(target);

        HttpResult res = grant(admin, target, 2500L, "테스터 충전 요청 대응", "idem-grant-1");
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);

        Map<String, Object> body = asMap(res);
        assertThat(body.get("applied")).isEqualTo(true);
        assertThat(((Number) body.get("balance")).longValue()).isEqualTo(walletBefore + 2500L);

        // 1) 지갑
        assertThat(points(target)).isEqualTo(walletBefore + 2500L);
        // 2) 원장 — reason='admin_grant', ref_id=멱등키, delta 그대로
        assertThat(adminLedgerCount(target)).isEqualTo(ledgerBefore + 1);
        assertThat(jdbcClient.sql("""
                        SELECT delta FROM point_ledger
                        WHERE user_id = ? AND reason = 'admin_grant' AND ref_id = 'idem-grant-1'
                        """).param(target).query(Long.class).single()).isEqualTo(2500L);
        // 3) 감사 — actor=admin, target=대상, reason 보존
        assertThat(auditCount(target)).isEqualTo(auditBefore + 1);
        Map<String, Object> audit = jdbcClient.sql("""
                        SELECT actor_user_id, target_user_id, action, delta, reason, idem_key
                        FROM admin_audit WHERE idem_key = 'idem-grant-1'
                        """).query(new org.springframework.jdbc.core.ColumnMapRowMapper()).single();
        assertThat(audit.get("actor_user_id")).isEqualTo(userIdOf(ADMIN_NICK));
        assertThat(audit.get("target_user_id")).isEqualTo(target);
        assertThat(audit.get("action")).isEqualTo("points_grant");
        assertThat(((Number) audit.get("delta")).longValue()).isEqualTo(2500L);
        assertThat(audit.get("reason")).isEqualTo("테스터 충전 요청 대응");
    }

    @Test
    void deductionReflectsInWalletLedgerAndAudit() {
        String admin = adminToken();
        String target = user("pts_deduct");
        assertThat(grant(admin, target, 1000L, "선지급", "idem-ded-seed").status()).isEqualTo(HttpStatus.OK);

        long walletBefore = points(target);
        HttpResult res = grant(admin, target, -400L, "오지급 회수", "idem-ded-1");

        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        assertThat(points(target)).isEqualTo(walletBefore - 400L);
        assertThat(jdbcClient.sql("SELECT delta FROM point_ledger WHERE ref_id = 'idem-ded-1'")
                .query(Long.class).single()).isEqualTo(-400L);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM admin_audit WHERE idem_key = 'idem-ded-1'")
                .query(Long.class).single()).isEqualTo(1L);
    }

    // ───────────────────────── 잔액 하한 ─────────────────────────

    @Test
    void deductionBelowZeroIsRejectedWithNoSideEffects() {
        String admin = adminToken();
        String target = user("pts_floor");

        long walletBefore = points(target);
        long ledgerBefore = adminLedgerCount(target);
        long auditBefore = auditCount(target);

        HttpResult res = grant(admin, target, -(walletBefore + 1), "과다 차감", "idem-floor-1");

        assertThat(res.status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(asMap(res).get("code")).isEqualTo("INSUFFICIENT_POINTS");
        // 이 케이스는 **사전 검사**가 잡아야 한다(DB CHECK 백스톱이 아니라). 두 층은 같은 코드·상태를
        // 내므로 메시지로만 구분된다 — 이걸 단정하지 않으면 사전 검사를 통째로 지워도 테스트가 통과한다
        // (실측: 뮤테이션 M4a 가 살아남았다). 사전 검사는 잔액을 메시지에 담는다.
        assertThat((String) asMap(res).get("message"))
                .as("사전 잔액 검사가 아니라 DB CHECK 백스톱이 잡았다 — 사전 검사가 죽어 있다")
                .contains("보유 " + walletBefore);
        assertThat(points(target)).as("400 인데 지갑이 변했다").isEqualTo(walletBefore);
        assertThat(adminLedgerCount(target)).as("400 인데 원장이 늘었다").isEqualTo(ledgerBefore);
        assertThat(auditCount(target)).as("400 인데 감사가 늘었다").isEqualTo(auditBefore);
        // 음수 잔액은 어떤 유저에게도 존재할 수 없다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM wallets WHERE points < 0").query(Long.class).single())
                .isZero();
    }

    /**
     * <b>동시 차감 백스톱</b>: 사전 잔액 검사만 있으면 read-modify-write 경합에서 두 요청이 모두
     * 통과할 수 있다. 그 인터리빙을 확률에 맡기지 않고 <b>고정</b>한다 — 사전 검사가 보는 잔액만
     * 실제보다 크게 만들어(=다른 트랜잭션이 그 사이 차감한 상황) DB CHECK 가 잡는지 본다.
     * 이때 트랜잭션이 통째로 롤백돼 원장·감사에도 흔적이 남지 않아야 한다.
     */
    @Test
    void concurrentDeductionCannotDriveBalanceNegative_checkBackstopRollsBackEverything() {
        String admin = adminToken();
        String target = user("pts_race");

        long walletBefore = points(target);
        long ledgerBefore = adminLedgerCount(target);
        long auditBefore = auditCount(target);

        // 사전 검사만 부풀린다(다음 호출부터는 실제값) → 검사 통과 → UPDATE 가 CHECK 위반.
        doReturn(walletBefore + 1_000_000L).doCallRealMethod().when(walletService).points(anyString());

        HttpResult res = grant(admin, target, -(walletBefore + 500), "경합 차감", "idem-race-1");

        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(asMap(res).get("code")).isEqualTo("INSUFFICIENT_POINTS");
        // 이 케이스는 반대로 **백스톱**이 잡아야 한다(사전 검사는 부풀린 잔액을 보고 통과했다).
        assertThat((String) asMap(res).get("message")).contains("차감 후 잔액");
        assertThat(jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?").param(target)
                .query(Long.class).single()).as("CHECK 백스톱이 뚫려 잔액이 변했다").isEqualTo(walletBefore);
        assertThat(adminLedgerCount(target)).as("롤백됐어야 할 원장 행이 남았다").isEqualTo(ledgerBefore);
        assertThat(auditCount(target)).as("롤백됐어야 할 감사 행이 남았다").isEqualTo(auditBefore);
    }

    // ───────────────────────── 멱등 ─────────────────────────

    @Test
    void sameIdempotencyKeyIsAppliedExactlyOnce() {
        String admin = adminToken();
        String target = user("pts_idem");

        long walletBefore = points(target);
        long ledgerBefore = adminLedgerCount(target);
        long auditBefore = auditCount(target);

        HttpResult first = grant(admin, target, 700L, "충전 대응", "idem-dup-key");
        HttpResult second = grant(admin, target, 700L, "충전 대응", "idem-dup-key");
        HttpResult third = grant(admin, target, 700L, "충전 대응", "idem-dup-key");

        assertThat(first.status()).isEqualTo(HttpStatus.OK);
        assertThat(second.status()).isEqualTo(HttpStatus.OK);
        assertThat(third.status()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(first).get("applied")).isEqualTo(true);
        assertThat(asMap(second).get("applied")).as("재전송이 또 적용됐다").isEqualTo(false);
        assertThat(asMap(third).get("applied")).isEqualTo(false);

        // 3번 보냈지만 지갑은 한 번, 원장 1행, 감사 1행.
        assertThat(points(target)).isEqualTo(walletBefore + 700L);
        assertThat(adminLedgerCount(target)).isEqualTo(ledgerBefore + 1);
        assertThat(auditCount(target)).isEqualTo(auditBefore + 1);
    }

    /**
     * 멱등키를 <b>주지 않으면</b> 서버가 채번하므로 두 요청은 서로 다른 지급이 된다.
     * 이건 버그가 아니라 <b>설계된 계약</b>이다(서버는 재전송과 두 번째 지급을 구분할 수 없다).
     * 계약을 테스트로 박제해 두어, 나중에 조용히 바뀌면 드러나게 한다.
     */
    @Test
    void withoutIdempotencyKeyEachRequestIsADistinctGrant() {
        String admin = adminToken();
        String target = user("pts_nokey");
        long walletBefore = points(target);

        HttpResult a = grant(admin, target, 100L, "키 없음", null);
        HttpResult b = grant(admin, target, 100L, "키 없음", null);

        assertThat(a.status()).isEqualTo(HttpStatus.OK);
        assertThat(b.status()).isEqualTo(HttpStatus.OK);
        assertThat(points(target)).isEqualTo(walletBefore + 200L);
        // 서버가 채번한 키가 응답으로 관측 가능해야 한다(그래야 클라가 재전송 보호 부재를 안다).
        assertThat((String) asMap(a).get("idempotencyKey")).isNotBlank();
        assertThat(asMap(a).get("idempotencyKey")).isNotEqualTo(asMap(b).get("idempotencyKey"));
    }

    /**
     * <b>멱등 스코프는 유저별</b>(V6) — 원장 멱등 uq_ledger_reason_ref(user_id, reason, ref_id)와
     * 감사 인덱스의 단위가 일치해야 한다. V5 의 전역 인덱스에서는 서로 다른 유저에 같은 키를 쓰면
     * 감사가 UNIQUE 로 터져 500 이 났다(검증자 실측). 멱등키는 클라이언트가 정하므로 서로 다른
     * 유저에 같은 키가 오는 건 <b>정상 시나리오</b>다.
     */
    @Test
    void sameIdempotencyKeyForDifferentUsersIsTwoIndependentGrants() {
        String admin = adminToken();
        String userA = user("pts_scope_a");
        String userB = user("pts_scope_b");
        long beforeA = points(userA);
        long beforeB = points(userB);

        HttpResult resA = grant(admin, userA, 300L, "동일 키 A", "shared-key-1");
        HttpResult resB = grant(admin, userB, 300L, "동일 키 B", "shared-key-1");

        assertThat(resA.status()).as(resA.body()).isEqualTo(HttpStatus.OK);
        assertThat(resB.status()).as("다른 유저에 같은 키인데 실패했다: " + resB.body()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(resA).get("applied")).isEqualTo(true);
        assertThat(asMap(resB).get("applied")).as("B 는 별개의 지급이어야 한다").isEqualTo(true);

        // 둘 다 실제로 반영됐다(3중).
        assertThat(points(userA)).isEqualTo(beforeA + 300L);
        assertThat(points(userB)).isEqualTo(beforeB + 300L);
        assertThat(adminLedgerCount(userA)).isEqualTo(1L);
        assertThat(adminLedgerCount(userB)).isEqualTo(1L);
        assertThat(auditCount(userA)).isEqualTo(1L);
        assertThat(auditCount(userB)).isEqualTo(1L);

        // 그리고 유저별 멱등은 여전히 유효하다 — A 에 같은 키 재전송은 정확히 0건 추가.
        assertThat(asMap(grant(admin, userA, 300L, "동일 키 A", "shared-key-1")).get("applied")).isEqualTo(false);
        assertThat(points(userA)).isEqualTo(beforeA + 300L);
        assertThat(adminLedgerCount(userA)).isEqualTo(1L);
        assertThat(auditCount(userA)).isEqualTo(1L);
    }

    /**
     * <b>같은 멱등키인데 금액이 다르면 409</b>(조용히 삼키지 않는다).
     *
     * <p>왜 중요한가: 삼키면 admin 이 금액을 잘못 넣고 정정 재전송했을 때 <b>200 을 받는데 돈은
     * 안 움직인다</b> — 성공했다고 믿는 운영 함정이다(검증자 실측). 데이터는 안전하지만 그게 요점이 아니다.
     * 정상 재전송(같은 금액) 보호는 그대로 유지돼야 하므로 두 경우를 같은 테스트에서 대조한다.
     */
    @Test
    void sameKeyWithDifferentAmountIsRejectedWhileSameAmountStaysIdempotent() {
        String admin = adminToken();
        String target = user("pts_keyconflict");
        long walletBefore = points(target);

        assertThat(grant(admin, target, 500L, "최초 지급", "conflict-key").status()).isEqualTo(HttpStatus.OK);
        long walletAfterFirst = points(target);
        long ledgerAfterFirst = adminLedgerCount(target);
        long auditAfterFirst = auditCount(target);
        assertThat(walletAfterFirst).isEqualTo(walletBefore + 500L);

        // ① 같은 키 + 같은 금액 = 정상 재전송 → 200 applied:false, 부수효과 0
        HttpResult replay = grant(admin, target, 500L, "최초 지급", "conflict-key");
        assertThat(replay.status()).isEqualTo(HttpStatus.OK);
        assertThat(asMap(replay).get("applied")).isEqualTo(false);
        assertThat(points(target)).isEqualTo(walletAfterFirst);
        assertThat(adminLedgerCount(target)).isEqualTo(ledgerAfterFirst);
        assertThat(auditCount(target)).isEqualTo(auditAfterFirst);

        // ② 같은 키 + 다른 금액 = 다른 요청 → 409, 부수효과 0
        for (long conflicting : new long[]{99999L, -1L, 501L}) {
            HttpResult res = grant(admin, target, conflicting, "정정 시도", "conflict-key");
            assertThat(res.status())
                    .as("같은 키에 다른 금액(" + conflicting + ")인데 409 가 아니다 — 조용히 삼켰다: " + res.body())
                    .isEqualTo(HttpStatus.CONFLICT);
            assertThat(asMap(res).get("code")).isEqualTo("CONFLICT");
            // 기존 금액을 알려줘 admin 이 무슨 일이 벌어졌는지 알 수 있어야 한다(SQL 노출 없이).
            assertThat((String) asMap(res).get("message")).contains("500");

            assertThat(points(target)).as("409 인데 지갑이 변했다").isEqualTo(walletAfterFirst);
            assertThat(adminLedgerCount(target)).as("409 인데 원장이 늘었다").isEqualTo(ledgerAfterFirst);
            assertThat(auditCount(target)).as("409 인데 감사가 늘었다").isEqualTo(auditAfterFirst);
        }
    }

    /**
     * <b>어떤 admin 에러 응답에도 내부 SQL·스키마가 새지 않는다.</b>
     *
     * <p><b>주의(범위 명시)</b>: 이 테스트는 <b>소독기({@code AdminErrorHandler})의 회귀 가드가 아니다</b> —
     * 여기 열거한 경로들은 하드닝 이전에도 SQL 을 뱉지 않았다(전부 도메인이 던진 ApiException 이다).
     * 소독기의 실질 커버는 예외를 주입하는
     * {@code AdminUsersApiTest#databaseExceptionsAreSanitizedBeforeReachingTheClient} 하나다.
     * 이 테스트의 값어치는 "정상 에러 경로가 앞으로도 SQL 을 담지 않는다"를 고정하는 데 있다.
     */
    @Test
    void adminErrorResponsesNeverLeakSqlOrSchema() {
        String admin = adminToken();
        String target = user("pts_leak");

        List<String> errorBodies = new java.util.ArrayList<>();
        errorBodies.add(grant(admin, target, 0L, "제로", "leak-k1").body());
        errorBodies.add(grant(admin, target, 100L, null, "leak-k2").body());
        errorBodies.add(grant(admin, "NO_SUCH_USER", 100L, "없는 유저", "leak-k3").body());
        errorBodies.add(grant(admin, target, -999999999L, "과다 차감", "leak-k4").body());
        errorBodies.add(get("/api/admin/users/NO_SUCH_ID", admin).body());

        for (String body : errorBodies) {
            assertThat(body).as("응답에 SQL 문이 노출됐다: " + body)
                    .doesNotContain("INSERT").doesNotContain("SELECT").doesNotContain("UPDATE")
                    .doesNotContain("UNIQUE constraint").doesNotContain("CHECK constraint")
                    .doesNotContain("SQLITE_").doesNotContain("admin_audit").doesNotContain("point_ledger")
                    .doesNotContain("wallets").doesNotContain("org.springframework").doesNotContain("org.sqlite");
        }
    }

    // ───────────────────────── 입력 검증 ─────────────────────────

    /**
     * <b>minor-C</b>: malformed 요청 본문은 <b>내부 파서 메시지를 노출하지 않는다</b>.
     *
     * <p>W1·W2 교훈대로 상태코드만 보지 않는다 — leading {@code '+'}(Jackson 기본 파서 거부),
     * 잘린 JSON, 구분자 누락, 비-JSON 모두 <b>깨끗한 400</b>(code=VALIDATION_ERROR)으로 변환되고
     * 응답 본문에 Jackson 내부(예: {@code JsonReadFeature.ALLOW_LEADING_PLUS_SIGN} 힌트,
     * {@code com.fasterxml}, 파서 위치 {@code line:/column:})가 <b>부재</b>함을 <b>바디 문자열로 단정</b>한다.
     * 이 하드닝({@code AdminErrorHandler.handleUnreadableBody}) 을 제거하면 이 테스트가 FAIL 한다(뮤테이션 확인).
     * 부수효과도 0.
     */
    @Test
    void malformedRequestBodyIsCleanBadRequestWithoutLeak() {
        String admin = adminToken();
        String target = user("pts_malformed");
        long walletBefore = points(target);
        long ledgerBefore = adminLedgerCount(target);
        long auditBefore = auditCount(target);

        List<String> malformed = List.of(
                "{\"delta\": +5, \"reason\": \"x\"}",   // leading '+' — 검증자 실측 재현(파서 힌트 노출)
                "{\"delta\": 5, \"reason\":",            // 잘린 JSON
                "{\"delta\": 5 \"reason\": \"x\"}",      // 구분자 누락
                "not json at all",                      // 비-JSON
                "");                                     // 빈 본문(누락)

        for (String raw : malformed) {
            HttpResult res = grantRaw(admin, target, raw);
            assertThat(res.status()).as("malformed 바디인데 400 이 아니다: " + res.body())
                    .isEqualTo(HttpStatus.BAD_REQUEST);
            assertThat(asMap(res).get("code")).as("code 가 규약값이 아니다: " + res.body())
                    .isEqualTo("VALIDATION_ERROR");
            assertThat(res.body()).as("파서 내부 구현이 응답으로 노출됐다: " + res.body())
                    .doesNotContain("JsonReadFeature").doesNotContain("JsonParseException")
                    .doesNotContain("JsonMappingException").doesNotContain("JsonEOFException")
                    .doesNotContain("com.fasterxml").doesNotContain("ALLOW_LEADING_PLUS_SIGN")
                    .doesNotContain("Unexpected character").doesNotContain("Unexpected end-of-input")
                    .doesNotContain("line: ").doesNotContain("column: ")
                    .doesNotContain("org.springframework");
        }

        // 부수효과 0 — malformed 는 컨트롤러 진입 전에 걸러지므로 지갑·원장·감사 불변.
        assertThat(points(target)).isEqualTo(walletBefore);
        assertThat(adminLedgerCount(target)).isEqualTo(ledgerBefore);
        assertThat(auditCount(target)).isEqualTo(auditBefore);
    }

    @Test
    void invalidRequestsAreRejectedWithNoSideEffects() {
        String admin = adminToken();
        String target = user("pts_invalid");
        long walletBefore = points(target);
        long ledgerBefore = adminLedgerCount(target);
        long auditBefore = auditCount(target);

        assertThat(grant(admin, target, 0L, "제로", "k1").status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(grant(admin, target, 100L, "   ", "k2").status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(grant(admin, target, 100L, null, "k3").status()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(grant(admin, "NO_SUCH_USER", 100L, "없는 유저", "k4").status()).isEqualTo(HttpStatus.NOT_FOUND);

        assertThat(points(target)).isEqualTo(walletBefore);
        assertThat(adminLedgerCount(target)).isEqualTo(ledgerBefore);
        assertThat(auditCount(target)).isEqualTo(auditBefore);
    }

    // ───────────────────────── helpers ─────────────────────────

    private HttpResult grant(String adminToken, String targetId, Long delta, String reason, String idemKey) {
        Map<String, Object> body = new HashMap<>();
        body.put("delta", delta);
        body.put("reason", reason);
        try {
            java.net.http.HttpRequest.Builder builder = java.net.http.HttpRequest.newBuilder()
                    .uri(java.net.URI.create(baseUrl("/api/admin/users/" + targetId + "/points")))
                    .header("Content-Type", "application/json")
                    .header("Authorization", "Bearer " + adminToken);
            if (idemKey != null) {
                builder.header("Idempotency-Key", idemKey);
            }
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    builder.POST(java.net.http.HttpRequest.BodyPublishers.ofString(MAPPER.writeValueAsString(body)))
                            .build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    /** 직렬화 없이 raw 바디를 그대로 전송 — malformed JSON 재현용. */
    private HttpResult grantRaw(String adminToken, String targetId, String rawBody) {
        try {
            java.net.http.HttpResponse<String> res = java.net.http.HttpClient.newHttpClient().send(
                    java.net.http.HttpRequest.newBuilder()
                            .uri(java.net.URI.create(baseUrl("/api/admin/users/" + targetId + "/points")))
                            .header("Content-Type", "application/json")
                            .header("Authorization", "Bearer " + adminToken)
                            .POST(java.net.http.HttpRequest.BodyPublishers.ofString(rawBody))
                            .build(),
                    java.net.http.HttpResponse.BodyHandlers.ofString());
            return new HttpResult(HttpStatus.valueOf(res.statusCode()), res.body());
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
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

    private String adminToken() {
        Map<String, Object> body = new HashMap<>();
        body.put("provider", "local");
        body.put("nickname", ADMIN_NICK);
        body.put("password", ADMIN_PW);
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);
        return (String) asMap(res).get("token");
    }

    /** 일반 유저 생성 후 userId 반환. */
    private String user(String nickname) {
        login(nickname);
        return userIdOf(nickname);
    }

    private String userIdOf(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long adminLedgerCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND reason = 'admin_grant'")
                .param(userId).query(Long.class).single();
    }

    private long auditCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM admin_audit WHERE target_user_id = ?")
                .param(userId).query(Long.class).single();
    }
}
