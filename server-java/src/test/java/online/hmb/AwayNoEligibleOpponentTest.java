package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #296 AC3 — <b>전체 폴백에도 자격이 걸리는가</b>. 자기 DB 를 쓰는 단일 케이스 클래스다(다른 메서드가
 * 만든 자격자에 오염되면 이 명제 자체가 성립하지 않는다).
 *
 * <p>{@code AwayService.bandPool()} 은 밴드를 ±50 → ×4 로 넓히고 <b>그래도 비면 전체</b>로 폴백한다.
 * 폴백 쿼리에 자격 조건이 안 걸리면 여기서 미자격자가 후보로 되살아나고 200 이 떨어진다 — 즉 이
 * 테스트는 "폴백이 필터의 우회로가 되지 않는다"를 단독으로 지킨다. 같은 종류의 우회로(밴드 없는 별도
 * 쿼리)가 예전에 실제로 있었다(MAJ-1).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AwayNoEligibleOpponentTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Test
    void noOpponentWhenEveryDefenderHasNeverFinishedAMatch() {
        setupUserWithDeck("nq_idle1");
        setupUserWithDeck("nq_idle2");
        setupUserWithDeck("nq_idle3");
        String attacker = setupUserWithDeck("nq_atk");

        ResponseEntity<String> res = authGet("/api/away/candidates", attacker, String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody()).contains("NO_OPPONENT");
    }
}
