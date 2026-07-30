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
 * #322 — {@code MatchDetail} 이 <b>사이드 기준</b> 팀 이름을 준다.
 *
 * <p>왜 필요한가: 엔진 사이드 배치는 <b>픽스처 {@code home_team}</b> 이 정하고
 * ({@link online.hmb.match.MatchOrchestrator} — 리그 어웨이 라운드는 유저가 away),
 * 스코어 컬럼·이벤트 {@code team}·뷰어 렌더가 전부 그 축이다. 그런데 클라가 오리엔트할 수단이
 * {@code ownerName}(= "매치를 만든 유저") 뿐이라 web 이 {@code homeName = ownerName} 을 박았고,
 * 어웨이 라운드 화면이 통째로 뒤집혔다(스코어·로그 팀 라벨·좌우). 라이브 리그 20경기 중 7건.
 *
 * <p>고칠 자리가 <b>서버</b>인 이유: 불리언({@code userWasHome}) 하나만 주면 클라가 이름을 다시
 * 배치해야 하고, 그 해석이 관전자 경로(#245 — 홈이 공격자다)에서 또 갈린다. 이름을 <b>배치해서</b>
 * 보내면 소비자가 추론할 것이 남지 않는다.
 *
 * <p>⚠️ 계약이 <b>어웨이 픽스처 표본</b>을 태우는 것이 핵심이다. 기존 매치 테스트는 전부
 * 유저=홈이라 이 결함을 <b>구조적으로</b> 관측할 수 없었다(그래서 2026-07-19 도입 후 계속 살았다).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class MatchSideNamesTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    /** 연습 경기 = 리그 픽스처가 없다 → 유저가 항상 홈. 여기서 값이 바뀌면 전 화면이 회귀한다. */
    @Test
    void practiceMatchPutsTheUserOnTheHomeSide() {
        String nickname = "side_practice";
        String token = setupUserWithDeck(nickname);
        String matchId = createMatch(token, "BOT_BAL");

        Map<?, ?> detail = getMatch(token, matchId);
        assertThat(detail.get("homeName")).isEqualTo(nickname);
        assertThat(detail.get("awayName")).isEqualTo(botNameOf(matchId));
        // ownerName 은 그대로 — "누구 매치냐"는 사이드와 별개 축이다(#245 관전 경로가 쓴다).
        assertThat(detail.get("ownerName")).isEqualTo(nickname);
    }

    /**
     * <b>이 이슈의 표본.</b> 픽스처에서 유저가 away 면 {@code homeName} 은 <b>봇</b>이다.
     *
     * <p>어웨이 라운드를 만드는 방법: 리그를 시작해 유저 경기를 하나 받고, 그 픽스처의 사이드를
     * 뒤집는다. 실제 일정도 절반이 이 모양이고(더블 라운드로빈), 서버가 읽는 바로 그 컬럼을
     * 세팅하는 것이라 우회가 아니다 — 규칙 자체({@code 엔진 home = 픽스처 home_team})를 태운다.
     */
    @Test
    void awayLeagueFixturePutsTheBotOnTheHomeSide() {
        String nickname = "side_away";
        String token = setupUserWithDeck(nickname);
        authPost("/api/league/start", token, null, Map.class);

        ResponseEntity<Map> created = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(created.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) ((Map<?, ?>) created.getBody().get("match")).get("id");
        String botName = botNameOf(matchId);

        // 먼저 유저 홈 라운드에서 값을 확인해 둔다 — 뒤집힘이 "원래 그랬다"가 아님을 못 박는다.
        Map<?, ?> asHome = getMatch(token, matchId);
        assertThat(asHome.get("homeName")).isEqualTo(nickname);
        assertThat(asHome.get("awayName")).isEqualTo(botName);

        swapFixtureSides(matchId);

        Map<?, ?> asAway = getMatch(token, matchId);
        assertThat(asAway.get("homeName")).as("어웨이 라운드의 홈은 봇이다").isEqualTo(botName);
        assertThat(asAway.get("awayName")).as("어웨이 라운드의 어웨이가 유저다").isEqualTo(nickname);
        // ⚠️ ownerName 은 **안 뒤집힌다** — 사이드가 아니라 소유자다. 이 둘이 같은 값이라고
        //    믿은 것이 #322 의 뿌리다.
        assertThat(asAway.get("ownerName")).isEqualTo(nickname);
    }

    /** 픽스처의 home/away 를 맞바꾼다 — 서버가 {@code userIsHome} 판정에 읽는 바로 그 컬럼. */
    private void swapFixtureSides(String matchId) {
        int updated = jdbcClient.sql("""
                        UPDATE league_fixtures
                           SET home_team = away_team, away_team = home_team
                         WHERE id = (SELECT league_fixture_id FROM matches WHERE id = ?)
                        """)
                .param(matchId)
                .update();
        assertThat(updated).as("픽스처를 못 찾으면 이 테스트는 아무것도 재지 않는다").isEqualTo(1);
    }

    private Map<?, ?> getMatch(String token, String matchId) {
        ResponseEntity<Map> res = authGet("/api/matches/" + matchId, token, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return res.getBody();
    }

    private String botNameOf(String matchId) {
        return jdbcClient.sql("SELECT b.name FROM bots b JOIN matches m ON m.bot_id = b.id WHERE m.id = ?")
                .param(matchId).query(String.class).single();
    }
}
