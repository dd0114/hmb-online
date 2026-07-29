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
 * #296 AC4 — 자격 필터의 <b>롤백 스위치</b>. {@code hmb.eligibility.enabled=false} 면 필터 도입 전
 * 동작으로 정확히 돌아온다(가입만 한 계정도 리더보드·원정 후보에 실린다).
 *
 * <p>왜 계약으로 박나: 오픈베타에서 후보 풀이 얇아 {@code NO_OPPONENT} 이 늘면 재배포 없이 끌 수
 * 있어야 한다. 스위치가 "있다"고 주장만 하고 실제로 안 꺼지는 경우를 막는 게 이 테스트의 일이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class EligibilityDisabledTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        registry.add("hmb.eligibility.enabled", () -> "false");
    }

    @SuppressWarnings("unchecked")
    @Test
    void disabledSwitchRestoresPreFilterBehaviour() {
        String seedToken = login("dis_seed");
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                            user_deck_json, mode, result, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', '0.9.0', '{}', 'practice', 'WIN', ?)
                        """)
                .params(Ulid.next(), userIdOf("dis_seed"), "2026-05-01T00:00:00Z")
                .update();
        login("dis_idle");                       // 가입만 — 경기 0

        ResponseEntity<Map> res = authGet("/api/rankings?limit=100", seedToken, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> board = (List<Map<String, Object>>) res.getBody().get("leaderboard");

        // 필터 off → 예전처럼 전원 노출.
        assertThat(board.stream().map(e -> e.get("userId")).toList())
                .contains(userIdOf("dis_idle"));
    }

    /** off 여도 자격 필드는 계약상 존재하고, 이때는 전원 자격자로 본다. */
    @SuppressWarnings("unchecked")
    @Test
    void disabledSwitchReportsEveryoneEligible() {
        String token = login("dis_fresh");

        ResponseEntity<Map> res = authGet("/api/rankings?limit=100", token, Map.class);
        Map<String, Object> me = (Map<String, Object>) res.getBody().get("me");

        assertThat(me.get("eligible")).isEqualTo(true);
        assertThat(((Number) me.get("rank")).intValue()).isGreaterThan(0);
    }
}
