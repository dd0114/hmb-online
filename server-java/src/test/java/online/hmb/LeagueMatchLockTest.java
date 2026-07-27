package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.Map;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #217 × 리그 — 잠금이 리그 진입점({@code POST /api/league/next-match})과 만나는 세 지점.
 *
 * <p>여기가 미묘한 이유: 이 엔드포인트는 <b>생성이면서 재입장</b>이다. 픽스처에 이미 매치가 붙어
 * 있으면 그걸 돌려주고(재입장 → 잠그면 안 된다), 없으면 새로 만든다(생성 → 잠가야 한다).
 * 그리고 회수(ABANDONED)가 들어오면서 "FINISHED 가 아니면 재사용"이라는 옛 조건은
 * <b>죽은 매치를 영원히 되돌려주는 픽스처 영구 잠금</b>이 됐다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueMatchLockTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
        registry.add("hmb.match.abandon.sweep-interval-ms", () -> "3600000");
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    /** 같은 픽스처를 다시 요청하는 건 재입장이다 — 여기서 409 를 내면 리그를 시작할 수 없다. */
    @Test
    void requestingTheSameFixtureTwiceReturnsTheSameMatch() {
        String token = setupUserWithDeck("lg_lock_reuse");
        authPost("/api/league/start", token, null, Map.class);

        ResponseEntity<Map> first = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(first.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) ((Map<?, ?>) first.getBody().get("match")).get("id");

        ResponseEntity<Map> again = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        assertThat(((Map<?, ?>) again.getBody().get("match")).get("id")).isEqualTo(matchId);
    }

    /** 연습 경기 중에 리그를 새로 여는 건 매치 2개 동시 진행이다 — 막는다. */
    @Test
    @SuppressWarnings("unchecked")
    void startingALeagueMatchIsBlockedWhileAPracticeMatchIsUnfinished() {
        String token = setupUserWithDeck("lg_lock_practice");
        authPost("/api/league/start", token, null, Map.class);
        String practiceId = createMatch(token, null);

        ResponseEntity<Map> res = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CONFLICT);
        assertThat(res.getBody().get("code")).isEqualTo("MATCH_IN_PROGRESS");
        assertThat(((Map<String, Object>) res.getBody().get("detail")).get("matchId")).isEqualTo(practiceId);
    }

    /**
     * <b>픽스처 영구 잠금 회귀 가드</b>: 회수한 리그 매치는 재사용 대상이 아니다. 옛 조건
     * ("FINISHED 가 아니면 재사용")이 남아 있으면 여기서 ABANDONED 매치가 그대로 돌아오고,
     * 유저는 그 라운드를 영영 치를 수 없다.
     */
    @Test
    void abandoningALeagueMatchFreesTheFixtureForAFreshOne() {
        String token = setupUserWithDeck("lg_lock_abandon");
        authPost("/api/league/start", token, null, Map.class);

        ResponseEntity<Map> first = authPost("/api/league/next-match", token, null, Map.class);
        String matchId = (String) ((Map<?, ?>) first.getBody().get("match")).get("id");
        String fixtureId = (String) ((Map<?, ?>) first.getBody().get("fixture")).get("id");

        assertThat(authPost("/api/matches/" + matchId + "/abandon", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        ResponseEntity<Map> again = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(again.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Map<?, ?> match = (Map<?, ?>) again.getBody().get("match");
        assertThat(match.get("id")).as("죽은 매치를 되돌려주면 그 라운드가 영구히 잠긴다").isNotEqualTo(matchId);
        assertThat(match.get("mode")).isEqualTo("league");
        // 같은(아직 안 치른) 픽스처로 다시 연결된다 — 라운드를 건너뛰지 않는다.
        assertThat(((Map<?, ?>) again.getBody().get("fixture")).get("id")).isEqualTo(fixtureId);
    }
}
