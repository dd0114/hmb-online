package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.List;
import java.util.Map;
import online.hmb.common.Ulid;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #296 AC3 — 원정 <b>상대 후보</b> 자격("게임 한 판 한 유저만 고스트로 세운다").
 *
 * <p>왜: 후보 조건이 "활성 덱 보유"였는데 덱은 <b>가입 시 자동 지급</b>된다(스타터 15장). 그래서
 * 가입만 한 계정이 전부 원정 상대로 섰다 — 라이브에선 후보 40명 중 실제로 플레이한 흔적이 있는 건
 * 9명뿐이었다(#288). 실유저가 원정을 가면 대부분 빈 껍데기를 만났다는 뜻이다.
 *
 * <p>hero 확정(D3): 자격은 <b>상대 풀에만</b> 건다. 원정을 가는 쪽은 지금처럼 덱만 있으면 된다 —
 * 신규 유저의 첫 원정을 막지 않기 위해서다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AwayEligibilityTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    /**
     * 덱만 있고 한 판도 안 한 계정뿐이면 상대가 없다.
     *
     * <p>⚠️ 이 한 케이스가 <b>밴드 확장과 전체 폴백을 동시에</b> 검증한다: {@code bandPool()} 은
     * ±50 → ×4 로 넓히고 그래도 비면 <b>전체</b>로 폴백한다. 폴백에 필터를 안 걸면 여기서 미자격자가
     * 후보로 돌아오고 이 테스트가 깨진다 — 폴백이 필터의 우회로가 되는 걸 막는 게 이 assert 다.
     */
    @Test
    void noOpponentWhenEveryDefenderHasNeverFinishedAMatch() {
        setupUserWithDeck("ae_idle1");
        setupUserWithDeck("ae_idle2");
        setupUserWithDeck("ae_idle3");
        String attacker = setupUserWithDeck("ae_atk");

        ResponseEntity<String> res = authGet("/api/away/candidates", attacker, String.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.NOT_FOUND);
        assertThat(res.getBody()).contains("NO_OPPONENT");
    }

    /** 한 판 한 계정만 후보로 제시된다. */
    @SuppressWarnings("unchecked")
    @Test
    void onlyDefendersWithAFinishedMatchAreOffered() {
        setupUserWithDeck("ae_idleA");
        setupUserWithDeck("ae_idleB");
        setupUserWithDeck("ae_played");
        finishedMatch(userIdOf("ae_played"));
        String attacker = setupUserWithDeck("ae_atk2");

        ResponseEntity<Map> res = authGet("/api/away/candidates", attacker, Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> offered = (List<Map<String, Object>>) res.getBody().get("candidates");
        assertThat(offered.stream().map(c -> c.get("userId")).toList())
                .containsExactly(userIdOf("ae_played"));
    }

    /**
     * D3 — 공격자는 자격을 요구받지 않는다. 가입 직후(경기 0판)에도 원정을 갈 수 있다.
     * 이걸 박아두지 않으면 나중에 "대칭이 예뻐서" 공격자에도 필터를 걸어 신규 유저의 첫 원정을 막게 된다.
     */
    @SuppressWarnings("unchecked")
    @Test
    void attackerNeedsNoMatchHistory() {
        setupUserWithDeck("ae_target");
        finishedMatch(userIdOf("ae_target"));
        String rookie = setupUserWithDeck("ae_rookie");   // 경기 0판

        ResponseEntity<Map> res = authGet("/api/away/candidates", rookie, Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        assertThat((List<Map<String, Object>>) res.getBody().get("candidates")).isNotEmpty();
    }

    private void finishedMatch(String userId) {
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', '0.9.0', '{}', 'practice', 'WIN', ?)
                        """)
                .params(Ulid.next(), userId, "2026-05-01T00:00:00Z")
                .update();
    }
}
