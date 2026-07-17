package online.hmb.common;

import java.util.function.Supplier;
import org.springframework.stereotype.Component;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;

/**
 * 트랜잭션 경계 = 서비스 메서드(LLD §"규칙"). 여러 테이블에 걸친 쓰기(예: 로그인 시
 * users+wallets 생성, 뽑기 시 비용차감+원장+보유풀)를 하나의 원자적 단위로 묶을 때 사용.
 */
@Component
public class TxRunner {
    private final TransactionTemplate transactionTemplate;

    public TxRunner(PlatformTransactionManager transactionManager) {
        this.transactionTemplate = new TransactionTemplate(transactionManager);
    }

    public <T> T run(Supplier<T> action) {
        return transactionTemplate.execute(status -> action.get());
    }

    public void run(Runnable action) {
        transactionTemplate.executeWithoutResult(status -> action.run());
    }
}
