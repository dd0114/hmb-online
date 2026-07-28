package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import online.hmb.away.AwaySeasonService;
import online.hmb.away.AwayService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * #245 원정 v2 — hero 3차 확정(2026-07-29) 계약.
 *
 * <p>E2 무작위 2명 제시 → 택1(제시 밖은 거부) · E3 레이팅 밴드 매칭 · E4 연승 보너스 ·
 * E5 주간 시즌(보상 후 초기화) · E6/E7 돈은 리그 곡선, 수비자도 받되 지면 0.
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class AwayV2Test extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private AwayService awayService;

    @Resource
    private AwaySeasonService seasonService;

    // ── E2: 2명 제시 → 그 안에서만 선택 ───────────────────────────────────

    @SuppressWarnings("unchecked")
    @Test
    void candidatesAreOfferedAndOnlyThoseCanBeChosen() {
        setupUserWithDeck("v2_a");
        setupUserWithDeck("v2_b");
        setupUserWithDeck("v2_c");
        String attacker = setupUserWithDeck("v2_atk");
        String attackerId = userIdOf("v2_atk");

        ResponseEntity<Map> res = authGet("/api/away/candidates", attacker, Map.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.OK);
        List<Map<String, Object>> offered = (List<Map<String, Object>>) res.getBody().get("candidates");
        assertThat(offered).hasSize(2);                       // hero: "둘 중에 고르게"
        assertThat(offered).allSatisfy(c -> assertThat(c.get("userId")).isNotEqualTo(attackerId));

        // 제시된 상대는 고를 수 있다.
        String chosen = (String) offered.get(0).get("userId");
        assertThat(authPost("/api/away/matches", attacker, Map.of("defenderId", chosen), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.CREATED);
        releaseActiveMatches();

        // ⚠️ 제시되지 않은 상대는 거부된다 — 이게 없으면 "2택"이 곧 지목이고, 부계정 반복 지목으로
        // 레이팅을 무한 생성할 수 있다(4R MAJ-4 가 막은 경로).
        String notOffered = List.of(userIdOf("v2_a"), userIdOf("v2_b"), userIdOf("v2_c")).stream()
                .filter(id -> offered.stream().noneMatch(c -> id.equals(c.get("userId"))))
                .findFirst().orElseThrow();
        ResponseEntity<String> denied = authPost("/api/away/matches", attacker,
                Map.of("defenderId", notOffered), String.class);
        assertThat(denied.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(denied.getBody()).contains("제시된 상대");
    }

    /** 새로 뽑으면 이전 제시는 무효 — 리롤로 후보를 쌓아 고르지 못하게. */
    @SuppressWarnings("unchecked")
    @Test
    void rerollInvalidatesThePreviousOffer() {
        for (int i = 0; i < 6; i++) {
            setupUserWithDeck("v2_pool_" + i);
        }
        String attacker = setupUserWithDeck("v2_reroll");
        String attackerId = userIdOf("v2_reroll");

        List<AwayService.Candidate> first = awayService.offerCandidates(attackerId);
        List<AwayService.Candidate> second = awayService.offerCandidates(attackerId);
        // 첫 제시에만 있고 두 번째엔 없는 후보를 찾으면, 그 후보는 이제 고를 수 없어야 한다.
        first.stream()
                .filter(c -> second.stream().noneMatch(s -> s.userId().equals(c.userId())))
                .findFirst()
                .ifPresent(stale -> assertThat(
                        authPost("/api/away/matches", attacker,
                                Map.of("defenderId", stale.userId()), String.class).getStatusCode())
                        .isEqualTo(HttpStatus.BAD_REQUEST));
    }

    // ── E3: 레이팅이 비슷한 사람 ─────────────────────────────────────────

    @Test
    void candidatesComeFromANearbyRatingBand() {
        setupUserWithDeck("v2_near");
        setupUserWithDeck("v2_far");
        String attacker = setupUserWithDeck("v2_band_atk");
        String attackerId = userIdOf("v2_band_atk");
        setRating(attackerId, 100);
        setRating(userIdOf("v2_near"), 120);     // 밴드(±50) 안
        setRating(userIdOf("v2_far"), 5000);     // 한참 밖

        // 밴드 안에 충분한 후보가 있으면 먼 사람은 뽑히지 않는다.
        for (int i = 0; i < 4; i++) {
            setupUserWithDeck("v2_near_" + i);
            setRating(userIdOf("v2_near_" + i), 90 + i);
        }
        for (int trial = 0; trial < 5; trial++) {
            List<AwayService.Candidate> offered = awayService.offerCandidates(attackerId);
            assertThat(offered).allSatisfy(c ->
                    assertThat(Math.abs(c.rating() - 100))
                            .as("레이팅이 비슷한 사람 중에서 골라야 한다 — %s(%d)", c.nickname(), c.rating())
                            .isLessThanOrEqualTo(200));
        }
    }

    // ── E4: 연승 보너스 ──────────────────────────────────────────────────

    @Test
    void winStreakAddsBonusRatingAndLossBreaksIt() {
        setupUserWithDeck("v2_streak_def");
        String defenderId = userIdOf("v2_streak_def");
        setupUserWithDeck("v2_streak_atk");
        String attackerId = userIdOf("v2_streak_atk");

        // 1승: 보너스 없음(2연승부터) → +10
        settleWin(attackerId, defenderId, "M_S1");
        assertThat(rating(attackerId)).isEqualTo(10);
        // 2연승: +10 +2
        settleWin(attackerId, defenderId, "M_S2");
        assertThat(rating(attackerId)).isEqualTo(22);
        // 3연승: +10 +4
        settleWin(attackerId, defenderId, "M_S3");
        assertThat(rating(attackerId)).isEqualTo(36);

        // 패배는 연승을 끊는다 → 다음 승리는 다시 보너스 0
        settleLoss(attackerId, defenderId, "M_S4");
        int afterLoss = rating(attackerId);
        settleWin(attackerId, defenderId, "M_S5");
        assertThat(rating(attackerId)).isEqualTo(afterLoss + 10);
    }

    // ── E6/E7: 돈은 리그 곡선, 수비자도 받되 지면 0 ───────────────────────

    @Test
    void defenderIsPaidOnSuccessfulDefenceButNotOnLoss() {
        setupUserWithDeck("v2_pay_def");
        String defenderId = userIdOf("v2_pay_def");
        setupUserWithDeck("v2_pay_atk");
        String attackerId = userIdOf("v2_pay_atk");

        // 수비 성공(공격자 LOSS) → 수비자에게 리그 승리 보상.
        settleLoss(attackerId, defenderId, "M_PAY1");
        long paidOnWin = awayReward(defenderId, "M_PAY1");
        assertThat(paidOnWin).as("덱 세팅을 잘해두면 돈이 들어온다(hero E7)").isPositive();
        assertThat(paidOnWin).isEqualTo(leagueReward("WIN"));

        // 수비 실패(공격자 WIN) → 0. "지면 남 좋은 일만 하는 구조".
        settleWin(attackerId, defenderId, "M_PAY2");
        assertThat(awayReward(defenderId, "M_PAY2")).isZero();
    }

    // ── E5: 주간 시즌 — 보상 후 초기화 ───────────────────────────────────

    @Test
    void seasonCloseRewardsRanksThenResetsRatings() {
        setupUserWithDeck("v2_season_top");
        String topId = userIdOf("v2_season_top");
        setupUserWithDeck("v2_season_low");
        String lowId = userIdOf("v2_season_low");
        // 원정 이력이 있어야 시즌 대상 — 정산으로 만든다.
        settleWin(topId, lowId, "M_SEASON1");
        setRating(topId, 500);
        setRating(lowId, 10);

        int seasonNo = seasonService.current().seasonNo();
        long topBefore = points(topId);
        // 시즌 종료 시각을 과거로 밀어 마감을 트리거한다.
        jdbcClient.sql("UPDATE away_seasons SET ends_at = ? WHERE state = 'ACTIVE'")
                .param(java.time.Instant.now().minusSeconds(60).toString()).update();

        assertThat(seasonService.sweepDueSeasons()).isPositive();

        // 스냅샷이 남고(초기화 전 성적) 보상이 지급되고 레이팅이 0 으로 돌아간다.
        Map<String, Object> snap = jdbcClient.sql("""
                        SELECT rank, rating, reward_points FROM away_season_results
                        WHERE season_no = ? AND user_id = ?
                        """)
                .params(seasonNo, topId)
                .query((rs, n) -> Map.<String, Object>of("rank", rs.getInt("rank"),
                        "rating", rs.getInt("rating"), "reward", rs.getInt("reward_points")))
                .single();
        assertThat(snap.get("rank")).isEqualTo(1);
        assertThat(snap.get("rating")).isEqualTo(500);
        assertThat(points(topId) - topBefore).isEqualTo(((Integer) snap.get("reward")).longValue());
        assertThat(rating(topId)).isZero();
        assertThat(rating(lowId)).isZero();

        // 다음 시즌이 열려 있다(빈 상태로 남지 않는다).
        assertThat(seasonService.current().seasonNo()).isEqualTo(seasonNo + 1);

        // 마감 재실행은 두 번 주지 않는다.
        long afterFirst = points(topId);
        seasonService.sweepDueSeasons();
        assertThat(points(topId)).isEqualTo(afterFirst);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    private void settleWin(String attackerId, String defenderId, String matchId) {
        seedChallenge(attackerId, defenderId, matchId);
        awayService.settle(matchId, attackerId, "WIN", 2, 0);
    }

    private void settleLoss(String attackerId, String defenderId, String matchId) {
        seedChallenge(attackerId, defenderId, matchId);
        awayService.settle(matchId, attackerId, "LOSS", 0, 2);
    }

    /** 정산은 매치·도전장이 있어야 한다 — 시뮬을 돌리지 않고 그 상태만 만든다. */
    private void seedChallenge(String attackerId, String defenderId, String matchId) {
        String now = java.time.Instant.now().toString();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO matches(id, user_id, bot_id, state, seed, engine_version,
                                                      user_deck_json, mode, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 'seed', 'test', '{}', 'away', ?)
                        """)
                .params(matchId, attackerId, now).update();
        jdbcClient.sql("""
                        INSERT OR IGNORE INTO away_challenges(match_id, defender_id, ghost_bot_id, created_at)
                        VALUES (?, ?, 'BOT_BAL', ?)
                        """)
                .params(matchId, defenderId, now).update();
    }

    private void setRating(String userId, int rating) {
        jdbcClient.sql("""
                        INSERT INTO user_ratings(user_id, rating, updated_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET rating = excluded.rating
                        """)
                .params(userId, rating, java.time.Instant.now().toString()).update();
    }

    private int rating(String userId) {
        return jdbcClient.sql("SELECT rating FROM user_ratings WHERE user_id = ?")
                .param(userId).query(Integer.class).optional().orElse(0);
    }

    private long points(String userId) {
        return jdbcClient.sql("SELECT points FROM wallets WHERE user_id = ?")
                .param(userId).query(Long.class).single();
    }

    private long awayReward(String userId, String matchId) {
        return jdbcClient.sql("""
                        SELECT COALESCE(SUM(delta), 0) FROM point_ledger
                        WHERE user_id = ? AND ref_id = ? AND reason = 'away_defense_reward'
                        """)
                .params(userId, matchId).query(Long.class).single();
    }

    /** economy 의 리그 곡선 — 원정 보상은 이 값을 참조한다(hero E6 "리그 한 판과 같이"). */
    private long leagueReward(String result) {
        return jdbcClient.sql("SELECT 1").query(Integer.class).single() > 0
                ? economyLeague(result) : 0;
    }

    @Resource
    private online.hmb.catalog.EconomyService economyService;

    private long economyLeague(String result) {
        return economyService.get().orElseThrow().rewards().forMode("league").by(result);
    }
}
