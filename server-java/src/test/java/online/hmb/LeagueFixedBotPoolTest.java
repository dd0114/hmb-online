package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.league.LeagueService;
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
 * 리그 봇 팀 = <b>디비전별 고정 카탈로그</b> (#402 W2 AC5·AC6).
 *
 * <p><b>왜</b>(라이브 실측): 봇 팀 파생이 {@code seasonId}·시즌 seed 를 재료로 써서
 * ({@code teamId = seasonId + "-T" + i}, 로스터 rng = {@code seed + ":team:" + teamId})
 * <b>유저·시즌마다 상대 9팀이 전부 고유</b>했다 — {@code bots} 의 {@code kind='league'} 63행이
 * (포메이션+선발11) 조합 63개, 유저 간 중복 0. 봇 A(AI 인풋)는 덱 해시가 곧 id 라 아무도 남의
 * A 를 물려받지 못하고 매 라운드 풀생성(19~107초)을 했다. 더블 라운드로빈이라 <b>두 번째 만남만</b>
 * 캐시에 맞았다.
 *
 * <p><b>계약</b>: 봇 팀은 {@code (division, index)} 결정론이다. 같은 디비전의 모든 유저가 같은 9팀을
 * 만난다(hero 결정) → 첫 유저가 만든 A 를 그 뒤 전원이 재사용한다.
 *
 * <p>⚠️ <b>시즌 seed 는 계속 랜덤이어야 한다</b>. 고정되는 건 <b>봇 팀 구성만</b>이고, 시즌 seed 는
 * {@code botMatchResult}(봇전 간이결과) 등 다른 파생이 쓴다 — 같이 고정하면 시즌마다 리그 결과가
 * 똑같아진다. 그 분리를 {@link #seasonSeedStaysRandomEvenThoughBotTeamsAreFixed} 가 지킨다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueFixedBotPoolTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        TestDbSupport.disableMatchClock(registry);
        // 실 발행물 — 디비전 사다리가 있어야 "디비전별 고정 풀"이 관측된다.
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
    private LeagueService leagueService;

    @jakarta.annotation.Resource
    private FakeServants fakeServants;

    // ── AC5: 같은 디비전 = 같은 9팀 ──────────────────────────────────────

    @Test
    void twoUsersInTheSameDivisionMeetTheSameNineTeams() {
        String seasonA = seasonFor("fx-same-a", 6);
        String seasonB = seasonFor("fx-same-b", 6);

        assertThat(seasonA).isNotEqualTo(seasonB);
        assertThat(seedOf(seasonA))
                .as("시즌 seed 는 여전히 유저마다 다르다 — 팀이 같아지는 건 seed 때문이 아니다")
                .isNotEqualTo(seedOf(seasonB));

        List<String> a = botTeamFingerprints(seasonA);
        List<String> b = botTeamFingerprints(seasonB);
        assertThat(a).as("봇 9팀").hasSize(9);
        assertThat(a)
                .as("같은 디비전의 두 유저는 같은 teamId·클럽명·로스터·포메이션의 9팀을 만난다")
                .isEqualTo(b);
    }

    @Test
    void botTeamIdsDoNotCarryTheSeasonId() {
        // 시즌 id 가 id 재료에 섞여 있는 한, 같은 유저의 다음 시즌조차 상대가 전부 새 팀이 된다
        // (= A 캐시가 영원히 비어 있다). id 는 시즌 비의존이어야 한다.
        String season1 = seasonFor("fx-noseason", 4);
        for (String teamId : botTeamIdsOf(season1)) {
            assertThat(teamId).as("teamId 에 seasonId 가 없다").doesNotContain(season1);
        }
        // 같은 유저가 시즌을 하나 더 하면(같은 디비전) 상대도 같다 — hero 결정의 귀결이다.
        finishSeason(season1);
        String season2 = seasonFor("fx-noseason", 4);
        assertThat(season2).isNotEqualTo(season1);
        assertThat(botTeamFingerprints(season2)).isEqualTo(botTeamFingerprints(season1));
    }

    @Test
    void eachDivisionHasItsOwnFixedPool() {
        // 강도는 디비전 스펙(strength_mul·gradeSlots)을 따른다 — 그래서 고정 풀은 **디비전별**이다.
        Set<String> d3 = new LinkedHashSet<>(botTeamIdsOf(seasonFor("fx-div3", 3)));
        Set<String> d9 = new LinkedHashSet<>(botTeamIdsOf(seasonFor("fx-div9", 9)));
        assertThat(d3).hasSize(9);
        assertThat(d9).hasSize(9);
        assertThat(d3).as("디비전이 다르면 상대 풀도 다르다").doesNotContainAnyElementsOf(d9);
    }

    @Test
    void seasonSeedStaysRandomEvenThoughBotTeamsAreFixed() {
        // ⚠️ 고정하는 건 봇 팀 구성뿐이다. 시즌 seed 까지 고정하면 봇전 간이결과가 시즌마다 같아져
        // 리그가 매번 같은 표로 끝난다. 두 시즌의 seed 로 **같은 픽스처 id·같은 파워**를 계산해
        // 결과열이 갈라지는지 본다(픽스처 id 차이가 아니라 seed 차이만 보게 고정한다).
        String seedA = seedOf(seasonFor("fx-seed-a", 5));
        String seedB = seedOf(seasonFor("fx-seed-b", 5));
        assertThat(seedA).isNotEqualTo(seedB);

        boolean diverged = false;
        for (int i = 0; i < 30; i++) {
            String fixtureId = "PROBE-" + i;
            LeagueService.BotScore x = leagueService.botMatchResult(seedA, fixtureId, 6000, 5800);
            LeagueService.BotScore y = leagueService.botMatchResult(seedB, fixtureId, 6000, 5800);
            if (x.home() != y.home() || x.away() != y.away()) {
                diverged = true;
                break;
            }
        }
        assertThat(diverged)
                .as("시즌 seed 가 살아 있어야 시즌마다 리그 결과가 달라진다")
                .isTrue();
    }

    // ── AC6: 고정 봇 삽입은 멱등, 남의 경기를 덮지 않는다 ─────────────────

    @Test
    void aSecondUsersSeasonStartMakesNoNewAiJobs() {
        String seasonA = seasonFor("fx-idem-a", 8);
        List<String> botIds = botTeamIdsOf(seasonA);
        List<String> before = aiJobIds();
        assertThat(before).as("첫 시즌 시작이 그 디비전 봇 A 를 큐에 세웠다").isNotEmpty();
        fakeServants.drain();

        String seasonB = seasonFor("fx-idem-b", 8);
        assertThat(botTeamIdsOf(seasonB)).isEqualTo(botIds);
        assertThat(aiJobIds())
                .as("두 번째 유저의 시즌 생성은 새 AI 잡을 하나도 만들지 않는다(전부 이미 존재)")
                .isEqualTo(before);
    }

    @Test
    void anotherUsersSeasonStartNeverRewritesAnExistingBotRow() {
        // 고정 id 는 두 유저가 **같은 bots 행**을 가리킨다는 뜻이다. 갱신 upsert 면 B 의 시즌 생성이
        // A 의 **진행 중 경기 상대 덱**을 바꾼다 — 시뮬은 하프마다 봇 덱을 다시 읽으므로 전·후반
        // 사이에 상대가 바뀌고 재현이 깨진다. AwayService.bakeGhost 가 같은 이유로 DO NOTHING 이다.
        //
        // 재계산은 결정론이라 바이트가 같아서 덮어써도 티가 안 난다 → 카탈로그가 바뀌어 산출이
        // 달라진 상태를 **그 행에 표식을 남겨** 대역한다. 표식이 살아남으면 남의 경기도 살아남는다.
        String seasonA = seasonFor("fx-nooverwrite-a", 2);
        String botId = botTeamIdsOf(seasonA).get(0);
        String marked = "{\"formation\":\"MARK\",\"starters\":[],\"bench\":[]}";
        jdbcClient.sql("UPDATE bots SET deck_json = ?, name = ? WHERE id = ?")
                .params(marked, "진행중인 남의 상대", botId).update();

        seasonFor("fx-nooverwrite-b", 2);

        assertThat(deckJsonOf(botId))
                .as("남이 시즌을 시작해도 이미 있는 봇 행은 그대로다")
                .isEqualTo(marked);
        assertThat(nameOf(botId)).isEqualTo("진행중인 남의 상대");
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private String seasonFor(String nickname, int division) {
        String token = tokenOf(nickname);
        jdbcClient.sql("UPDATE users SET division = ? WHERE id = ?")
                .params(division, userIdOf(nickname)).update();
        return startSeason(token);
    }

    private String tokenOf(String nickname) {
        boolean exists = jdbcClient.sql("SELECT COUNT(*) FROM users WHERE nickname = ?")
                .param(nickname).query(Long.class).single() > 0;
        return exists ? login(nickname) : setupUserWithDeck(nickname);
    }

    @SuppressWarnings("unchecked")
    private String startSeason(String token) {
        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) ((Map<String, Object>) res.getBody().get("season")).get("id");
    }

    /** 시즌을 FINISHED 로 만들어 다음 시즌을 시작할 수 있게 한다(순위·보상 경로는 이 테스트 밖). */
    private void finishSeason(String seasonId) {
        jdbcClient.sql("UPDATE league_seasons SET state = 'FINISHED' WHERE id = ?")
                .param(seasonId).update();
    }

    private List<String> botTeamIdsOf(String seasonId) {
        List<String> ids = new ArrayList<>();
        for (JsonNode t : teamsJson(seasonId)) {
            if (!t.path("isUser").asBoolean()) {
                ids.add(t.path("teamId").asText());
            }
        }
        return ids;
    }

    /** 팀 하나의 관측 가능한 전부 — id·클럽명·페르소나·포메이션·파워·로스터. */
    private List<String> botTeamFingerprints(String seasonId) {
        List<String> out = new ArrayList<>();
        for (JsonNode t : teamsJson(seasonId)) {
            if (t.path("isUser").asBoolean()) {
                continue;
            }
            List<String> roster = new ArrayList<>();
            t.path("rosterPlayerIds").forEach(n -> roster.add(n.asText()));
            out.add(String.join("|", t.path("teamId").asText(), t.path("name").asText(),
                    t.path("persona").asText(""), t.path("formation").asText(""),
                    String.valueOf(t.path("power").asInt()), String.join(",", roster)));
        }
        return out;
    }

    private JsonNode teamsJson(String seasonId) {
        String json = jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
        try {
            return new ObjectMapper().readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private String seedOf(String seasonId) {
        return jdbcClient.sql("SELECT seed FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
    }

    private List<String> aiJobIds() {
        return jdbcClient.sql("SELECT id FROM ai_jobs ORDER BY id").query(String.class).list();
    }

    private String deckJsonOf(String botId) {
        return jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();
    }

    private String nameOf(String botId) {
        return jdbcClient.sql("SELECT name FROM bots WHERE id = ?")
                .param(botId).query(String.class).single();
    }
}
