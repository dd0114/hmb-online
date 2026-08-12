package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import jakarta.annotation.Resource;
import java.sql.SQLException;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Supplier;
import online.hmb.common.ApiException;
import online.hmb.common.TxRunner;
import online.hmb.trade.TradeService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Primary;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.UncategorizedSQLException;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.springframework.transaction.PlatformTransactionManager;

/**
 * #152 재시도 정책의 결정론적 검증 — 실제 경합에 의존하지 않고 {@link TxRunner} 를 "처음 N번은
 * SQLITE_BUSY 로 실패" 하는 스텁으로 갈아끼워 확인한다.
 *
 * <ul>
 *   <li>config 한도 안에서 실패하면 <b>재시도로 성공</b>한다(유저는 오류를 보지 않는다)</li>
 *   <li>한도를 넘겨도 <b>5xx 가 아니라 계약 코드 TRADE_INVALID(400)</b> 로 내려간다</li>
 * </ul>
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT, properties = {
        "hmb.trade.busy-retry.max-attempts=4",
        "hmb.trade.busy-retry.backoff-ms=1"
})
class TradeBusyRetryTest extends ApiTestBase {

    /** 남은 강제 실패 횟수 — 테스트가 세팅한다. */
    static final AtomicInteger FAILURES_LEFT = new AtomicInteger();

    static UncategorizedSQLException busy() {
        return new UncategorizedSQLException("PreparedStatementCallback", "UPDATE trade_slots ...",
                new SQLException("[SQLITE_BUSY_SNAPSHOT] Another database connection has already written "
                        + "to the database (database is locked)", null, 5));
    }

    /** 처음 FAILURES_LEFT 번의 트랜잭션 시도를 BUSY 로 떨어뜨리는 TxRunner. */
    static class FlakyTxRunner extends TxRunner {
        FlakyTxRunner(PlatformTransactionManager transactionManager) {
            super(transactionManager);
        }

        @Override
        public <T> T run(Supplier<T> action) {
            if (FAILURES_LEFT.getAndDecrement() > 0) {
                throw busy();
            }
            return super.run(action);
        }
    }

    @TestConfiguration
    static class FlakyTxConfig {
        @Bean
        @Primary
        TxRunner flakyTxRunner(PlatformTransactionManager transactionManager) {
            return new FlakyTxRunner(transactionManager);
        }
    }

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // #493 W6-v3: 이 테스트의 주제는 튜토리얼이 아니다 — 가입 무료 쿠폰을 끄고
        // 과금·롤을 '출발 상태 그대로' 본다(TestDbSupport.disableTutorialStarter javadoc).
        TestDbSupport.disableTutorialStarter(registry);
    }

    @Resource
    private JdbcClient jdbcClient;

    @Resource
    private TradeService tradeService;

    @BeforeEach
    void resetFailures() {
        FAILURES_LEFT.set(0);
    }

    private String userId(String nickname) {
        return jdbcClient.sql("SELECT id FROM users WHERE nickname=?")
                .param(nickname).query(String.class).single();
    }

    @Test
    void retriesTransientBusyAndSucceeds() {
        login("trade_busy_ok");
        String uid = userId("trade_busy_ok");
        tradeService.ensureSlots(uid); // 슬롯 생성(재시도 스텁 밖 경로)

        FAILURES_LEFT.set(2); // 4회 한도 중 2회 실패 → 3번째 시도에서 성공
        TradeService.TradeStartResponse res = tradeService.start(uid, 1);
        assertThat(res.slot().state()).isEqualTo("WAITING");
        assertThat(FAILURES_LEFT.get()).isLessThanOrEqualTo(0); // 실제로 재시도가 소비됐다
        assertThat(jdbcClient.sql("SELECT state FROM trade_slots WHERE user_id=? AND slot_no=1")
                .param(uid).query(String.class).single()).isEqualTo("WAITING");
    }

    @Test
    void exhaustedRetriesSurfaceAsContractErrorNot5xx() {
        login("trade_busy_no");
        String uid = userId("trade_busy_no");
        tradeService.ensureSlots(uid);

        FAILURES_LEFT.set(99); // 한도 소진
        assertThatThrownBy(() -> tradeService.start(uid, 1))
                .isInstanceOfSatisfying(ApiException.class, e -> {
                    assertThat(e.getStatus()).isEqualTo(HttpStatus.BAD_REQUEST); // 5xx 아님
                    assertThat(e.toApiError().code()).isEqualTo("TRADE_INVALID"); // 계약 enum 값
                });
        // 부분 쓰기 없음(슬롯은 그대로 IDLE)
        assertThat(jdbcClient.sql("SELECT state FROM trade_slots WHERE user_id=? AND slot_no=1")
                .param(uid).query(String.class).single()).isEqualTo("IDLE");
    }
}
