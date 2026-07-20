package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import ch.qos.logback.classic.spi.ILoggingEvent;
import ch.qos.logback.core.read.ListAppender;
import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.slf4j.LoggerFactory;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * P3 §A 자체 로그인(P3-D2, AC-A1·AC-A2) — id(=nickname)+비번 목업.
 *
 * <p>AC-A1: 회원가입(중복 409) → 로그인(오답 401) → 토큰. 기존 provider 플로우 무회귀.
 * <p>AC-A2: 비번이 응답 본문·로그 어디에도 나오지 않는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class LocalAuthTest extends ApiTestBase {

    /** 로그·응답 어디에도 등장하면 안 되는 마커 비번(부분 문자열 검색으로 잡는다). */
    private static final String SECRET = "Zq7-secret-P4ssw0rd";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    private ListAppender<ILoggingEvent> logAppender;

    private ch.qos.logback.classic.Level originalLevel;

    /**
     * root 를 <b>TRACE</b> 로 올려서 캡처한다 — 기본 INFO 로는 DEBUG/TRACE 레벨 유출(예: SQL 바인딩
     * 파라미터 로깅)을 구조적으로 못 잡아 AC-A2 테스트가 이름값을 못 한다.
     */
    @BeforeEach
    void attachLogAppender() {
        ch.qos.logback.classic.Logger root =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        originalLevel = root.getLevel();
        root.setLevel(ch.qos.logback.classic.Level.TRACE);
        logAppender = new ListAppender<>();
        logAppender.start();
        root.addAppender(logAppender);
    }

    @AfterEach
    void detachLogAppender() {
        ch.qos.logback.classic.Logger root =
                (ch.qos.logback.classic.Logger) LoggerFactory.getLogger(org.slf4j.Logger.ROOT_LOGGER_NAME);
        root.detachAppender(logAppender);
        root.setLevel(originalLevel); // 다른 테스트에 레벨이 새지 않게 원복
        logAppender.stop();
    }

    // ───────────────────────── helpers ─────────────────────────

    private HttpResult registerRaw(String nickname, String password) {
        Map<String, Object> body = new HashMap<>();
        body.put("nickname", nickname);
        body.put("password", password);
        return postJson("/api/auth/register", body);
    }

    private HttpResult localLoginRaw(String nickname, String password) {
        Map<String, Object> body = new HashMap<>();
        body.put("nickname", nickname);
        body.put("provider", "local");
        body.put("password", password);
        return postJson("/api/auth/login", body);
    }

    // ───────────────────────── AC-A1 ─────────────────────────

    /** (a) 가입 → 토큰 → 그 토큰으로 인증 API 호출 성공. */
    @Test
    void registerIssuesTokenUsableOnAuthenticatedApi() {
        HttpResult res = registerRaw("local_a", SECRET);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);

        Map<String, Object> body = asMap(res);
        assertThat((String) body.get("token")).isNotBlank();
        assertThat((Boolean) body.get("isNew")).isTrue();
        Map<?, ?> user = (Map<?, ?>) body.get("user");
        assertThat(user.get("nickname")).isEqualTo("local_a");

        ResponseEntity<Map> me = authGet("/api/me", (String) body.get("token"), Map.class);
        assertThat(me.getStatusCode()).isEqualTo(HttpStatus.OK);

        // auth_provider = 'local', password 는 평문 목업으로 저장(P3-D2)
        assertThat(jdbcClient.sql("SELECT auth_provider FROM users WHERE nickname = 'local_a'")
                .query(String.class).single()).isEqualTo("local");
        assertThat(jdbcClient.sql("SELECT password FROM users WHERE nickname = 'local_a'")
                .query(String.class).single()).isEqualTo(SECRET);
    }

    /** 가입한 계정으로 로그인 → 토큰(신규 아님) → 인증 API 성공. */
    @Test
    void registeredAccountCanLoginWithCorrectPassword() {
        registerRaw("local_b", SECRET);

        HttpResult res = localLoginRaw("local_b", SECRET);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<String, Object> body = asMap(res);
        assertThat((Boolean) body.get("isNew")).isFalse();
        assertThat(authGet("/api/me", (String) body.get("token"), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);
    }

    /** (b) 중복 nickname 가입 → 409. */
    @Test
    void duplicateNicknameRegisterConflicts() {
        assertThat(registerRaw("local_dup", SECRET).getStatusCode()).isEqualTo(HttpStatus.OK);

        HttpResult second = registerRaw("local_dup", "another-Pw-123");
        assertThat(second.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(asMap(second).get("code")).isEqualTo("DUPLICATE_NICKNAME");

        // 기존 계정의 비번이 덮이지 않았다
        assertThat(jdbcClient.sql("SELECT password FROM users WHERE nickname = 'local_dup'")
                .query(String.class).single()).isEqualTo(SECRET);
    }

    /** 기존 게스트 닉네임과도 충돌해야 한다(같은 users.nickname UNIQUE 공간). */
    @Test
    void registerConflictsWithExistingGuestNickname() {
        login("guest_taken"); // 기존 guest 경로로 선점
        assertThat(registerRaw("guest_taken", SECRET).getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
    }

    /** (c) 잘못된 비번 로그인 → 401. */
    @Test
    void wrongPasswordLoginUnauthorized() {
        registerRaw("local_c", SECRET);

        HttpResult res = localLoginRaw("local_c", "wrong-password");
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(asMap(res).get("code")).isEqualTo("BAD_CREDENTIALS");
    }

    /** (d) 없는 계정 local 로그인 → 401 (계정 존재 여부를 누설하지 않도록 동일 코드). */
    @Test
    void unknownAccountLocalLoginUnauthorized() {
        HttpResult res = localLoginRaw("no_such_user", SECRET);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(asMap(res).get("code")).isEqualTo("BAD_CREDENTIALS");
        // 로그인 실패로 유저가 생성되지 않는다
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname = 'no_such_user'")
                .query(Long.class).single()).isZero();
    }

    /** password 없는 계정(guest 로 만들어진)에 local 로그인 시도 → 401. */
    @Test
    void localLoginAgainstPasswordlessAccountUnauthorized() {
        login("guest_only");
        HttpResult res = localLoginRaw("guest_only", SECRET);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /** (e) 가입 유저 온보딩 결과 == 기존 provider 온보딩 결과(지갑·스타터팩·원장·관계). */
    @Test
    void registeredUserOnboardingMatchesGuestOnboarding() {
        registerRaw("local_e", SECRET);
        login("guest_e");

        String localId = userId("local_e");
        String guestId = userId("guest_e");

        assertThat(points(localId)).isEqualTo(points(guestId)).isPositive();
        assertThat(ownedPlayers(localId)).isEqualTo(ownedPlayers(guestId)).isPositive();
        assertThat(starterLedger(localId)).isEqualTo(starterLedger(guestId)).isEqualTo(1L);
        assertThat(relationRows(localId)).isEqualTo(relationRows(guestId)).isPositive();
        assertThat(moraleRows(localId)).isEqualTo(moraleRows(guestId)).isEqualTo(1L);
    }

    // ─────────────── 우회 금지: 목업 provider 로 local 계정 로그인 불가 ───────────────

    /**
     * <b>회귀 박제(검증 blocker)</b>: 비번 건 계정은 목업 provider 4경로(생략·guest·mock:google·
     * mock:apple) 전부 401 이고 토큰/세션이 발급되지 않는다. 이 가드가 없으면 닉네임만 알면
     * 남의 세션을 받을 수 있었다(닉네임은 리그표·랭킹에 노출되는 공개 표면).
     */
    @Test
    void localAccountCannotBeLoggedInViaMockProviders() {
        registerRaw("local_byp", SECRET);
        String userId = userId("local_byp");
        long sessionsBefore = sessionCount(userId);

        for (String provider : mockProviderPaths()) {
            Map<String, Object> body = new HashMap<>();
            body.put("nickname", "local_byp");
            if (provider != null) {
                body.put("provider", provider);
            }
            HttpResult res = postJson("/api/auth/login", body);

            assertThat(res.status())
                    .as("provider=%s 로 local 계정 우회 로그인", provider)
                    .isEqualTo(HttpStatus.UNAUTHORIZED);
            assertThat(asMap(res).get("code")).isEqualTo("BAD_CREDENTIALS");
            assertThat(res.body()).doesNotContain("token").doesNotContain(userId);
            // 세션이 하나도 새로 발급되지 않았다
            assertThat(sessionCount(userId))
                    .as("provider=%s 401 인데 세션 발급됨", provider)
                    .isEqualTo(sessionsBefore);
        }

        // 정상 경로(local + 올바른 비번)는 여전히 통과 — 가드가 과잉이 아님
        assertThat(localLoginRaw("local_byp", SECRET).status()).isEqualTo(HttpStatus.OK);
    }

    /** 반대편 무회귀: 순수 guest 계정은 같은 4경로가 전부 200(가드가 기존 유저를 막지 않는다). */
    @Test
    void guestAccountStillLoginsViaAllMockProviderPaths() {
        login("guest_ok"); // 최초 가입(provider 생략 = guest)
        String userId = userId("guest_ok");

        for (String provider : mockProviderPaths()) {
            Map<String, Object> body = new HashMap<>();
            body.put("nickname", "guest_ok");
            if (provider != null) {
                body.put("provider", provider);
            }
            HttpResult res = postJson("/api/auth/login", body);

            assertThat(res.status()).as("provider=%s guest 무회귀", provider).isEqualTo(HttpStatus.OK);
            Map<String, Object> parsed = asMap(res);
            assertThat((String) parsed.get("token")).isNotBlank();
            assertThat((Boolean) parsed.get("isNew")).isFalse();
            assertThat(((Map<?, ?>) parsed.get("user")).get("id")).isEqualTo(userId);
        }
        // 비번 없는 계정에 local 로그인은 여전히 불가(반대 방향 가드)
        assertThat(localLoginRaw("guest_ok", SECRET).status()).isEqualTo(HttpStatus.UNAUTHORIZED);
    }

    /**
     * 실제 동시 요청 <b>광역 스윕</b> — 가입과 목업 로그인을 같은 닉네임에 동시 발사하고,
     * 상태코드가 아니라 {@code sessions} 행 수로 불변식을 단정한다:
     * <b>비번 걸린 계정의 세션은 자격을 제시한 요청(가입)이 만든 것만 존재한다.</b>
     *
     * <p><b>⚠️ 탐지력 주의</b>: 이 테스트는 문제의 인터리빙이 <b>실제로 발생해야만</b> 버그를 잡는데,
     * 그 창이 좁아 인프로세스에서는 거의 열리지 않는다 — 실측으로 <b>버그를 되살린 코드도 이 30라운드를
     * 통과했다</b>. 따라서 이건 보조 그물이고, 회귀 방지의 실제 증명은 인터리빙을 고정한
     * {@link LocalAuthRaceTest}(그쪽은 버그 되살리면 확실히 실패)가 담당한다.
     * 타이밍 가정이 없는 불변식만 단정하므로 플래키하지는 않다(깨지면 그건 진짜 버그다).
     */
    @Test
    void concurrentRegisterAndMockLoginNeverYieldSessionForCredentialedAccount() throws Exception {
        int rounds = 30;
        int credentialedRounds = 0;
        java.util.concurrent.ExecutorService pool = java.util.concurrent.Executors.newFixedThreadPool(4);
        try {
            for (int i = 0; i < rounds; i++) {
                String nickname = "race" + i;
                java.util.concurrent.CountDownLatch start = new java.util.concurrent.CountDownLatch(1);

                // 자격 제시 요청(가입) 1개 + 자격 미제시 요청(목업 로그인) 3개를 동시 발사
                java.util.concurrent.Future<HttpResult> registerFuture =
                        pool.submit(() -> awaitThen(start, () -> registerRaw(nickname, SECRET)));
                List<String> mockProviders = List.of("guest", "mock:google", "mock:apple");
                List<java.util.concurrent.Future<HttpResult>> mockFutures = new java.util.ArrayList<>();
                for (String provider : mockProviders) {
                    mockFutures.add(pool.submit(() -> awaitThen(start, () -> {
                        Map<String, Object> body = new HashMap<>();
                        body.put("nickname", nickname);
                        body.put("provider", provider);
                        return postJson("/api/auth/login", body);
                    })));
                }
                start.countDown();

                HttpResult registerRes = registerFuture.get();
                List<HttpResult> mockResults = new java.util.ArrayList<>();
                for (java.util.concurrent.Future<HttpResult> f : mockFutures) {
                    mockResults.add(f.get());
                }

                String storedPassword = jdbcClient
                        .sql("SELECT password FROM users WHERE nickname = ?").param(nickname)
                        .query(String.class).optional().orElse(null);
                if (storedPassword == null) {
                    continue; // 목업 요청이 먼저 계정을 만든 라운드(비번 없는 계정) — 검사 대상 아님
                }
                credentialedRounds++;

                String userId = userId(nickname);
                long mockSuccesses = mockResults.stream().filter(r -> r.status() == HttpStatus.OK).count();
                long registerSuccesses = registerRes.status() == HttpStatus.OK ? 1 : 0;

                String diagnostics = String.format(
                        "round=%d nickname=%s register=%s mock=%s (자격 미제시 요청이 비번 걸린 계정의 "
                                + "세션을 받았다면 우회 성공)",
                        i, nickname, registerRes.status(),
                        mockResults.stream().map(r -> String.valueOf(r.status())).toList());

                assertThat(mockSuccesses).as(diagnostics).isZero();
                assertThat(sessionCount(userId)).as(diagnostics).isEqualTo(registerSuccesses);
            }
        } finally {
            pool.shutdownNow();
        }

        // 공허 방지: 가입이 이긴 라운드가 하나도 없었다면 위 불변식을 한 번도 검사하지 않은 것이다.
        assertThat(credentialedRounds)
                .as("비번 걸린 계정이 만들어진 라운드가 0 — 경합이 발생하지 않아 테스트가 공허하다")
                .isPositive();
    }

    private static HttpResult awaitThen(java.util.concurrent.CountDownLatch start,
                                        java.util.function.Supplier<HttpResult> call) {
        try {
            start.await();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        }
        return call.get();
    }

    /** provider 생략 / guest / mock:google / mock:apple — 목업 경로 4종. */
    private static List<String> mockProviderPaths() {
        return java.util.Arrays.asList(null, "guest", "mock:google", "mock:apple");
    }

    // ───────────────────────── AC-A2 ─────────────────────────

    /** (f) 성공/실패 응답 본문 어디에도 비번 문자열이 없다. */
    @Test
    void passwordNeverAppearsInResponseBodies() {
        assertThat(registerRaw("local_f", SECRET).getBody()).doesNotContain(SECRET);
        assertThat(localLoginRaw("local_f", SECRET).getBody()).doesNotContain(SECRET);
        assertThat(localLoginRaw("local_f", "wrong-" + SECRET).getBody()).doesNotContain(SECRET);
        assertThat(registerRaw("local_f", SECRET).getBody()).doesNotContain(SECRET); // 409 경로
        assertThat(localLoginRaw("nope_f", SECRET).getBody()).doesNotContain(SECRET); // 401 경로
        assertThat(registerRaw("!!bad nick!!", SECRET).getBody()).doesNotContain(SECRET); // 400 경로

        // /api/me 등 이후 응답에도 노출 없음
        Map<String, Object> ok = asMap(localLoginRaw("local_f", SECRET));
        ResponseEntity<String> me = authGet("/api/me", (String) ok.get("token"), String.class);
        assertThat(me.getBody()).doesNotContain(SECRET);
    }

    /** (f) 어떤 로그 라인(메시지·인자·예외)에도 비번이 나오지 않는다. */
    @Test
    void passwordNeverAppearsInLogs() {
        registerRaw("local_g", SECRET);
        localLoginRaw("local_g", SECRET);
        localLoginRaw("local_g", "wrong-" + SECRET);
        localLoginRaw("nope_g", SECRET);
        registerRaw("local_g", SECRET);
        registerRaw("x", SECRET); // 검증 실패

        List<ILoggingEvent> events = List.copyOf(logAppender.list);

        // 서블릿 컨테이너의 와이어 로그(org.apache.coyote.http11 Http11InputBuffer "Received [...]")는
        // TRACE 에서 **요청 원문 바이트를 통째로** 덤프한다 — 전 엔드포인트 공통이고(비번 특정 아님)
        // 애플리케이션 코드로는 막을 수 없으며 어떤 배포 설정에서도 켜지 않는다. 제외 범위는 이 논증이
        // 실제로 커버하는 계층(coyote/tomcat 와이어 I/O)으로 한정한다 — 검사 구멍을 넓게 열어두지 않는다.
        List<ILoggingEvent> appEvents = events.stream()
                .filter(e -> !e.getLoggerName().startsWith("org.apache.coyote.")
                        && !e.getLoggerName().startsWith("org.apache.tomcat."))
                .toList();

        assertThat(appEvents).as("TRACE 로그가 하나도 안 잡히면 이 테스트는 공허하다").isNotEmpty();
        for (ILoggingEvent e : appEvents) {
            assertThat(e.getFormattedMessage())
                    .as("logger=%s", e.getLoggerName())
                    .doesNotContain(SECRET);
            if (e.getThrowableProxy() != null) {
                assertThat(String.valueOf(e.getThrowableProxy().getMessage())).doesNotContain(SECRET);
            }
        }

        // 공허 방지: 요청 바디가 실제로 문자열화돼 로그에 찍혔고(=Spring web TRACE 가 살아있고),
        // 거기서 비번이 record toString 마스킹으로 가려졌음을 확인한다.
        assertThat(appEvents.stream()
                .map(ILoggingEvent::getFormattedMessage)
                .anyMatch(m -> m.contains("RegisterRequest[") || m.contains("LoginRequest[")))
                .as("요청 바디 문자열화 로그가 캡처되지 않음 — 마스킹 검증이 무의미해진다")
                .isTrue();
    }

    /** LoginRequest/RegisterRequest 는 record 라 toString 유출 위험 — 마스킹돼야 한다. */
    @Test
    void requestRecordToStringMasksPassword() {
        assertThat(new online.hmb.auth.LoginRequest("nick", "local", SECRET).toString())
                .doesNotContain(SECRET)
                .contains("nick");
        assertThat(new online.hmb.auth.RegisterRequest("nick", SECRET).toString())
                .doesNotContain(SECRET);
    }

    // ───────────────────────── (g) 무회귀 ─────────────────────────

    @Test
    void existingProviderFlowsUnchanged() {
        // guest(생략) / guest(명시) / mock:google / mock:apple 모두 기존과 동일
        assertThat(login("reg_guest")).isNotBlank();

        for (String provider : List.of("guest", "mock:google", "mock:apple")) {
            String nickname = "nr_" + provider.replace(':', '_');
            Map<String, Object> body = new HashMap<>();
            body.put("nickname", nickname);
            body.put("provider", provider);
            ResponseEntity<Map> res = rest.postForEntity(baseUrl("/api/auth/login"), body, Map.class);
            assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
            assertThat((Boolean) res.getBody().get("isNew")).isTrue();
            assertThat(jdbcClient.sql("SELECT auth_provider FROM users WHERE nickname = ?")
                    .param(nickname).query(String.class).single()).isEqualTo(provider);
            assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname = ? AND password IS NULL")
                    .param(nickname).query(Long.class).single()).isEqualTo(1L);
        }

        // 미지원 provider 는 여전히 400 VALIDATION_ERROR
        Map<String, Object> bad = new HashMap<>();
        bad.put("nickname", "reg_bad");
        bad.put("provider", "mock:facebook");
        ResponseEntity<Map> res = rest.postForEntity(baseUrl("/api/auth/login"), bad, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody().get("code")).isEqualTo("VALIDATION_ERROR");
    }

    /** 가입 시 닉네임/비번 검증(형식 위반 400) — 유저는 생성되지 않는다. */
    @Test
    void registerValidatesNicknameAndPassword() {
        assertThat(registerRaw("x", SECRET).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(registerRaw("local_v", "").getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(registerRaw("local_v", null).getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname IN ('x','local_v')")
                .query(Long.class).single()).isZero();
    }

    /** local 로그인에 password 누락 → 400(검증) 이 아니라 401 이어도 되지만, 유저 생성은 금지. */
    @Test
    void localLoginWithoutPasswordDoesNotCreateUser() {
        Map<String, Object> body = new HashMap<>();
        body.put("nickname", "local_np");
        body.put("provider", "local");
        HttpResult res = postJson("/api/auth/login", body);
        assertThat(res.status().is2xxSuccessful()).isFalse();
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname = 'local_np'")
                .query(Long.class).single()).isZero();
    }

    // ───────────────────────── db helpers ─────────────────────────

    private String userId(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(nickname)
                .query(String.class).single();
    }

    private Long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private Long ownedPlayers(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM user_players WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private Long starterLedger(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM point_ledger WHERE user_id = ? AND reason = 'starter'")
                .param(userId).query(Long.class).single();
    }

    private Long relationRows(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM player_relations WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private long sessionCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM sessions WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }

    private Long moraleRows(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM team_morale WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }
}
