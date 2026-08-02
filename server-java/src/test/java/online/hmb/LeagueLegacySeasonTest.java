package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
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
 * 진행 중인 <b>구 시즌</b>은 손대지 않는다 — #402 W2 AC8 (hero 확정 Q1: 새 시즌부터 고정 풀).
 *
 * <p>구 시즌의 봇 팀 id 는 {@code {seasonId}-T{i}} 이고 그 {@code bots} 행은 고정 풀 밖에 있다.
 * 배포 순간 라이브에는 그런 시즌이 굴러가고 있으므로, <b>새 id 규약이 옛 시즌을 잠그면 안 된다</b>:
 * 픽스처·순위·다음 경기·정산·강등 경로가 옛 id 위에서 그대로 돌아야 한다.
 *
 * <p>구 시즌은 <b>배포 전 코드가 만든 모양</b>을 그대로 재현한다 — 정상 시즌을 하나 만든 뒤
 * teamId 를 옛 규약으로 되돌리고(teams_json · league_fixtures · bots 행 복제) 그 위에서 실제
 * API 로 한 경기를 완주시킨다. 새 코드가 옛 행을 무시하거나 덮으면 여기서 죽는다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueLegacySeasonTest extends MatchTestBase {

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
    private LeagueService leagueService;

    @jakarta.annotation.Resource
    private FakeServants fakeServants;

    @Test
    void anInFlightLegacySeasonKeepsPlayingOnItsOwnBotRows() {
        String token = setupUserWithDeck("lgcy_play");
        String seasonId = startSeason(token);
        List<String> legacyIds = rewriteToLegacyTeamIds(seasonId);

        // ① 조회가 성립한다 — 순위 10팀, 다음 유저 경기 존재.
        assertThat(leagueService.computeStandings(seasonId)).hasSize(10);
        JsonNode season = seasonDto(token);
        assertThat(season.path("id").asText()).isEqualTo(seasonId);
        assertThat(season.path("teams")).hasSize(10);
        assertThat(season.path("nextUserFixture").path("id").isMissingNode()).isFalse();

        // ② 다음 경기가 **옛 봇 행**을 상대로 만들어진다.
        ResponseEntity<Map> next = authPost("/api/league/next-match", token, Map.of(), Map.class);
        assertThat(next.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        String matchId = (String) ((Map<?, ?>) next.getBody().get("match")).get("id");
        String botId = jdbcClient.sql("SELECT bot_id FROM matches WHERE id = ?")
                .param(matchId).query(String.class).single();
        assertThat(legacyIds).as("상대는 그 시즌의 옛 봇 행이다").contains(botId);

        // ③ 풀 플로우 완주 + 픽스처 정산(같은 라운드 봇전 4경기 포함).
        assertThat(authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.ACCEPTED);
        fakeServants.drain();
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();

        assertThat(matchState(matchId)).isEqualTo("FINISHED");
        assertThat(playedCount(seasonId, 1)).as("라운드1 = 유저 1 + 봇전 4").isEqualTo(5L);
        assertThat(leagueService.computeStandings(seasonId)).hasSize(10);
    }

    @Test
    void aNewSeasonDoesNotDisturbAnInFlightLegacySeasonsBotRows() {
        // 다른 유저가 새 규약으로 시즌을 시작해도 구 시즌의 봇 행·픽스처는 그대로다.
        String token = setupUserWithDeck("lgcy_untouched");
        String seasonId = startSeason(token);
        List<String> legacyIds = rewriteToLegacyTeamIds(seasonId);
        List<String> decksBefore = decksOf(legacyIds);
        List<String> fixturesBefore = fixtureTeamsOf(seasonId);

        String other = setupUserWithDeck("lgcy_newcomer");
        startSeason(other);

        assertThat(decksOf(legacyIds)).as("옛 봇 행 무변경").isEqualTo(decksBefore);
        assertThat(fixtureTeamsOf(seasonId)).as("옛 픽스처 무변경").isEqualTo(fixturesBefore);
        assertThat(leagueService.computeStandings(seasonId)).hasSize(10);
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    @SuppressWarnings("unchecked")
    private String startSeason(String token) {
        ResponseEntity<Map> res = authPost("/api/league/start", token, Map.of(), Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        return (String) ((Map<String, Object>) res.getBody().get("season")).get("id");
    }

    /**
     * 이 시즌을 <b>배포 전 모양</b>으로 되돌린다: 봇 teamId 를 {@code {seasonId}-T{i}} 로 바꾸고
     * ({@code teams_json} · {@code league_fixtures}) 그 id 의 {@code bots} 행을 만들어 준다.
     * 고정 풀 행은 그대로 남겨 둔다 — 라이브에서도 두 세대가 같은 표에 공존한다.
     *
     * @return 옛 규약 봇 id 9개
     */
    private List<String> rewriteToLegacyTeamIds(String seasonId) {
        JsonNode teams = readJson(jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single());
        List<String> legacy = new ArrayList<>();
        int i = 0;
        for (JsonNode t : teams) {
            if (t.path("isUser").asBoolean()) {
                continue;
            }
            i++;
            String from = t.path("teamId").asText();
            String to = seasonId + "-T" + i;
            legacy.add(to);
            if (to.equals(from)) {
                continue; // 아직 옛 규약인 코드(픽스 전) — 되돌릴 것이 없다.
            }
            ((ObjectNode) t).put("teamId", to);
            jdbcClient.sql("""
                            INSERT INTO bots(id, name, persona, analysis_text, deck_json, kind, strength_mul)
                            SELECT ?, name, persona, analysis_text, deck_json, kind, strength_mul
                            FROM bots WHERE id = ?
                            """)
                    .params(to, from).update();
            jdbcClient.sql("UPDATE league_fixtures SET home_team = ? WHERE season_id = ? AND home_team = ?")
                    .params(to, seasonId, from).update();
            jdbcClient.sql("UPDATE league_fixtures SET away_team = ? WHERE season_id = ? AND away_team = ?")
                    .params(to, seasonId, from).update();
        }
        jdbcClient.sql("UPDATE league_seasons SET teams_json = ? WHERE id = ?")
                .params(teams.toString(), seasonId).update();
        assertThat(legacy).hasSize(9);
        return legacy;
    }

    private List<String> decksOf(List<String> botIds) {
        List<String> out = new ArrayList<>();
        for (String id : botIds) {
            out.add(jdbcClient.sql("SELECT name || '|' || deck_json FROM bots WHERE id = ?")
                    .param(id).query(String.class).single());
        }
        return out;
    }

    private List<String> fixtureTeamsOf(String seasonId) {
        return jdbcClient.sql("""
                        SELECT round || ':' || home_team || '-' || away_team FROM league_fixtures
                        WHERE season_id = ? ORDER BY id
                        """)
                .param(seasonId).query(String.class).list();
    }

    private long playedCount(String seasonId, int round) {
        return jdbcClient.sql("""
                        SELECT COUNT(*) FROM league_fixtures
                        WHERE season_id = ? AND round = ? AND state = 'PLAYED'
                        """)
                .params(seasonId, round).query(Long.class).single();
    }

    private JsonNode seasonDto(String token) {
        return readJson(authGet("/api/league", token, String.class).getBody()).path("season");
    }

    private JsonNode readJson(String json) {
        try {
            return new ObjectMapper().readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}
