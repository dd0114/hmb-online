package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.atLeast;
import static org.mockito.Mockito.doCallRealMethod;
import static org.mockito.Mockito.doReturn;
import static org.mockito.Mockito.verify;

import jakarta.annotation.Resource;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.mock.mockito.SpyBean;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>동시 경로 회귀 박제(결정론)</b> — 자격 미제시 로그인(guest/mock:*)이 <b>가입 커밋과 겹치는
 * 인터리빙</b>에서도 비번 걸린 계정의 세션을 받지 못함을 증명한다.
 *
 * <p>왜 이 형태인가: 실제 동시 요청(스레드 N개)로는 문제의 창이 좁아 <b>재현이 확률적</b>이라
 * 회귀 테스트로 못 쓴다(실측: 인프로세스 30라운드 동시 발사로는 버그 있는 코드도 그냥 통과했다).
 * 그래서 창을 넓히는 대신 <b>인터리빙을 고정</b>한다 — 목업 경로의 <b>첫</b> 닉네임 조회(tx 밖 사전
 * 확인)만 "아직 없음"으로 만들고, 그 다음 조회(온보딩 tx 내부 재확인)부터는 실제 계정을 보게 한다.
 * 이게 정확히 "사전 확인 이후, tx 내부 재확인 이전에 가입이 커밋된" 상황이다.
 *
 * <p>불변식(상태코드가 아니라 <b>세션 행 수</b>로 단정): 자격을 제시하지 않은 요청은
 * 비번 걸린 계정의 세션을 <b>단 하나도</b> 만들 수 없다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class LocalAuthRaceTest extends ApiTestBase {

    private static final String NICKNAME = "race_det";
    private static final String SECRET = "Zq7-secret-P4ssw0rd";

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    /** 실제 빈을 감싼 스파이 — 조회 결과만 특정 시점에 갈아끼워 인터리빙을 고정한다. */
    @SpyBean
    private online.hmb.auth.AccountLookup accounts;

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void mockLoginCannotStealSessionWhenRegisterCommitsMidTransaction() {
        // 1) 비번 걸린 계정이 실제로 존재한다(가입 완료 = 커밋됨).
        Map<String, Object> registerBody = new HashMap<>();
        registerBody.put("nickname", NICKNAME);
        registerBody.put("password", SECRET);
        assertThat(postJson("/api/auth/register", registerBody).status()).isEqualTo(HttpStatus.OK);

        String userId = jdbcClient.sql("SELECT id FROM users WHERE nickname = ?").param(NICKNAME)
                .query(String.class).single();
        long sessionsBefore = sessionCount(userId);

        // 2) 인터리빙 고정: 첫 조회(사전 확인)만 empty → 목업 경로가 "신규 가입"이라 믿고 온보딩 tx 진입.
        //    두 번째 조회(tx 내부 재확인)부터는 실제 계정(비번 있음)을 본다 = 그 사이 가입이 커밋된 상황.
        doReturn(Optional.empty()).doCallRealMethod().when(accounts).findByNickname(eq(NICKNAME));

        Map<String, Object> loginBody = new HashMap<>();
        loginBody.put("nickname", NICKNAME);
        loginBody.put("provider", "guest");
        HttpResult res = postJson("/api/auth/login", loginBody);

        String diagnostics = "자격 미제시(guest) 요청이 비번 걸린 계정 세션을 획득했다 — "
                + "status=" + res.status() + " body=" + res.body();

        // 세션 행 수가 진짜 판정 기준이다(상태코드만 보면 이 버그를 구조적으로 못 잡는다).
        assertThat(sessionCount(userId)).as(diagnostics).isEqualTo(sessionsBefore);
        assertThat(res.status()).as(diagnostics).isEqualTo(HttpStatus.UNAUTHORIZED);
        assertThat(asMap(res).get("code")).isEqualTo("BAD_CREDENTIALS");

        // 공허 방지: 스텁이 실제로 그 경로를 태웠는가(사전 확인 + tx 내부 재확인 = 최소 2회 조회).
        verify(accounts, atLeast(2)).findByNickname(eq(NICKNAME));
    }

    private long sessionCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM sessions WHERE user_id = ?").param(userId)
                .query(Long.class).single();
    }
}
