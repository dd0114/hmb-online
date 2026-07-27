package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import online.hmb.league.LeagueService;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.context.annotation.Import;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #212 W1 실사 프로브 — "시즌 완주 시 실수입"을 주장이 아니라 실측으로 뽑는다.
 *
 * <p>stub 서번트/가짜 러너로 리그 시즌 18R 을 <b>실제 매치 플로우</b>(next-match → kickoff →
 * halftime → resume → FINISHED)로 완주시킨 뒤 point_ledger/gem_ledger 를 사유별로 집계해 출력한다.
 * 연습매치도 같은 플로우로 N판 돌려 <b>리그 매판 vs 연습 매판</b> 지급액을 나란히 찍는다.
 *
 * <p>판정용 어서션은 최소(완주·정산 1회)만 두고, 나머지는 리포트 출력이 목적이다.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
@Import(FakeServantsConfig.class)
class SeasonIncomeProbeTest extends MatchTestBase {

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

    @jakarta.annotation.Resource
    private LeagueService leagueService;

    @jakarta.annotation.Resource
    private FakeServants fakeServants;

    @Test
    @SuppressWarnings("unchecked")
    void seasonCompletionIncomeBreakdown() {
        String token = setupUserWithDeck("econ_probe");
        String uid = userIdOf("econ_probe");

        long afterSignup = points(uid);
        System.out.println("\n===== #212 W1 SEASON INCOME PROBE =====");
        System.out.println("[가입 직후] points=" + afterSignup + " gems=" + gems(uid));

        authPost("/api/league/start", token, null, Map.class);
        String seasonId = jdbcClient.sql(
                        "SELECT id FROM league_seasons WHERE user_id=? AND state='ACTIVE'")
                .param(uid).query(String.class).single();

        long beforeSeason = points(uid);
        List<String> perMatch = new ArrayList<>();
        // 매판 지급액은 원장에서 직접 읽는다(마지막 라운드는 시즌보상이 같은 창에 들어와 잔액 델타가 섞인다).
        List<Long> leagueDeltas = new ArrayList<>();
        for (int r = 1; r <= 18; r++) {
            long before = points(uid);
            Map<String, Object> nm = (Map<String, Object>) authPost(
                    "/api/league/next-match", token, null, Map.class).getBody();
            Map<String, Object> match = (Map<String, Object>) nm.get("match");
            String matchId = (String) match.get("id");
            drivePastFinished(token, matchId);
            String result = jdbcClient.sql("SELECT result FROM matches WHERE id=?")
                    .param(matchId).query(String.class).single();
            leagueDeltas.add(rewardOf(uid, matchId));
            perMatch.add("R" + r + " " + result + " +" + (points(uid) - before));
        }
        long afterFixtures = points(uid);

        System.out.println("[리그 18R 매판] " + String.join(" | ", perMatch));
        System.out.println("[리그 매판 소계] " + (afterFixtures - beforeSeason) + " P");

        // 시즌 상태 + 순위 + 시즌보상 원장.
        String seasonState = jdbcClient.sql("SELECT state FROM league_seasons WHERE id=?")
                .param(seasonId).query(String.class).single();
        int rank = leagueService.computeStandings(seasonId).stream()
                .filter(LeagueService.LeagueStanding::isUser)
                .map(LeagueService.LeagueStanding::rank).findFirst().orElse(-1);
        long seasonReward = jdbcClient.sql(
                        "SELECT COALESCE(SUM(delta),0) FROM point_ledger "
                                + "WHERE user_id=? AND reason='league_reward'")
                .param(uid).query(Long.class).single();
        long seasonRewardRows = jdbcClient.sql(
                        "SELECT COUNT(*) FROM point_ledger WHERE user_id=? AND reason='league_reward'")
                .param(uid).query(Long.class).single();
        System.out.println("[시즌] state=" + seasonState + " rank=" + rank
                + " 시즌보상=" + seasonReward + " P (원장 " + seasonRewardRows + "행)");

        assertThat(seasonState).isEqualTo("FINISHED");
        assertThat(seasonRewardRows).isEqualTo(1L);
        assertThat(seasonReward).as("시즌보상 = 해당 순위 티어").isEqualTo((long) RANK_TIERS.get(rank));

        // #212 계약: 리그 매판 지급은 리그 티어(5000/2000/1000)만 나온다.
        assertThat(leagueDeltas).as("리그 매판 = 리그 보상표").isSubsetOf(5000L, 2000L, 1000L);
        assertThat(leagueDeltas).as("18R 전부 지급됨").hasSize(18);

        // 젬(#212): 우승(1위)에서만 지급된다. 이 시나리오는 전승이 아니므로 rank 에 따라 갈린다.
        long gemsFromSeason = jdbcClient.sql(
                        "SELECT COALESCE(SUM(delta),0) FROM gem_ledger "
                                + "WHERE user_id=? AND reason='league_gem_reward'")
                .param(uid).query(Long.class).single();
        System.out.println("[시즌 젬] rank=" + rank + " → " + gemsFromSeason + " 젬");
        if (rank == 1) {
            assertThat(gemsFromSeason).as("우승 젬은 config 밴드 안").isBetween(500L, 3000L);
        } else {
            assertThat(gemsFromSeason).as("우승이 아니면 젬 0").isZero();
        }

        // 연습매치 3판 — 리그 매판과 지급액 비교.
        long beforePractice = points(uid);
        List<String> practice = new ArrayList<>();
        List<Long> practiceDeltas = new ArrayList<>();
        for (int i = 0; i < 3; i++) {
            long before = points(uid);
            String matchId = createMatch(token, "BOT_BAL");
            drivePastFinished(token, matchId);
            String result = jdbcClient.sql("SELECT result FROM matches WHERE id=?")
                    .param(matchId).query(String.class).single();
            practiceDeltas.add(rewardOf(uid, matchId));
            practice.add(result + " +" + (points(uid) - before));
        }
        System.out.println("[연습 3판] " + String.join(" | ", practice)
                + "  소계 " + (points(uid) - beforePractice) + " P");

        // #212 핵심 계약 — hero 목표 곡선의 "연습 적게 < 리그 매판":
        // 같은 결과(WIN)라도 연습 지급이 리그 지급보다 **엄격히 작아야** 한다.
        assertThat(practiceDeltas).as("연습 매판 = 연습 보상표").isSubsetOf(500L, 200L, 100L);
        long maxPractice = practiceDeltas.stream().mapToLong(Long::longValue).max().orElseThrow();
        long minLeague = leagueDeltas.stream().mapToLong(Long::longValue).min().orElseThrow();
        assertThat(maxPractice).as("연습 최대 지급 < 리그 최소 지급").isLessThan(minLeague);

        // 사유별 원장 전수.
        System.out.println("[point_ledger 사유별] " + ledgerByReason(uid, "point_ledger"));
        System.out.println("[gem_ledger 사유별]   " + ledgerByReason(uid, "gem_ledger"));
        System.out.println("[최종 지갑] points=" + points(uid) + " gems=" + gems(uid));
        System.out.println("===== END PROBE =====\n");
    }

    /** league.v1.json rewards 미러(#212 hero 확정 곡선) — 우승이 압도적, 그 밑은 급감. */
    private static final Map<Integer, Integer> RANK_TIERS = Map.ofEntries(
            Map.entry(1, 100000), Map.entry(2, 20000), Map.entry(3, 10000), Map.entry(4, 6000),
            Map.entry(5, 4000), Map.entry(6, 3000), Map.entry(7, 2000), Map.entry(8, 1500),
            Map.entry(9, 1000), Map.entry(10, 500));

    /** 매치 1건의 승/무/패 보상액(원장 ref=matchId) — 잔액 델타와 달리 다른 지급과 섞이지 않는다. */
    private long rewardOf(String uid, String matchId) {
        return jdbcClient.sql("SELECT COALESCE(SUM(delta),0) FROM point_ledger "
                        + "WHERE user_id=? AND ref_id=? AND reason LIKE 'reward_%'")
                .params(uid, matchId).query(Long.class).single();
    }

    private void drivePastFinished(String token, String matchId) {
        authPost("/api/matches/" + matchId + "/kickoff", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("HALFTIME");
        authPost("/api/matches/" + matchId + "/halftime", token,
                Map.of("substitutions", List.of()), Map.class);
        authPost("/api/matches/" + matchId + "/resume", token, Map.of(), Map.class);
        fakeServants.drain();
        assertThat(matchState(matchId)).isEqualTo("FINISHED");
    }

    private Map<String, Long> ledgerByReason(String uid, String table) {
        Map<String, Long> out = new LinkedHashMap<>();
        jdbcClient.sql("SELECT reason, COUNT(*) c, SUM(delta) s FROM " + table
                        + " WHERE user_id=? GROUP BY reason ORDER BY reason")
                .param(uid)
                .query((rs, n) -> {
                    out.put(rs.getString("reason") + "×" + rs.getLong("c"), rs.getLong("s"));
                    return null;
                })
                .list();
        return out;
    }

    private long points(String uid) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
    }

    private long gems(String uid) {
        return jdbcClient.sql("SELECT gems FROM wallets WHERE user_id=?")
                .param(uid).query(Long.class).single();
    }
}
