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
 *
 * <p>⚠️ 이 클래스는 DB 를 메서드 간에 공유한다. 그래서 단언을 "전역에 자격자가 없다" 같은 절대
 * 명제로 쓰면 앞 메서드가 만든 유저에 오염된다 — <b>내가 만든 미자격자가 제시되지 않는다</b>는
 * 상대 명제로 건다. "자격자가 하나도 없을 때"의 절대 명제는 {@link AwayNoEligibleOpponentTest}
 * 가 자기 DB 에서 따로 본다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AwayEligibilityTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    /** 한 판도 안 한 계정은 후보로 제시되지 않는다. 제시되는 건 자격자뿐이다. */
    @SuppressWarnings("unchecked")
    @Test
    void defendersWithNoFinishedMatchAreNeverOffered() {
        setupUserWithDeck("ae_idleA");
        setupUserWithDeck("ae_idleB");
        setupUserWithDeck("ae_played");
        finishedMatch(userIdOf("ae_played"));
        String attacker = setupUserWithDeck("ae_atk2");

        ResponseEntity<Map> res = authGet("/api/away/candidates", attacker, Map.class);

        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Object> offered = ((List<Map<String, Object>>) res.getBody().get("candidates"))
                .stream().map(c -> c.get("userId")).map(Object.class::cast).toList();
        assertThat(offered).isNotEmpty();
        assertThat(offered).doesNotContain(userIdOf("ae_idleA"), userIdOf("ae_idleB"));
        // 제시된 전원이 실제로 완료 경기를 가진 유저다(자격 없는 누구도 새지 않았다).
        assertThat(offered).allSatisfy(id -> assertThat(finishedCount((String) id)).isGreaterThan(0));
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
        assertThat(finishedCount(userIdOf("ae_rookie"))).isZero();   // 정말 0판인 채로 통과했다
    }

    private int finishedCount(String userId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM matches WHERE user_id = ? AND result IS NOT NULL")
                .param(userId).query(Integer.class).single();
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
