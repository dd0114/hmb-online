package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.annotation.Resource;
import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.Map;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>admin 격리(P3-D4)</b> — "누가 admin 인가"는 env 만이 정한다.
 *
 * <p>핵심 불변식 두 개를 각각 독립 컨텍스트에서 검증한다:
 * <ol>
 *   <li><b>미설정 → admin 0명</b>. 그냥 0명인 게 아니라, DB 에 이미 플래그가 <b>박혀 있어도</b>
 *       부팅이 회수한다(드리프트로 admin 이 잔존하는 실패 모드가 없다).</li>
 *   <li><b>설정 → 정확히 그 계정 1명</b>. 다른 계정에 플래그가 있었다면 회수된다.</li>
 * </ol>
 * 부분 설정(한쪽만)은 부팅 실패 — 조용히 0명이 되면 배포자가 오설정을 모른다.
 */
class AdminBootstrapTest {

    /** ① env 미설정 — 기본 안전. */
    @Nested
    @SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
    class WhenUnset extends ApiTestBase {

        @DynamicPropertySource
        static void props(DynamicPropertyRegistry registry) {
            TestDbSupport.registerTempDb(registry);
            // hmb.admin.* 를 일부러 등록하지 않는다 = 배포에서 env 를 안 준 상태.
        }

        @Resource
        private JdbcClient jdbcClient;

        @Test
        void noAdminExistsAndPreExistingFlagsAreRevokedOnBoot() {
            // 부팅 직후: admin 0명
            assertThat(adminCount()).as("env 미설정인데 admin 이 생겼다").isZero();

            // 누가 DB 를 직접 만졌다고 가정 — 다음 부팅에서 회수돼야 하지만,
            // 지금 컨텍스트에서는 최소한 게이트가 그 플래그를 신뢰한다는 사실만 확인한다.
            String token = login("unset_probe");
            assertThat(adminCount()).isZero();

            // admin 이 0명이므로 어떤 유저도 admin API 를 통과할 수 없다.
            assertThat(authGet("/api/admin/users", token, String.class).getStatusCode())
                    .isEqualTo(HttpStatus.FORBIDDEN);
        }

        private long adminCount() {
            return jdbcClient.sql("SELECT COUNT(*) FROM users WHERE is_admin <> 0").query(Long.class).single();
        }
    }

    /** ② env 설정 — 정확히 한 명. */
    @Nested
    @SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
    class WhenSet extends ApiTestBase {

        static final String NICK = "boot_admin";
        static final String PW = "boot-admin-pw-4242";

        @DynamicPropertySource
        static void props(DynamicPropertyRegistry registry) {
            TestDbSupport.registerTempDb(registry);
            registry.add("hmb.admin.nickname", () -> NICK);
            registry.add("hmb.admin.password", () -> PW);
        }

        @Resource
        private JdbcClient jdbcClient;

        @Test
        void exactlyTheConfiguredAccountIsAdminAndItWasCreatedIfMissing() {
            assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE is_admin <> 0")
                    .query(Long.class).single()).isEqualTo(1L);
            assertThat(jdbcClient.sql("SELECT nickname FROM users WHERE is_admin <> 0")
                    .query(String.class).single()).isEqualTo(NICK);

            // 계정이 없었으므로 부팅이 만들었다 — 일반 온보딩(지갑)을 그대로 탔다.
            String id = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(NICK)
                    .query(String.class).single();
            assertThat(jdbcClient.sql("SELECT COUNT(*) FROM wallets WHERE user_id = ?").param(id)
                    .query(Long.class).single()).isEqualTo(1L);
        }

        /** 부팅이 심은 자격으로 실제 로그인이 되고, 그 토큰만 admin API 를 통과한다. */
        @Test
        void configuredCredentialsLogInAndPassTheGate() {
            Map<String, Object> body = new HashMap<>();
            body.put("provider", "local");
            body.put("nickname", NICK);
            body.put("password", PW);
            HttpResult res = postJson("/api/auth/login", body);
            assertThat(res.status()).as(res.body()).isEqualTo(HttpStatus.OK);

            String adminToken = (String) asMap(res).get("token");
            assertThat(authGet("/api/admin/users", adminToken, String.class).getStatusCode())
                    .isEqualTo(HttpStatus.OK);

            // W1 회귀: admin 계정도 닉네임만으로는 세션을 못 얻는다(자격 게이트가 admin 에도 적용).
            Map<String, Object> bypass = new HashMap<>();
            bypass.put("nickname", NICK);
            bypass.put("provider", "guest");
            assertThat(postJson("/api/auth/login", bypass).status()).isEqualTo(HttpStatus.UNAUTHORIZED);
        }

        /** 새로 가입한 유저는 admin 이 아니다 — 부여 경로가 부팅 하나뿐임을 확인. */
        @Test
        void newlyRegisteredUsersAreNeverAdmin() {
            Map<String, Object> body = new HashMap<>();
            body.put("nickname", "boot_wannabe");
            body.put("password", "wannabe-pw-1234");
            assertThat(postJson("/api/auth/register", body).status()).isEqualTo(HttpStatus.OK);

            assertThat(jdbcClient.sql("SELECT is_admin FROM users WHERE nickname = 'boot_wannabe'")
                    .query(Integer.class).single()).isZero();
            assertThat(jdbcClient.sql("SELECT COUNT(*) FROM users WHERE is_admin <> 0")
                    .query(Long.class).single()).isEqualTo(1L);
        }
    }

    /**
     * ③ 재부팅 시나리오 — 같은 DB 파일을 두 번 띄운다.
     * 첫 부팅은 admin 을 만들고, env 를 <b>지운</b> 두 번째 부팅은 그 플래그를 <b>회수</b>한다.
     * 이게 "설정 없이는 admin 이 존재할 수 없다"의 진짜 증명이다(fresh DB 라서 0명인 게 아니다).
     */
    @Test
    void secondBootWithoutEnvRevokesPreviouslyGrantedAdmin() throws IOException {
        Path db = Files.createTempFile("hmb-adminboot-", ".db");
        Files.deleteIfExists(db);
        String[] common = {
                "--server.port=0",
                "--hmb.db.path=" + db.toAbsolutePath(),
                "--hmb.data.players-file=src/test/resources/fixtures/players.v1.json",
                "--hmb.data.economy-file=src/test/resources/fixtures/economy.v1.json",
                "--hmb.data.bots-file=src/test/resources/fixtures/bots.v1.json",
        };

        // 1차 부팅: env 설정 → admin 1명
        try (ConfigurableApplicationContext ctx = SpringApplication.run(online.hmb.Application.class,
                concat(common, "--hmb.admin.nickname=reboot_admin", "--hmb.admin.password=reboot-pw-1234"))) {
            assertThat(adminNicknames(ctx)).containsExactly("reboot_admin");
        }

        // 2차 부팅: env 제거 → 잔존 플래그 회수, admin 0명
        try (ConfigurableApplicationContext ctx = SpringApplication.run(online.hmb.Application.class, common)) {
            assertThat(adminNicknames(ctx)).as("env 를 지웠는데 admin 이 살아남았다").isEmpty();
            // 계정 자체는 남아 있다(권한만 회수 — 데이터 파괴 금지)
            assertThat(ctx.getBean(JdbcClient.class)
                    .sql("SELECT COUNT(*) FROM users WHERE nickname = 'reboot_admin'")
                    .query(Long.class).single()).isEqualTo(1L);
        }
    }

    /** ④ 부분 설정(한쪽만) = 오설정 → 부팅 실패로 크게 알린다(조용히 0명이 되지 않는다). */
    @Test
    void partialConfigurationFailsBootLoudly() throws IOException {
        Path db = Files.createTempFile("hmb-adminpartial-", ".db");
        Files.deleteIfExists(db);
        String[] args = {
                "--server.port=0",
                "--hmb.db.path=" + db.toAbsolutePath(),
                "--hmb.data.players-file=src/test/resources/fixtures/players.v1.json",
                "--hmb.data.economy-file=src/test/resources/fixtures/economy.v1.json",
                "--hmb.data.bots-file=src/test/resources/fixtures/bots.v1.json",
                "--hmb.admin.nickname=half_configured",
        };
        assertThatThrownBy(() -> SpringApplication.run(online.hmb.Application.class, args).close())
                .hasMessageContaining("admin 설정이 불완전하다");
    }

    private static java.util.List<String> adminNicknames(ConfigurableApplicationContext ctx) {
        return ctx.getBean(JdbcClient.class)
                .sql("SELECT nickname FROM users WHERE is_admin <> 0")
                .query(String.class).list();
    }

    private static String[] concat(String[] base, String... extra) {
        String[] out = new String[base.length + extra.length];
        System.arraycopy(base, 0, out, 0, base.length);
        System.arraycopy(extra, 0, out, base.length, extra.length);
        return out;
    }
}
