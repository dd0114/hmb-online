package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import online.hmb.match.BotService;
import online.hmb.match.PromptContextBuilder;
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
 * 시즌 시작이 그 디비전 봇 9팀의 A(베이스 인풋)를 전부 큐에 세운다 — #402 W2 AC7.
 *
 * <p><b>왜</b>: 리그는 더블 라운드로빈이라 상대 9팀을 각각 두 번 만난다. A 를 매치 생성 때만
 * 예열하면 <b>첫 만남 9번은 전부 풀생성</b>(라이브 19~107초)이고 두 번째 만남만 캐시에 맞는다.
 * 시즌이 만들어지는 순간 상대는 이미 전부 정해져 있으므로, 그 자리에서 9팀을 한꺼번에 예열하면
 * 유저가 첫 경기를 시작할 때쯤 전부 준비돼 있다.
 *
 * <p><b>어디서</b>: 시즌 생성 트랜잭션 <b>바깥</b>(커밋 이후 = 컨트롤러). 선실행은 최적화지 정합성
 * 경로가 아니다 — 큐잉이 실패해도 시즌 생성이 깨지면 안 된다.
 *
 * <p>AC5(고정 풀)와 짝이다: 팀이 유저마다 고유하면 여기서 예열한 A 를 아무도 물려받지 못한다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueBasePrefetchTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.players-file", () -> "../data/players/players.v2.3.json");
        registry.add("hmb.data.league-file", () -> "../data/players/league.v2.json");
        registry.add("hmb.data.bots-file", () -> "../data/players/bots.v3.json");
        registry.add("hmb.servant.engine-runner-url", RUNNER::url);
    }

    @AfterAll
    static void stopRunner() {
        RUNNER.stop();
    }

    @jakarta.annotation.Resource
    private FakeServants fakeServants;

    @jakarta.annotation.Resource
    private PromptContextBuilder contextBuilder;

    @jakarta.annotation.Resource
    private BotService botService;

    // ── ① 시즌 시작 = 상대 9팀 A 전부 큐잉 ──────────────────────────────

    @Test
    void startingASeasonQueuesTheBaseInputOfEveryOpponent() {
        String token = setupUserWithDeck("lgpf_start");
        String seasonId = startSeason(token);

        List<String> botIds = botTeamIdsOf(seasonId);
        assertThat(botIds).as("상대 9팀").hasSize(9);
        for (String botId : botIds) {
            assertThat(baseExists(baseIdOf(botId)))
                    .as("%s 의 A 가 시즌 시작 시점에 이미 큐에 있어야 한다 — 없으면 첫 만남이 풀생성", botId)
                    .isTrue();
        }
    }

    @Test
    void startingASeasonTwiceQueuesNothingNew() {
        // 멱등: 이미 ACTIVE 인 시즌에 다시 들어와도(재입장·새로고침) 새 잡은 생기지 않는다.
        String token = setupUserWithDeck("lgpf_idem");
        startSeason(token);
        List<String> after = jdbcClient.sql("SELECT id FROM ai_jobs ORDER BY id").query(String.class).list();
        startSeason(token);
        assertThat(jdbcClient.sql("SELECT id FROM ai_jobs ORDER BY id").query(String.class).list())
                .isEqualTo(after);
    }

    // ── ② 킥오프에서 상대 사이드가 콜 0 ─────────────────────────────────

    /**
     * AC5 + AC7 의 결합 결과 = <b>리그 경기 킥오프 시 상대 사이드가 {@code materialized}</b>.
     * 시즌 시작 때 예열된 A 가 done 이면 첫 만남부터 AI 콜 없이 시작한다.
     */
    @Test
    void leagueKickoffReusesThePrequeuedOpponentInputWithZeroCalls() {
        String token = setupUserWithDeck("lgpf_reuse");
        startSeason(token);
        assertThat(fakeServants.drain()).as("유저 A + 봇 9팀 A 가 준비된 상태").isGreaterThanOrEqualTo(9);

        ResponseEntity<Map> next = authPost("/api/league/next-match", token, Map.of(), Map.class);
        assertThat(next.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) ((Map<?, ?>) next.getBody().get("match")).get("id");

        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);

        String botSide = botSideOf(matchId);
        assertThat(h1JobKind(matchId, botSide))
                .as("상대(리그 봇) 사이드 = 시즌 시작 때 만들어 둔 인풋 재사용(콜 0)")
                .isEqualTo("materialized");
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private String startSeason(String token) {
        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) ((Map<String, Object>) res.getBody().get("season")).get("id");
    }

    private List<String> botTeamIdsOf(String seasonId) {
        String json = jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
        List<String> ids = new ArrayList<>();
        try {
            for (JsonNode t : new ObjectMapper().readTree(json)) {
                if (!t.path("isUser").asBoolean()) {
                    ids.add(t.path("teamId").asText());
                }
            }
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
        return ids;
    }

    /**
     * 봇 A 의 id. <b>매치를 넘기지 않는다</b> — A 는 매치에 매이지 않는다({@code userBaseJob} 주석과
     * 같은 성질: 재료는 덱뿐이다). 그래서 시즌 시작처럼 매치가 없는 자리에서도 킥오프가 찾을 것과
     * 같은 id 를 만들 수 있고, 그게 이 AC 가 성립하는 이유다.
     */
    private String baseIdOf(String botId) {
        return contextBuilder.botBaseJob(null, botService.get(botId)).baseId();
    }

    private boolean baseExists(String baseId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM ai_jobs WHERE id = ? AND match_id IS NULL")
                .param(baseId).query(Long.class).single() > 0;
    }

    /** 엔진 사이드 = 픽스처 home/away 계약 — 유저가 홈이면 봇은 away. */
    private String botSideOf(String matchId) {
        String homeTeam = jdbcClient.sql("""
                        SELECT f.home_team FROM league_fixtures f
                        JOIN matches m ON m.league_fixture_id = f.id WHERE m.id = ?
                        """)
                .param(matchId).query(String.class).single();
        return online.hmb.league.LeagueService.USER_TEAM_ID.equals(homeTeam) ? "away" : "home";
    }

    private String h1JobKind(String matchId, String side) {
        String json = jdbcClient.sql("""
                        SELECT context_json FROM ai_jobs
                        WHERE match_id = ? AND half = 1 AND side = ? AND effective = 1
                        """)
                .params(matchId, side).query(String.class).single();
        return contextBuilder.readJson(json).path("kind").asText();
    }
}
