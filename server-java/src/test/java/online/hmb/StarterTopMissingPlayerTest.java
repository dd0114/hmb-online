package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * <b>최후 방어선</b>: 유효 economy 가 카탈로그에 없는 최상위 id 를 가리켜도 <b>가입은 성공</b>한다
 * (#209 B안 독립검증 BL-2 후속).
 *
 * <p>운영 API 는 그런 설정을 400 으로 막지만, 그 앞단을 거치지 않는 경로가 남는다 — 볼륨에 손으로
 * 놓인 파일을 <b>부팅이 관대하게 싣는</b> 경우다(부팅까지 엄격하게 만들면 파일 하나로 서버가 못 뜬다).
 * 그 상태에서 지급 로직이 그대로 INSERT 하면 {@code user_players.player_id} FK 로 <b>가입 트랜잭션이
 * 통째로 죽어</b> 신규 유저가 아무도 못 들어온다. 그래서 지급은 카탈로그를 확인하고 없으면 건너뛴다 —
 * <b>최상위 한 장 누락이 서비스 중단보다 낫다.</b>
 *
 * <p>이 클래스는 오염된 economy 를 <b>부팅 시점부터</b> 물린 별도 컨텍스트다(프로덕션에 테스트용
 * 훅을 남기지 않기 위해서다 — 그런 훅은 언젠가 운영 경로에서 호출된다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class StarterTopMissingPlayerTest extends ApiTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // starterTop.pool 이 전부 카탈로그에 없는 id 인 economy(그 외 블록은 정상 픽스처와 동일).
        registry.add("hmb.data.economy-file",
                () -> "src/test/resources/fixtures/economy-missing-top.v1.json");
    }

    @Resource
    private JdbcClient jdbcClient;

    @Test
    void signupSucceedsAndSilentlySkipsTheUnknownTopUnit() {
        String token = login("missing_top_user");

        // 가입 자체가 성립한다(FK 로 트랜잭션이 죽지 않는다).
        assertThat(authGet("/api/me", token, Map.class).getStatusCode()).isEqualTo(HttpStatus.OK);

        // 기본팩 14장은 정상 지급되고, 최상위만 조용히 빠진다.
        assertThat(ownedCount("missing_top_user")).isEqualTo(14L);
        assertThat(grantCount("missing_top_user")).isZero();

        // 포인트·원장은 평소와 같다(지급 경로의 나머지가 멀쩡하다).
        long points = jdbcClient.sql("""
                        SELECT w.points FROM wallets w JOIN users u ON u.id = w.user_id WHERE u.nickname = ?
                        """)
                .param("missing_top_user").query(Long.class).single();
        assertThat(points).isEqualTo(3000L);
    }

    @Test
    void tutorialStillGrantsAPlayableDeckWithoutTheTopUnit() {
        String token = login("missing_top_deck");

        assertThat(authPost("/api/me/tutorial-complete", token, Map.of(), Map.class).getStatusCode())
                .isEqualTo(HttpStatus.OK);

        // 기본팩 14명만으로도 선발 11 + 벤치가 나온다 — 최상위가 없다고 덱 지급이 막히지 않는다.
        Map<?, ?> deck = authGet("/api/deck", token, Map.class).getBody();
        long starters = ((java.util.List<?>) deck.get("slots")).stream()
                .filter(s -> "starter".equals(((Map<?, ?>) s).get("role")))
                .count();
        assertThat(starters).isEqualTo(11L);
    }

    private long ownedCount(String nickname) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM user_players up JOIN users u ON u.id = up.user_id
                        WHERE u.nickname = ?
                        """)
                .param(nickname).query(Long.class).single();
    }

    private long grantCount(String nickname) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM starter_grants g JOIN users u ON u.id = g.user_id
                        WHERE u.nickname = ?
                        """)
                .param(nickname).query(Long.class).single();
    }
}
