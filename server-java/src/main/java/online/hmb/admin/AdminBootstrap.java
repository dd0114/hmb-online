package online.hmb.admin;

import java.util.Optional;
import online.hmb.auth.AccountLookup;
import online.hmb.auth.UserOnboardingService;
import online.hmb.common.TxRunner;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * admin 계정 격리(PRD-v4 P3-D4) — <b>누가 admin 인가는 오직 env 가 정한다</b>.
 * {@code HMB_ADMIN_NICKNAME} / {@code HMB_ADMIN_PASSWORD} (application.yml 경유,
 * {@code hmb.admin.nickname} / {@code hmb.admin.password}).
 *
 * <p><b>불변식: 부팅 후 admin 집합 = env 가 지정한 계정 하나, 미설정이면 공집합.</b>
 * 그래서 매 부팅마다 <b>전원 회수 후 한 명 부여</b>한다(증분 부여가 아니다). 이유:
 * <ul>
 *   <li>미설정인데 DB 에 예전 플래그가 남아 admin 이 <b>잔존</b>하는 드리프트를 원천 차단한다 —
 *       "env 를 지웠는데 여전히 admin 이 있다"가 불가능하다. 마이그레이션 DEFAULT 0 과 합쳐
 *       <b>설정 없이는 어떤 경로로도 admin 이 생기지 않는다</b>.</li>
 *   <li>admin 집합의 SoT 가 DB 가 아니라 <b>배포 설정</b>이 된다 — DB 파일을 들고 다녀도 권한이 따라오지 않는다.</li>
 * </ul>
 *
 * <p><b>계정이 없으면 만든다</b>(대기하지 않는다). 근거: 배포는 빈 DB 컨테이너에서 시작하는데,
 * 대기 방식이면 admin 은 HTTP 로 직접 가입해야 하고 그 사이 <b>누구나 그 닉네임을 선점</b>할 수 있다
 * (닉네임은 UNIQUE 이자 공개 표면이다 — 선점당하면 그 배포에는 admin 이 영원히 생기지 않는다).
 * 부팅 시 생성하면 트래픽을 받기 전에 닉네임을 확보한다. 생성은 일반 가입과 <b>동일한 온보딩</b>
 * ({@link UserOnboardingService}: 지갑·스타터팩·원장·관계)을 타므로 특수 계정이 아니다.
 *
 * <p><b>계정이 이미 있으면 비번을 env 값으로 맞춘다</b>. 근거: env 는 배포 시크릿이고 DB 행보다
 * 강한 권위다. 반대로 하면(DB 우선) env 를 설정하기 <b>전에</b> 그 닉네임을 선점해 둔 사람이
 * 그대로 admin 이 되는, 정확히 막으려던 상황이 된다.
 *
 * <p><b>AC-A2 규율 동일 적용</b>: 이 클래스는 비번을 어떤 레벨로도 로깅하지 않는다(값을 담은
 * 문자열을 만들지 않는다). 로그에 나가는 것은 닉네임과 "granted/created" 사실뿐이다.
 */
@Component
@org.springframework.core.annotation.Order(100)  // 카탈로그 시드 임포트(Order 0) 이후 — 계정 생성이 스타터팩(players FK)을 태운다.
public class AdminBootstrap implements ApplicationRunner {

    private static final Logger log = LoggerFactory.getLogger(AdminBootstrap.class);

    /** env 로 생성되는 admin 계정의 auth_provider — 자체 로그인(P3-D2)으로 들어온다. */
    private static final String PROVIDER = "local";

    private final JdbcClient jdbcClient;
    private final TxRunner txRunner;
    private final AccountLookup accounts;
    private final UserOnboardingService onboarding;
    private final String adminNickname;
    private final String adminPassword;

    public AdminBootstrap(JdbcClient jdbcClient,
                          TxRunner txRunner,
                          AccountLookup accounts,
                          UserOnboardingService onboarding,
                          @Value("${hmb.admin.nickname:}") String adminNickname,
                          @Value("${hmb.admin.password:}") String adminPassword) {
        this.jdbcClient = jdbcClient;
        this.txRunner = txRunner;
        this.accounts = accounts;
        this.onboarding = onboarding;
        this.adminNickname = adminNickname;
        this.adminPassword = adminPassword;
    }

    @Override
    public void run(ApplicationArguments args) {
        boolean hasNickname = adminNickname != null && !adminNickname.isBlank();
        boolean hasPassword = adminPassword != null && !adminPassword.isBlank();

        if (!hasNickname && !hasPassword) {
            // 기본 안전: 설정이 없으면 admin 0명. 잔존 플래그도 회수한다.
            long revoked = txRunner.<Long>run(() -> revokeAll());
            log.info("admin bootstrap disabled (hmb.admin.nickname unset) — admins=0 (revoked={})", revoked);
            return;
        }
        if (hasNickname != hasPassword) {
            // 부분 설정은 오설정이다. 조용히 admin 0명으로 두면 배포자가 "설정했다"고 믿는 채로
            // 운영이 불가능해진다 → 부팅을 실패시켜 크게 알린다.
            throw new IllegalStateException(
                    "admin 설정이 불완전하다 — hmb.admin.nickname 과 hmb.admin.password 는 "
                            + "둘 다 설정하거나 둘 다 비워야 한다 (설정된 쪽: "
                            + (hasNickname ? "nickname" : "password") + ")");
        }

        String userId = txRunner.run(() -> {
            revokeAll();
            String id = resolveOrCreate();
            jdbcClient.sql("UPDATE users SET is_admin = 1 WHERE id = ?").param(id).update();
            return id;
        });
        // 비번은 절대 찍지 않는다(AC-A2).
        log.info("admin bootstrap: nickname='{}' userId={} — admins=1", adminNickname, userId);
    }

    /** 부여 전 전원 회수 — admin 집합이 항상 env 와 정확히 일치하게 만드는 절반. */
    private long revokeAll() {
        return jdbcClient.sql("UPDATE users SET is_admin = 0 WHERE is_admin <> 0").update();
    }

    private String resolveOrCreate() {
        Optional<AccountLookup.Account> existing = accounts.findByNickname(adminNickname);
        if (existing.isPresent()) {
            String id = existing.get().id();
            // env 가 권위 — 기존 행의 비번/provider 를 env 기준으로 맞춘다.
            jdbcClient.sql("UPDATE users SET password = ?, auth_provider = ? WHERE id = ?")
                    .params(adminPassword, PROVIDER, id)
                    .update();
            return id;
        }
        UserOnboardingService.OnboardingResult result =
                onboarding.createUser(adminNickname, PROVIDER, adminPassword);
        if (result instanceof UserOnboardingService.OnboardingResult.Created created) {
            log.info("admin bootstrap: created account for nickname='{}'", adminNickname);
            return created.userId();
        }
        // 같은 tx 안에서 방금 부재를 확인했으므로 도달 불가에 가깝지만, 도달하면 fail-closed.
        throw new IllegalStateException("admin 계정 생성 실패 — 닉네임이 경합으로 선점됐다: " + adminNickname);
    }
}
