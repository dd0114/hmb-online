package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.ArrayList;
import java.util.HashSet;
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
 * AC-F1~F5 리그 (LLD-p2-server §6). 일정(서클 메서드 더블 라운드로빈)·순위 타이브레이커·봇전 간이결과
 * 결정론·시즌 라이프사이클·홈어웨이 반영·mode=league 격리를 검증한다. 규칙 고증 = league-rules.md.
 *
 * <p>봇 로스터는 시드로 실선수 풀에서 샘플(테스트 카탈로그 17명, 팀 간 공유 허용) — 결정론은 저장 seed
 * 재계산 일치로 증명한다. 유저 매치는 가짜 서번트/러너로 풀 플로우를 돌린다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class LeagueApiTest extends MatchTestBase {

    static final FakeEngineRunner RUNNER = new FakeEngineRunner();

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // 이 테스트의 주제는 시계가 아니다 — 레거시(즉시 전개) 흐름으로 고정한다(§7.7 롤백 경로).
        TestDbSupport.disableMatchClock(registry);
        registry.add("hmb.data.league-file", () -> "../data/players/league.v1.json");
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

    // ── 일정: 서클 메서드 더블 라운드로빈 (AC-F1) ─────────────────────────

    @Test
    void circleMethodProducesBalancedDoubleRoundRobin() {
        // 순수 알고리즘: 10팀 단일 RR = 9라운드, 라운드당 5쌍, 각 팀 라운드당 1경기.
        List<List<int[]>> rounds = LeagueService.circleMethod(10);
        assertThat(rounds).hasSize(9);
        Set<String> allPairs = new HashSet<>();
        for (List<int[]> round : rounds) {
            assertThat(round).hasSize(5);
            Set<Integer> seen = new HashSet<>();
            for (int[] p : round) {
                assertThat(seen.add(p[0])).isTrue();
                assertThat(seen.add(p[1])).isTrue();
                allPairs.add(p[0] + "-" + p[1]);
            }
            assertThat(seen).hasSize(10); // 모든 팀 정확히 1회
        }
        // 단일 RR: 45개 무순서쌍 전부 등장(방향 무관 유일).
        Set<String> unordered = new HashSet<>();
        for (String pair : allPairs) {
            String[] ab = pair.split("-");
            int a = Integer.parseInt(ab[0]);
            int b = Integer.parseInt(ab[1]);
            unordered.add(Math.min(a, b) + ":" + Math.max(a, b));
        }
        assertThat(unordered).hasSize(45);
    }

    @Test
    void seasonScheduleIs18RoundsWithHomeAwaySymmetry() {
        String token = setupUserWithDeck("lg_sched");
        String uid = userIdOf("lg_sched");
        ResponseEntity<Map> start = authPost("/api/league/start", token, null, Map.class);
        assertThat(start.getStatusCode()).isEqualTo(HttpStatus.OK);
        String seasonId = seasonId(uid);

        // 90 픽스처, 18라운드, 라운드당 5경기.
        List<Map<String, Object>> fx = fixtureRows(seasonId);
        assertThat(fx).hasSize(90);
        Set<Integer> roundNos = new HashSet<>();
        Map<Integer, Integer> perRound = new java.util.HashMap<>();
        Map<Integer, Set<String>> teamsPerRound = new java.util.HashMap<>();
        Set<String> orderedPairs = new HashSet<>();
        int userFixtures = 0;
        for (Map<String, Object> f : fx) {
            int round = ((Number) f.get("round")).intValue();
            String home = (String) f.get("home_team");
            String away = (String) f.get("away_team");
            roundNos.add(round);
            perRound.merge(round, 1, Integer::sum);
            teamsPerRound.computeIfAbsent(round, k -> new HashSet<>()).add(home);
            teamsPerRound.get(round).add(away);
            assertThat(orderedPairs.add(home + "->" + away)).as("각 순서쌍 1회").isTrue();
            if ("USER".equals(home) || "USER".equals(away)) {
                userFixtures++;
            }
        }
        assertThat(roundNos).hasSize(18);
        assertThat(perRound.values()).allMatch(c -> c == 5);
        assertThat(teamsPerRound.values()).allMatch(s -> s.size() == 10); // 라운드마다 전 팀 1경기
        assertThat(userFixtures).isEqualTo(18); // 유저 경기 18(라운드당 1)
        // 홈/어웨이 대칭: 각 무순서쌍이 정확히 2회(홈 1 + 어웨이 1) — 90/45.
        Map<String, Integer> unorderedCount = new java.util.HashMap<>();
        for (String op : orderedPairs) {
            String[] ab = op.split("->");
            String key = ab[0].compareTo(ab[1]) < 0 ? ab[0] + "|" + ab[1] : ab[1] + "|" + ab[0];
            unorderedCount.merge(key, 1, Integer::sum);
        }
        assertThat(unorderedCount).hasSize(45);
        assertThat(unorderedCount.values()).allMatch(c -> c == 2);
    }

    // ── 봇팀 구성 + 봇전 결과 결정론 (AC-F1/F2) ───────────────────────────

    @Test
    void botTeamsBuiltAndBotResultsAreSeedDeterministic() {
        String token = setupUserWithDeck("lg_det");
        String uid = userIdOf("lg_det");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        // teams_json: 유저 1 + 봇 9, 봇은 로스터·파워·고유 클럽명.
        JsonNode teams = readSeasonTeams(seasonId);
        assertThat(teams).hasSize(10);
        Set<String> clubNames = new HashSet<>();
        int bots = 0;
        for (JsonNode t : teams) {
            if (t.path("isUser").asBoolean()) {
                assertThat(t.path("teamId").asText()).isEqualTo("USER");
                continue;
            }
            bots++;
            assertThat(clubNames.add(t.path("name").asText())).as("클럽명 고유").isTrue();
            assertThat(t.path("rosterPlayerIds").size()).isEqualTo(15); // 선발 11 + 벤치 4
            assertThat(t.path("power").asInt()).isGreaterThan(0);
        }
        assertThat(bots).isEqualTo(9);

        // 봇 bots 행 삽입 확인(deck_json 선발 11, GK 슬롯0) — 매치 상대로 소비 가능.
        String botTeamId = seasonId + "-T1";
        String deckJson = jdbcClient.sql("SELECT deck_json FROM bots WHERE id = ?")
                .param(botTeamId).query(String.class).single();
        JsonNode deck = matchServiceReadJson(deckJson);
        assertThat(deck.path("starters").size()).isEqualTo(11);

        // 결정론: 라운드1 봇전을 생성한 뒤, 저장 스코어 == 저장 seed+fixtureId 재계산.
        leagueService.generateRoundBotResults(seasonId, 1);
        String seed = seasonSeed(seasonId);
        Map<String, Integer> powers = teamPowers(teams);
        List<Map<String, Object>> round1Bots = fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("round")).intValue() == 1
                        && ((Number) f.get("is_user")).intValue() == 0)
                .toList();
        assertThat(round1Bots).hasSize(4); // 라운드당 봇전 4
        for (Map<String, Object> f : round1Bots) {
            assertThat(f.get("state")).isEqualTo("PLAYED");
            LeagueService.BotScore recomputed = leagueService.botMatchResult(seed, (String) f.get("id"),
                    powers.get((String) f.get("home_team")), powers.get((String) f.get("away_team")));
            assertThat(((Number) f.get("score_home")).intValue()).isEqualTo(recomputed.home());
            assertThat(((Number) f.get("score_away")).intValue()).isEqualTo(recomputed.away());
        }
    }

    @Test
    void expectedGoalsAppliesHomeAdvantageDirection() {
        // 파워 동일 → 홈 기대득점 > 어웨이(홈 어드밴티지 방향).
        double[] equal = leagueService.expectedGoals(500, 500);
        assertThat(equal[0]).isGreaterThan(equal[1]);
        // 홈이 훨씬 강하면 홈 기대득점이 더 커진다.
        double[] strongHome = leagueService.expectedGoals(800, 300);
        assertThat(strongHome[0]).isGreaterThan(equal[0]);
        assertThat(strongHome[1]).isLessThan(equal[1]);
        // 재현: 같은 인자 → 같은 스코어.
        LeagueService.BotScore a = leagueService.botMatchResult("seed-xyz", "FX1", 500, 400);
        LeagueService.BotScore b = leagueService.botMatchResult("seed-xyz", "FX1", 500, 400);
        assertThat(a).isEqualTo(b);
    }

    // ── 순위 타이브레이커 3단(동점 → 승자승) (AC-F3) ─────────────────────

    @Test
    void standingsTiebreakFallsThroughToHeadToHead() {
        String token = setupUserWithDeck("lg_tie");
        String uid = userIdOf("lg_tie");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        // 깨끗한 무대: 기존 SCHEDULED 픽스처 제거 후 통제된 PLAYED 픽스처만 삽입.
        jdbcClient.sql("DELETE FROM league_fixtures WHERE season_id = ?").param(seasonId).update();
        List<String> botIds = botTeamIds(seasonId);
        String a = botIds.get(0);
        String b = botIds.get(1);
        String d = botIds.get(2);
        String e = botIds.get(3);
        // A와 B를 승점3·골득실0·다득점3 로 동률, 맞대결에서 A가 B에 승 → A가 위.
        insertPlayed(seasonId, 1, a, b, 2, 1); // A win vs B (h2h A>B)
        insertPlayed(seasonId, 2, a, d, 1, 2); // A loss  → A: P3 gf3 ga3 gd0
        insertPlayed(seasonId, 3, b, e, 2, 1); // B win   → B: P3 gf3 ga3 gd0

        List<LeagueService.LeagueStanding> standings = leagueService.computeStandings(seasonId);
        LeagueService.LeagueStanding sa = standings.stream().filter(s -> s.teamId().equals(a)).findFirst().orElseThrow();
        LeagueService.LeagueStanding sb = standings.stream().filter(s -> s.teamId().equals(b)).findFirst().orElseThrow();
        // 3단 동률 확인 후 승자승으로 A가 B보다 위.
        assertThat(sa.points()).isEqualTo(sb.points()).isEqualTo(3);
        assertThat(sa.goalDiff()).isEqualTo(sb.goalDiff()).isEqualTo(0);
        assertThat(sa.goalsFor()).isEqualTo(sb.goalsFor()).isEqualTo(3);
        assertThat(sa.rank()).isLessThan(sb.rank());
    }

    // ── 어웨이 사이드 반영 (AC-F2, 홈/어웨이) ─────────────────────────────

    @Test
    void awayUserFixtureMapsUserGoalsToAwaySlot() {
        String token = setupUserWithDeck("lg_away");
        String uid = userIdOf("lg_away");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        // 유저가 어웨이인 픽스처(home_team != USER).
        Map<String, Object> awayFx = fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("is_user")).intValue() == 1 && !"USER".equals(f.get("home_team")))
                .findFirst().orElseThrow();
        String fixtureId = (String) awayFx.get("id");
        assertThat(leagueService.userIsHomeForFixture(fixtureId)).isFalse();

        // 엔진(=픽스처) 관점 home 3 : away 1 정산 → 유저(어웨이) 골=1, 실점=3 → 유저 패.
        leagueService.settleUserFixture(fixtureId, 3, 1);
        Map<String, Object> settled = fixtureById(fixtureId);
        assertThat(settled.get("state")).isEqualTo("PLAYED");
        assertThat(((Number) settled.get("score_home")).intValue()).isEqualTo(3);
        assertThat(((Number) settled.get("score_away")).intValue()).isEqualTo(1);

        LeagueService.LeagueStanding user = leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser).findFirst().orElseThrow();
        assertThat(user.goalsFor()).isEqualTo(1);       // 유저 득점 = away 슬롯
        assertThat(user.goalsAgainst()).isEqualTo(3);
        assertThat(user.lost()).isEqualTo(1);
        assertThat(user.points()).isEqualTo(0);
    }

    // ── 유저 매치 정산 → 같은 라운드 봇전 일괄 생성 (AC-F2) ───────────────

    @Test
    void settlingUserFixtureGeneratesThatRoundsBotResults() {
        String token = setupUserWithDeck("lg_settle");
        String uid = userIdOf("lg_settle");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        Map<String, Object> userFx = fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("is_user")).intValue() == 1)
                .min(java.util.Comparator.comparingInt(f -> ((Number) f.get("round")).intValue())).orElseThrow();
        int round = ((Number) userFx.get("round")).intValue();
        long scheduledBotsBefore = fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("round")).intValue() == round
                        && ((Number) f.get("is_user")).intValue() == 0
                        && f.get("state").equals("SCHEDULED"))
                .count();
        assertThat(scheduledBotsBefore).isEqualTo(4);

        leagueService.settleUserFixture((String) userFx.get("id"), 2, 0);

        long playedInRound = fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("round")).intValue() == round && f.get("state").equals("PLAYED"))
                .count();
        assertThat(playedInRound).isEqualTo(5); // 유저 1 + 봇전 4 전부 PLAYED
    }

    // ── 시즌 종료 → 보상 멱등 → 재시작 (AC-F4) ────────────────────────────

    @Test
    void seasonCompletesAwardsRewardIdempotentlyAndRestarts() {
        String token = setupUserWithDeck("lg_full");
        String uid = userIdOf("lg_full");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        // 유저가 전 경기 승리하도록 18개 유저 픽스처 정산(홈=3:0 / 어웨이=0:3) → 최종 1위.
        for (Map<String, Object> f : userFixturesOrdered(seasonId)) {
            boolean userHome = "USER".equals(f.get("home_team"));
            leagueService.settleUserFixture((String) f.get("id"), userHome ? 3 : 0, userHome ? 0 : 3);
        }

        // 시즌 FINISHED + 유저 1위 + 보상(rank1) 원장 1행.
        String state = jdbcClient.sql("SELECT state FROM league_seasons WHERE id = ?")
                .param(seasonId).query(String.class).single();
        assertThat(state).isEqualTo("FINISHED");
        LeagueService.LeagueStanding user = leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser).findFirst().orElseThrow();
        assertThat(user.rank()).isEqualTo(1);
        assertThat(user.won()).isEqualTo(18);

        long rewardRows = jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='league_reward' AND ref_id=?")
                .params(uid, seasonId).query(Long.class).single();
        assertThat(rewardRows).isEqualTo(1L);
        long rewardDelta = jdbcClient.sql(
                        "SELECT delta FROM point_ledger WHERE user_id=? AND reason='league_reward' AND ref_id=?")
                .params(uid, seasonId).query(Long.class).single();
        assertThat(rewardDelta).isEqualTo(RANK1_REWARD); // league.v1 rewards[rank=1]

        // 멱등: 이미 PLAYED 픽스처 재정산 → no-op(보상 원장 여전히 1행).
        leagueService.settleUserFixture((String) userFixturesOrdered(seasonId).get(0).get("id"), 3, 0);
        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='league_reward' AND ref_id=?")
                .params(uid, seasonId).query(Long.class).single()).isEqualTo(1L);

        // 재시작: season_no+1 새 ACTIVE 시즌.
        ResponseEntity<Map> restart = authPost("/api/league/start", token, null, Map.class);
        assertThat(restart.getStatusCode()).isEqualTo(HttpStatus.OK);
        int newSeasonNo = jdbcClient.sql(
                        "SELECT season_no FROM league_seasons WHERE user_id=? AND state='ACTIVE'")
                .param(uid).query(Integer.class).single();
        assertThat(newSeasonNo).isEqualTo(2);
    }

    // ── GET 순위표(초기 0점·1R) + next-match(mode=league) + 격리 (AC-F2/F3) ─

    @Test
    void getLeagueShowsInitialStandingsThenNextMatchIsLeagueMode() {
        String token = setupUserWithDeck("lg_get");
        authPost("/api/league/start", token, null, Map.class);

        ResponseEntity<Map> get = authGet("/api/league", token, Map.class);
        assertThat(get.getStatusCode()).isEqualTo(HttpStatus.OK);
        Map<?, ?> season = (Map<?, ?>) get.getBody().get("season");
        List<Map<String, Object>> standings = (List<Map<String, Object>>) season.get("standings");
        assertThat(standings).hasSize(10);
        assertThat(standings).allMatch(s -> ((Number) s.get("points")).intValue() == 0);
        assertThat(standings).allMatch(s -> ((Number) s.get("played")).intValue() == 0);
        Map<?, ?> next = (Map<?, ?>) season.get("nextUserFixture");
        assertThat(((Number) next.get("round")).intValue()).isEqualTo(1);

        ResponseEntity<Map> nm = authPost("/api/league/next-match", token, null, Map.class);
        assertThat(nm.getStatusCode()).isEqualTo(HttpStatus.CREATED);
        Map<?, ?> match = (Map<?, ?>) nm.getBody().get("match");
        assertThat(match.get("state")).isEqualTo("BRIEFING");
        assertThat(match.get("mode")).isEqualTo("league");
    }

    @Test
    void leagueMatchDrivesToFinishedSettlesFixtureAndIsolatedFromPractice() {
        String token = setupUserWithDeck("lg_e2e");
        String uid = userIdOf("lg_e2e");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        ResponseEntity<Map> nm = authPost("/api/league/next-match", token, null, Map.class);
        Map<?, ?> match = (Map<?, ?>) nm.getBody().get("match");
        String matchId = (String) match.get("id");
        Map<?, ?> fixture = (Map<?, ?>) nm.getBody().get("fixture");
        String fixtureId = (String) fixture.get("id");
        int round = ((Number) fixture.get("round")).intValue();

        // 라운드1은 유저 홈(서클 메서드) — 풀 플로우 드라이브 → FINISHED(1-0 유저 승).
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        authPost("/api/matches/" + matchId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");

        // 픽스처 정산됨 + 같은 라운드 봇전 4경기 PLAYED.
        Map<String, Object> settled = fixtureById(fixtureId);
        assertThat(settled.get("state")).isEqualTo("PLAYED");
        assertThat(settled.get("match_id")).isEqualTo(matchId);
        long playedInRound = fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("round")).intValue() == round && f.get("state").equals("PLAYED"))
                .count();
        assertThat(playedInRound).isEqualTo(5);

        // 순위표에 유저 1경기 반영.
        LeagueService.LeagueStanding user = leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser).findFirst().orElseThrow();
        assertThat(user.played()).isEqualTo(1);

        // 격리: 연습 매치 종료가 리그 픽스처를 건드리지 않는다.
        long playedBefore = playedFixtureCount(seasonId);
        String practiceId = createMatch(token, "BOT_BAL");
        assertThat(jdbcClient.sql("SELECT mode FROM matches WHERE id=?").param(practiceId)
                .query(String.class).single()).isEqualTo("practice");
        authPost("/api/matches/" + practiceId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        authPost("/api/matches/" + practiceId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + practiceId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(practiceId)).isEqualTo("FINISHED");
        assertThat(jdbcClient.sql("SELECT league_fixture_id FROM matches WHERE id=?").param(practiceId)
                .query(String.class).optional().orElse(null)).isNull();
        assertThat(playedFixtureCount(seasonId)).isEqualTo(playedBefore); // 리그 픽스처 무변화
    }

    // ── 어웨이 유저 리그경기 풀 플로우 → 유저 관점 flip (W3 이월 / W4 오리엔트) ──

    @Test
    @SuppressWarnings("unchecked")
    void awayUserLeagueMatchDrivesToFinishedFlipsResultAndRewardUserPerspective() {
        String token = setupUserWithDeck("lg_away_e2e");
        String uid = userIdOf("lg_away_e2e");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        // 라운드 1~9 유저 픽스처를 직접 정산해 스케줄 전진 → 다음 유저 경기 = 라운드10(서클 메서드상 유저 어웨이).
        List<Map<String, Object>> userFx = userFixturesOrdered(seasonId);
        for (int i = 0; i < 9; i++) {
            Map<String, Object> f = userFx.get(i);
            leagueService.settleUserFixture((String) f.get("id"), 0, 0); // 무승부(관계/보상 경로 미개입)
        }

        ResponseEntity<Map> nm = authPost("/api/league/next-match", token, null, Map.class);
        Map<?, ?> match = (Map<?, ?>) nm.getBody().get("match");
        String matchId = (String) match.get("id");
        Map<?, ?> fixture = (Map<?, ?>) nm.getBody().get("fixture");
        String fixtureId = (String) fixture.get("id");
        assertThat(leagueService.userIsHomeForFixture(fixtureId)).isFalse(); // 유저 어웨이

        // 풀 플로우 드라이브 → FINISHED. 엔진(=픽스처) home:1 away:0(h1) → 유저(어웨이) 관점 패(flip).
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        authPost("/api/matches/" + matchId + "/halftime", token, Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");

        // result flip: 엔진 home 승이지만 유저 어웨이 → LOSS. score_home/away 는 엔진(=픽스처) 관점 저장.
        Map<String, Object> m = matchRow(matchId);
        assertThat(m.get("result")).isEqualTo("LOSS");
        assertThat(((Number) m.get("score_home")).intValue()).isEqualTo(1);
        assertThat(((Number) m.get("score_away")).intValue()).isEqualTo(0);

        // 픽스처 정산도 엔진(=픽스처) 관점(직접 매핑).
        Map<String, Object> settled = fixtureById(fixtureId);
        assertThat(((Number) settled.get("score_home")).intValue()).isEqualTo(1);
        assertThat(((Number) settled.get("score_away")).intValue()).isEqualTo(0);

        // 보상 = 유저 관점(패배 보상 reward_loss, ref=matchId).
        long lossReward = jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='reward_loss' AND ref_id=?")
                .params(uid, matchId).query(Long.class).single();
        assertThat(lossReward).isEqualTo(1L);

        // records = 유저 관점(패 → 사기 streak 음수).
        int streak = jdbcClient.sql("SELECT streak FROM team_morale WHERE user_id=?")
                .param(uid).query(Integer.class).single();
        assertThat(streak).isLessThan(0);

        // W4 오리엔트: 로그 엔드포인트가 유저 어웨이를 userWasHome=false 로 실어보낸다(실플로우 경로).
        ResponseEntity<List> logs = authGet("/api/logs/matches?mode=league", token, List.class);
        List<Map<String, Object>> items = logs.getBody();
        Map<String, Object> logItem = items.stream()
                .filter(it -> matchId.equals(it.get("id"))).findFirst().orElseThrow();
        assertThat((Boolean) logItem.get("userWasHome")).isFalse();
        assertThat(logItem.get("result")).isEqualTo("LOSS");
        assertThat(((Number) logItem.get("scoreAway")).intValue()).isEqualTo(0); // 유저 득점 = away 슬롯
    }

    // ── W3: 리그 보상 실지급 검증 + seasonReward 노출 (AC-E1) ──────────────

    /**
     * league.v1.json rewards 미러(테스트 측 기대값 — rank→points).
     * #212 hero 확정 곡선: 우승이 압도적이고 그 밑은 급감(1위 = 2위의 5배).
     */
    private static final Map<Integer, Integer> REWARD_TIERS = Map.ofEntries(
            Map.entry(1, 100000), Map.entry(2, 20000), Map.entry(3, 10000), Map.entry(4, 6000),
            Map.entry(5, 4000), Map.entry(6, 3000), Map.entry(7, 2000), Map.entry(8, 1500),
            Map.entry(9, 1000), Map.entry(10, 500));

    /** league.v1 rewards[rank=1] — 우승 보상(#212). */
    private static final long RANK1_REWARD = REWARD_TIERS.get(1);

    /**
     * AC-E1 실지급: stub 서번트로 시즌 18R 완주(유저 전승 → 1위) → FINISHED → <b>지갑 잔액이 정확히
     * 보상액만큼 증가</b> + 원장 delta 정확 + seasonReward=GRANTED 노출. <b>멱등을 값 불변으로 2중 검증</b>:
     * (1) maybeFinishSeason 재호출(FINISHED CAS 가드로 no-op), (2) awardSeasonRewards 직접 재호출(원장
     * 백스톱으로 apply=false). 두 경로 모두 지갑·원장 값 불변.
     */
    @Test
    @SuppressWarnings("unchecked")
    void seasonRewardGrantedReflectsExactWalletDeltaAndReentryIsNoOp() {
        String token = setupUserWithDeck("lg_reward_win");
        String uid = userIdOf("lg_reward_win");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        long walletBefore = walletPoints(uid); // 시즌 시작 후·보상 전 잔액.
        long gemsBefore = walletGems(uid);     // #212 우승 젬 델타 측정용(가입 지급분이 이미 들어있다).

        // 유저 전승(홈=3:0 / 어웨이=0:3)으로 18경기 정산 → 1위. (직접 정산 경로 = 승/무/패 보상 미개입.)
        for (Map<String, Object> f : userFixturesOrdered(seasonId)) {
            boolean userHome = "USER".equals(f.get("home_team"));
            leagueService.settleUserFixture((String) f.get("id"), userHome ? 3 : 0, userHome ? 0 : 3);
        }

        // 지갑 잔액 델타 = 정확히 rank1 보상. 다른 원장 유입 없음(직접 정산이라 승/무/패 보상 없음).
        long walletAfter = walletPoints(uid);
        assertThat(walletAfter - walletBefore).isEqualTo(RANK1_REWARD);

        // 원장: league_reward, ref=seasonId, delta=rank1 보상 정확히 1행.
        assertThat(rewardLedgerCount(uid, seasonId)).isEqualTo(1L);
        assertThat(rewardLedgerDelta(uid, seasonId)).isEqualTo(RANK1_REWARD);

        // #212 우승 젬: 1위만 받는다 + 값이 config 밴드[500,3000] 안 + 지갑 델타와 원장이 일치.
        long gemsAfter = walletGems(uid);
        assertThat(gemsAfter - gemsBefore).isBetween(500L, 3000L);
        assertThat(gemLedgerCount(uid, seasonId)).isEqualTo(1L);
        assertThat(gemLedgerDelta(uid, seasonId)).isEqualTo(gemsAfter - gemsBefore);

        // seasonReward 노출(GET /api/league) = GRANTED, points/gems=원장 delta, rank=1, awardedAt 비null.
        Map<String, Object> reward = seasonRewardOf(token);
        assertThat(reward.get("status")).isEqualTo("GRANTED");
        assertThat(((Number) reward.get("rank")).intValue()).isEqualTo(1);
        assertThat(((Number) reward.get("points")).intValue()).isEqualTo((int) RANK1_REWARD);
        assertThat(((Number) reward.get("gems")).longValue()).isEqualTo(gemsAfter - gemsBefore);
        assertThat(reward.get("awardedAt")).isNotNull();

        // ── 멱등 1: maybeFinishSeason 재호출 → 이미 FINISHED(CAS 가드) → no-op. 값 불변.
        invokeSeasonHook("maybeFinishSeason", seasonId);
        assertThat(walletPoints(uid)).isEqualTo(walletAfter);
        assertThat(walletGems(uid)).isEqualTo(gemsAfter);
        assertThat(rewardLedgerCount(uid, seasonId)).isEqualTo(1L);
        assertThat(rewardLedgerDelta(uid, seasonId)).isEqualTo(RANK1_REWARD);

        // ── 멱등 2: awardSeasonRewards 직접 재호출(CAS 우회) → 원장 백스톱(apply=false) → no-op. 값 불변.
        // 젬도 같은 백스톱(gem_ledger 유니크)을 타는지 함께 박제한다(#212 — 랜덤 지급이라 더 중요).
        invokeSeasonHook("awardSeasonRewards", seasonId);
        assertThat(walletPoints(uid)).isEqualTo(walletAfter);
        assertThat(walletGems(uid)).isEqualTo(gemsAfter);
        assertThat(rewardLedgerCount(uid, seasonId)).isEqualTo(1L);
        assertThat(rewardLedgerDelta(uid, seasonId)).isEqualTo(RANK1_REWARD);
        assertThat(gemLedgerCount(uid, seasonId)).isEqualTo(1L);
    }

    /**
     * #212 우승 젬은 <b>시즌 seed 파생 결정론</b>이어야 한다(§2-5 불변: {@code Math.random} 금지).
     * 밴드 검사만으로는 난수원을 바꿔도 안 걸린다 — {@code rngFromSeed} 를 {@code ThreadLocalRandom}
     * 으로 갈아끼워도 [500,3000] 은 그대로 통과하기 때문이다. 그래서 여기서는 <b>재현성</b>을 직접 건다:
     * ① 같은 seed 를 몇 번 계산해도 같은 값 ② 서로 다른 시즌은 값이 갈린다(상수 반환 변이체 배제).
     */
    @Test
    @SuppressWarnings("unchecked")
    void seasonGemRewardIsDerivedFromSeasonSeedNotAmbientRandomness() {
        String token = setupUserWithDeck("lg_gem_det");
        String uid = userIdOf("lg_gem_det");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        // 전승 → 1위(젬 지급 대상).
        for (Map<String, Object> f : userFixturesOrdered(seasonId)) {
            boolean userHome = "USER".equals(f.get("home_team"));
            leagueService.settleUserFixture((String) f.get("id"), userHome ? 3 : 0, userHome ? 0 : 3);
        }
        long first = gemLedgerDelta(uid, seasonId);
        assertThat(first).isBetween(500L, 3000L);

        // ① 재현성 — 같은 시즌 seed 로 지급을 5번 다시 계산해도 같은 값이 나온다.
        //    (원장 행을 지워 멱등 백스톱을 걷어내고 **계산 자체**를 다시 태운다 — 그래야
        //     "멱등이라 안 변한 것"이 아니라 "결정론이라 같은 것"임이 증명된다.)
        for (int i = 0; i < 5; i++) {
            deleteGemLedger(uid, seasonId);
            invokeSeasonHook("awardSeasonRewards", seasonId);
            assertThat(gemLedgerDelta(uid, seasonId))
                    .as("같은 시즌 seed → 항상 같은 젬 지급액").isEqualTo(first);
        }

        // ② 시즌 seed 가 바뀌면 값도 갈린다 — 상수 반환 변이체를 배제한다.
        //    (같은 값이 우연히 반복될 수 있으므로 여러 seed 를 훑어 "적어도 하나는 다르다"를 본다.)
        Set<Long> seen = new HashSet<>();
        for (int i = 0; i < 12; i++) {
            setSeasonSeed(seasonId, "det-probe-seed-" + i);
            deleteGemLedger(uid, seasonId);
            invokeSeasonHook("awardSeasonRewards", seasonId);
            long gems = gemLedgerDelta(uid, seasonId);
            assertThat(gems).as("어떤 seed 라도 config 밴드 안").isBetween(500L, 3000L);
            seen.add(gems);
        }
        assertThat(seen).as("seed 가 다르면 지급액도 갈린다(상수 아님)").hasSizeGreaterThan(1);
    }

    private void deleteGemLedger(String userId, String seasonId) {
        jdbcClient.sql("DELETE FROM gem_ledger WHERE user_id=? AND reason='league_gem_reward' AND ref_id=?")
                .params(userId, seasonId).update();
    }

    private void setSeasonSeed(String seasonId, String seed) {
        jdbcClient.sql("UPDATE league_seasons SET seed=? WHERE id=?").params(seed, seasonId).update();
    }

    /**
     * AC-E1 순위별 분기: 유저 전패(홈=0:3 / 어웨이=3:0)로 완주 → 1위가 아닌 순위로 종료 →
     * 해당 순위 티어 보상이 지갑에 지급되고 seasonReward.points 가 그 티어와 일치.
     */
    @Test
    @SuppressWarnings("unchecked")
    void seasonRewardGrantsRankTierForNonFirstFinish() {
        String token = setupUserWithDeck("lg_reward_lose");
        String uid = userIdOf("lg_reward_lose");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        long walletBefore = walletPoints(uid);
        long gemsBefore = walletGems(uid);

        for (Map<String, Object> f : userFixturesOrdered(seasonId)) {
            boolean userHome = "USER".equals(f.get("home_team"));
            leagueService.settleUserFixture((String) f.get("id"), userHome ? 0 : 3, userHome ? 3 : 0);
        }

        LeagueService.LeagueStanding user = leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser).findFirst().orElseThrow();
        int rank = user.rank();
        assertThat(rank).as("전패 → 1위 아님").isGreaterThan(1);
        int expectedTier = REWARD_TIERS.get(rank);

        // 지갑 델타 = 원장 delta = seasonReward.points = 해당 순위 티어. 세 출처가 일치.
        assertThat(walletPoints(uid) - walletBefore).isEqualTo((long) expectedTier);
        assertThat(rewardLedgerCount(uid, seasonId)).isEqualTo(1L);
        assertThat(rewardLedgerDelta(uid, seasonId)).isEqualTo((long) expectedTier);

        // #212: 젬은 **우승(1위) 시에만**. 1위가 아니면 지갑도 원장도 무변화.
        assertThat(walletGems(uid) - gemsBefore).isZero();
        assertThat(gemLedgerCount(uid, seasonId)).isZero();

        Map<String, Object> reward = seasonRewardOf(token);
        assertThat(reward.get("status")).isEqualTo("GRANTED");
        assertThat(((Number) reward.get("rank")).intValue()).isEqualTo(rank);
        assertThat(((Number) reward.get("points")).intValue()).isEqualTo(expectedTier);
        assertThat(((Number) reward.get("gems")).intValue()).isZero();
    }

    /**
     * seasonReward = PENDING 노출(시즌 ACTIVE·미종료). points=0(예정액 아님 — web 오인 방지),
     * awardedAt=null, rank=현재 잠정 순위(1~10). 원장에 지급행 없음.
     */
    @Test
    @SuppressWarnings("unchecked")
    void seasonRewardIsPendingWhileSeasonActive() {
        String token = setupUserWithDeck("lg_pending");
        String uid = userIdOf("lg_pending");
        authPost("/api/league/start", token, null, Map.class);
        String seasonId = seasonId(uid);

        Map<String, Object> reward = seasonRewardOf(token);
        assertThat(reward.get("status")).isEqualTo("PENDING");
        assertThat(((Number) reward.get("points")).intValue()).isEqualTo(0); // 예정액 채우지 않음.
        assertThat(reward.get("awardedAt")).isNull();
        int rank = ((Number) reward.get("rank")).intValue();
        assertThat(rank).isBetween(1, 10);

        // 미종료 → 원장 지급행 없음.
        assertThat(rewardLedgerCount(uid, seasonId)).isEqualTo(0L);
    }

    private long walletPoints(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(userId).query(Long.class).single();
    }

    private long walletGems(String userId) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id=?")
                .param(userId).query(Long.class).single();
    }

    /** #212 우승 젬 원장(gem_ledger, reason='league_gem_reward', ref=seasonId). */
    private long gemLedgerCount(String userId, String seasonId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM gem_ledger "
                        + "WHERE user_id=? AND reason='league_gem_reward' AND ref_id=?")
                .params(userId, seasonId).query(Long.class).single();
    }

    private long gemLedgerDelta(String userId, String seasonId) {
        return jdbcClient.sql("SELECT delta FROM gem_ledger "
                        + "WHERE user_id=? AND reason='league_gem_reward' AND ref_id=?")
                .params(userId, seasonId).query(Long.class).single();
    }

    private long rewardLedgerCount(String userId, String seasonId) {
        return jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='league_reward' AND ref_id=?")
                .params(userId, seasonId).query(Long.class).single();
    }

    private long rewardLedgerDelta(String userId, String seasonId) {
        return jdbcClient.sql(
                        "SELECT delta FROM point_ledger WHERE user_id=? AND reason='league_reward' AND ref_id=?")
                .params(userId, seasonId).query(Long.class).single();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> seasonRewardOf(String token) {
        ResponseEntity<Map> get = authGet("/api/league", token, Map.class);
        Map<?, ?> season = (Map<?, ?>) get.getBody().get("season");
        return (Map<String, Object>) season.get("seasonReward");
    }

    /** 시즌 종료 훅(package-private)을 재호출해 멱등 재진입을 검증(리플렉션 — production API 무확장). */
    private void invokeSeasonHook(String method, String seasonId) {
        try {
            java.lang.reflect.Method m = LeagueService.class.getDeclaredMethod(method, String.class);
            m.setAccessible(true);
            m.invoke(leagueService, seasonId);
        } catch (Exception e) {
            throw new IllegalStateException("훅 재호출 실패: " + method, e);
        }
    }

    // ── 헬퍼 ─────────────────────────────────────────────────────────────

    private Map<String, Object> matchRow(String matchId) {
        return jdbcClient.sql("SELECT id, result, score_home, score_away FROM matches WHERE id=?")
                .param(matchId)
                .query((rs, n) -> {
                    Map<String, Object> mm = new java.util.HashMap<>();
                    mm.put("id", rs.getString("id"));
                    mm.put("result", rs.getString("result"));
                    mm.put("score_home", rs.getObject("score_home"));
                    mm.put("score_away", rs.getObject("score_away"));
                    return mm;
                })
                .single();
    }

    private String seasonId(String userId) {
        return jdbcClient.sql("SELECT id FROM league_seasons WHERE user_id=? ORDER BY season_no DESC LIMIT 1")
                .param(userId).query(String.class).single();
    }

    private String seasonSeed(String seasonId) {
        return jdbcClient.sql("SELECT seed FROM league_seasons WHERE id=?")
                .param(seasonId).query(String.class).single();
    }

    private JsonNode readSeasonTeams(String seasonId) {
        String json = jdbcClient.sql("SELECT teams_json FROM league_seasons WHERE id=?")
                .param(seasonId).query(String.class).single();
        return matchServiceReadJson(json);
    }

    private JsonNode matchServiceReadJson(String json) {
        try {
            return new com.fasterxml.jackson.databind.ObjectMapper().readTree(json);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    private Map<String, Integer> teamPowers(JsonNode teams) {
        Map<String, Integer> powers = new java.util.HashMap<>();
        for (JsonNode t : teams) {
            powers.put(t.path("teamId").asText(), t.path("power").asInt());
        }
        return powers;
    }

    private List<String> botTeamIds(String seasonId) {
        List<String> ids = new ArrayList<>();
        for (JsonNode t : readSeasonTeams(seasonId)) {
            if (!t.path("isUser").asBoolean()) {
                ids.add(t.path("teamId").asText());
            }
        }
        return ids;
    }

    private List<Map<String, Object>> fixtureRows(String seasonId) {
        return jdbcClient.sql("""
                        SELECT id, round, home_team, away_team, is_user, state, score_home, score_away, match_id
                        FROM league_fixtures WHERE season_id=? ORDER BY round, home_team
                        """)
                .param(seasonId)
                .query((rs, n) -> {
                    Map<String, Object> m = new java.util.HashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("round", rs.getInt("round"));
                    m.put("home_team", rs.getString("home_team"));
                    m.put("away_team", rs.getString("away_team"));
                    m.put("is_user", rs.getInt("is_user"));
                    m.put("state", rs.getString("state"));
                    m.put("score_home", rs.getObject("score_home"));
                    m.put("score_away", rs.getObject("score_away"));
                    m.put("match_id", rs.getString("match_id"));
                    return m;
                })
                .list();
    }

    private Map<String, Object> fixtureById(String fixtureId) {
        return fixtureRows0(fixtureId);
    }

    private Map<String, Object> fixtureRows0(String fixtureId) {
        return jdbcClient.sql("""
                        SELECT id, round, home_team, away_team, is_user, state, score_home, score_away, match_id
                        FROM league_fixtures WHERE id=?
                        """)
                .param(fixtureId)
                .query((rs, n) -> {
                    Map<String, Object> m = new java.util.HashMap<>();
                    m.put("id", rs.getString("id"));
                    m.put("round", rs.getInt("round"));
                    m.put("home_team", rs.getString("home_team"));
                    m.put("away_team", rs.getString("away_team"));
                    m.put("is_user", rs.getInt("is_user"));
                    m.put("state", rs.getString("state"));
                    m.put("score_home", rs.getObject("score_home"));
                    m.put("score_away", rs.getObject("score_away"));
                    m.put("match_id", rs.getString("match_id"));
                    return m;
                })
                .single();
    }

    private List<Map<String, Object>> userFixturesOrdered(String seasonId) {
        return fixtureRows(seasonId).stream()
                .filter(f -> ((Number) f.get("is_user")).intValue() == 1)
                .sorted(java.util.Comparator.comparingInt(f -> ((Number) f.get("round")).intValue()))
                .toList();
    }

    private long playedFixtureCount(String seasonId) {
        return fixtureRows(seasonId).stream().filter(f -> f.get("state").equals("PLAYED")).count();
    }

    private void insertPlayed(String seasonId, int round, String home, String away, int sh, int sa) {
        jdbcClient.sql("""
                        INSERT INTO league_fixtures(id, season_id, round, home_team, away_team, is_user, state,
                                                    score_home, score_away)
                        VALUES (?, ?, ?, ?, ?, 0, 'PLAYED', ?, ?)
                        """)
                .params(online.hmb.common.Ulid.next(), seasonId, round, home, away, sh, sa)
                .update();
    }
}
