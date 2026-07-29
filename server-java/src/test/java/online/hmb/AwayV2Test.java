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
        setupOpponentWithDeck("v2_a");
        setupOpponentWithDeck("v2_b");
        setupOpponentWithDeck("v2_c");
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

        // ⚠️ **제시는 소모된다** — 한 제시 = 한 경기(MAJ-7). 남겨두면 TTL 동안 같은 상대를 반복
        // 수락할 수 있고, 승패로 레이팅이 벌어져 밴드를 벗어난 뒤에도 계속 고를 수 있다.
        ResponseEntity<String> reuse = authPost("/api/away/matches", attacker,
                Map.of("defenderId", chosen), String.class);
        assertThat(reuse.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(reuse.getBody()).contains("먼저 상대 목록");

        // ⚠️ 제시되지 않은 상대는 거부된다 — 이게 없으면 "2택"이 곧 지목이고, 부계정 반복 지목으로
        // 레이팅을 무한 생성할 수 있다(4R MAJ-4 가 막은 경로).
        ResponseEntity<Map> again = authGet("/api/away/candidates", attacker, Map.class);
        List<Map<String, Object>> reoffered = (List<Map<String, Object>>) again.getBody().get("candidates");
        String notOffered = List.of(userIdOf("v2_a"), userIdOf("v2_b"), userIdOf("v2_c")).stream()
                .filter(id -> reoffered.stream().noneMatch(c -> id.equals(c.get("userId"))))
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
            setupOpponentWithDeck("v2_pool_" + i);
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
        setupOpponentWithDeck("v2_near");
        setupOpponentWithDeck("v2_far");
        String attacker = setupUserWithDeck("v2_band_atk");
        String attackerId = userIdOf("v2_band_atk");
        setRating(attackerId, 100);
        setRating(userIdOf("v2_near"), 120);     // 밴드(±50) 안
        setRating(userIdOf("v2_far"), 5000);     // 한참 밖

        // 밴드 안에 충분한 후보가 있으면 먼 사람은 뽑히지 않는다.
        for (int i = 0; i < 4; i++) {
            setupOpponentWithDeck("v2_near_" + i);
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

    /** hero E4 의 가장 특이한 절 — **무승부는 연승을 끊지 않는다**(끊으면 방어 성공이 손해가 된다). */
    @Test
    void drawKeepsTheStreak() {
        setupUserWithDeck("v2_draw_def");
        String defenderId = userIdOf("v2_draw_def");
        setupUserWithDeck("v2_draw_atk");
        String attackerId = userIdOf("v2_draw_atk");

        settleWin(attackerId, defenderId, "M_D1");
        settleWin(attackerId, defenderId, "M_D2");        // 2연승 (+10 +2)
        int before = rating(attackerId);
        seedChallenge(attackerId, defenderId, "M_D3");
        awayService.settle("M_D3", attackerId, "DRAW", 1, 1);
        assertThat(rating(attackerId)).as("무승부는 레이팅을 움직이지 않는다").isEqualTo(before);

        // 연승이 유지됐으면 다음 승리는 3연승 보너스(+4)를 받는다.
        settleWin(attackerId, defenderId, "M_D4");
        assertThat(rating(attackerId) - before).isEqualTo(14);
    }

    /** 보너스 상한 — 없으면 장기 연승이 밴드를 뚫고 혼자 달아난다. */
    @Test
    void streakBonusIsCapped() {
        setupUserWithDeck("v2_cap_def");
        String defenderId = userIdOf("v2_cap_def");
        setupUserWithDeck("v2_cap_atk");
        String attackerId = userIdOf("v2_cap_atk");

        int prev = 0;
        int lastGain = 0;
        for (int i = 1; i <= 12; i++) {
            settleWin(attackerId, defenderId, "M_C" + i);
            lastGain = rating(attackerId) - prev;
            prev = rating(attackerId);
        }
        // 기본 10 + 상한 10 = 20 을 넘지 않는다.
        assertThat(lastGain).isEqualTo(20);
    }

    /**
     * <b>연승은 내가 친 경기에만 걸린다</b>(hero 확정) — 방어는 내가 고른 플레이가 아니다.
     * 방어 성공이 연승을 올리지도 않고, <b>방어 실패가 연승을 깨지도 않는다</b>: 자는 사이 남이 쳐서
     * 내 연승이 끊기면 그건 내가 어쩔 수 없는 이유로 잃는 것이다.
     */
    @Test
    void defenceNeverTouchesMyStreak() {
        setupUserWithDeck("v2_own_me");
        String meId = userIdOf("v2_own_me");
        setupUserWithDeck("v2_own_victim");
        String victimId = userIdOf("v2_own_victim");
        setupUserWithDeck("v2_own_raider");
        String raiderId = userIdOf("v2_own_raider");

        // 내가 쳐서 2연승을 만든다.
        settleWin(meId, victimId, "M_OWN1");
        settleWin(meId, victimId, "M_OWN2");
        assertThat(awayService.streakOf(meId)).isEqualTo(2);

        // 남이 나를 쳐서 **내가 방어에 실패**한다(공격자 WIN = 내가 LOSS).
        settleWin(raiderId, meId, "M_OWN3");
        assertThat(awayService.streakOf(meId))
                .as("남이 쳐서 깨지면 내가 어쩔 수 없는 이유로 연승을 잃는다")
                .isEqualTo(2);

        // 방어에 **성공**해도 연승은 오르지 않는다(내 플레이가 아니다).
        settleLoss(raiderId, meId, "M_OWN4");
        assertThat(awayService.streakOf(meId)).isEqualTo(2);

        // 내가 친 경기에서 지면 그때 끊긴다.
        settleLoss(meId, victimId, "M_OWN5");
        assertThat(awayService.streakOf(meId)).isZero();
    }

    /** 연승 보너스도 공격자에게만 붙는다 — 방어 레이팅은 ±10 그대로다. */
    @Test
    void streakBonusAppliesToMyRaidsOnly() {
        setupUserWithDeck("v2_bonus_me");
        String meId = userIdOf("v2_bonus_me");
        setupUserWithDeck("v2_bonus_victim");
        String victimId = userIdOf("v2_bonus_victim");
        setupUserWithDeck("v2_bonus_raider");
        String raiderId = userIdOf("v2_bonus_raider");

        settleWin(meId, victimId, "M_BON1");
        settleWin(meId, victimId, "M_BON2");   // 2연승 = 10 + 2
        int afterRaids = rating(meId);

        // 방어 성공 — 연승이 2라도 보너스 없이 +10.
        settleLoss(raiderId, meId, "M_BON3");
        assertThat(rating(meId) - afterRaids)
                .as("방어에 연승 보너스가 붙으면 '내 플레이만' 규칙이 깨진 것이다")
                .isEqualTo(10);
    }

    /**
     * 리포트가 박제하는 값 = <b>실제 적용값</b>(연승 보너스 포함) — 팝업의 레이팅 합계가 이걸 더한다.
     *
     * <p>⚠️ 연승 보너스는 이제 <b>공격자에게만</b> 붙는다. 그래서 이 계약의 무게중심도 공격자 원장에
     * 있다(보너스가 실제로 적용됐는가). 그 축은 변이로 확인된다 — 공격자 적용값을 기본값으로 바꾸면
     * 이 테스트 포함 4개가 죽는다.
     *
     * <p>반면 <b>리포트 필드(수비자 관점)에 기본값을 넣는 변이는 등가 변이</b>다: 수비 보너스가 구조적
     * 으로 0 이라 "적용값"과 "기본값"이 같은 값이기 때문이다. 수비자에게 보너스를 다시 주는 날
     * 그 둘이 갈라지고, 그때 이 단언이 일하기 시작한다(지금 죽지 않는다고 지우지 마라).
     */
    @Test
    void reportRecordsTheAppliedDeltaIncludingStreakBonus() {
        setupUserWithDeck("v2_rep_def");
        String defenderId = userIdOf("v2_rep_def");
        setupUserWithDeck("v2_rep_atk");
        String attackerId = userIdOf("v2_rep_atk");

        settleWin(attackerId, defenderId, "M_R1");
        settleWin(attackerId, defenderId, "M_R2");   // 공격자 2연승 → 기본 10 + 보너스 2

        int applied = jdbcClient.sql("""
                        SELECT delta FROM rating_ledger WHERE ref_id = 'M_R2' AND reason = 'away_attack'
                        """)
                .query(Integer.class).single();
        assertThat(applied).as("보너스가 실제로 붙어야 이 계약이 의미를 갖는다").isGreaterThan(10);

        // 수비자 리포트의 delta 는 수비자 관점 적용값이고, 공격자 원장은 그 반대 부호의 기본값 + 보너스다.
        int recordedForDefender = jdbcClient.sql(
                        "SELECT rating_delta FROM away_reports WHERE match_id = 'M_R2'")
                .query(Integer.class).single();
        int defenderApplied = jdbcClient.sql("""
                        SELECT delta FROM rating_ledger WHERE ref_id = 'M_R2' AND reason = 'away_defense'
                        """)
                .query(Integer.class).single();
        assertThat(recordedForDefender)
                .as("리포트가 '적용값을 박제한다'고 선언해놓고 다른 값을 적으면 팝업 합계가 틀린다")
                .isEqualTo(defenderApplied);
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

    /** 시즌 연승 초기화 — 레이팅만 0 으로 돌리면 새 시즌 첫 판에 지난 시즌 보너스가 붙는다. */
    @Test
    void seasonResetAlsoClearsStreaks() {
        setupUserWithDeck("v2_sreset_def");
        String defenderId = userIdOf("v2_sreset_def");
        setupUserWithDeck("v2_sreset_atk");
        String attackerId = userIdOf("v2_sreset_atk");
        settleWin(attackerId, defenderId, "M_SR1");
        settleWin(attackerId, defenderId, "M_SR2");
        assertThat(awayService.streakOf(attackerId)).isEqualTo(2);

        expireSeason();
        seasonService.sweepDueSeasons();

        assertThat(awayService.streakOf(attackerId)).isZero();
    }

    /** 만료된 제시는 못 쓴다(TTL). */
    @Test
    void expiredOfferIsRejected() {
        setupOpponentWithDeck("v2_ttl_a");
        setupOpponentWithDeck("v2_ttl_b");
        String attacker = setupUserWithDeck("v2_ttl_atk");
        String attackerId = userIdOf("v2_ttl_atk");
        List<AwayService.Candidate> offered = awayService.offerCandidates(attackerId);

        jdbcClient.sql("UPDATE away_offers SET created_at = ? WHERE user_id = ?")
                .params(java.time.Instant.now().minusSeconds(60 * 60).toString(), attackerId)
                .update();

        ResponseEntity<String> res = authPost("/api/away/matches", attacker,
                Map.of("defenderId", offered.get(0).userId()), String.class);
        assertThat(res.getStatusCode()).isEqualTo(HttpStatus.BAD_REQUEST);
        assertThat(res.getBody()).contains("만료");
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
        expireSeason();

        assertThat(seasonService.sweepDueSeasons()).isPositive();

        // 스냅샷이 남고(초기화 전 성적) 보상이 지급되고 레이팅이 0 으로 돌아간다.
        // ⚠️ 순위·점수는 이제 **그 시즌의 변동 합**이라 절대값이 아니라 관계로 건다(공유 DB).
        Map<String, Object> snap = jdbcClient.sql("""
                        SELECT rank, rating, reward_points FROM away_season_results
                        WHERE season_no = ? AND user_id = ?
                        """)
                .params(seasonNo, topId)
                .query((rs, n) -> Map.<String, Object>of("rank", rs.getInt("rank"),
                        "rating", rs.getInt("rating"), "reward", rs.getInt("reward_points")))
                .single();
        assertThat((Integer) snap.get("rating")).as("이긴 쪽의 시즌 점수는 양수다").isPositive();
        assertThat(points(topId) - topBefore).isEqualTo(((Integer) snap.get("reward")).longValue());
        assertThat(rating(topId)).isZero();
        assertThat(rating(lowId)).isZero();

        // 다음 시즌이 열려 있다(빈 상태로 남지 않는다).
        assertThat(seasonService.current().seasonNo()).isGreaterThan(seasonNo);

        // ⚠️ 멱등은 **같은 시즌을 다시 닫아** 확인해야 한다. 그냥 sweep 을 또 부르면 방금 열린 시즌의
        // ends_at 이 미래라 첫 줄에서 break 해서 마감 코드에 **도달조차 하지 않는다**(독립검증 MAJ-4:
        // 멱등을 제거해도 통과했다). 시즌을 ACTIVE 로 되돌려 같은 번호를 재마감시킨다.
        long afterFirst = points(topId);
        jdbcClient.sql("DELETE FROM away_seasons WHERE season_no > ?").param(seasonNo).update();
        jdbcClient.sql("""
                        UPDATE away_seasons SET state = 'ACTIVE', closed_at = NULL, ends_at = ?
                        WHERE season_no = ?
                        """)
                .params(java.time.Instant.now().minusSeconds(60).toString(), seasonNo)
                .update();
        seasonService.sweepDueSeasons();
        assertThat(points(topId)).as("같은 시즌을 다시 닫아도 보상은 한 번이다").isEqualTo(afterFirst);
    }

    /**
     * <b>아무도 안 논 주는 아무것도 지급하지 않는다.</b>
     *
     * <p>밀린 시즌 정산이 이 설계의 존재 이유인데(서버가 꺼져 있어도 보상이 사라지지 않게), 바로 그
     * 경로에서 금액이 틀렸다 — 참가 판정에 <b>상한</b>이 없어 창이 과거인 시즌을 닫을 때 그 이후에
     * 생긴 원장까지 참가로 잡혔다. 실측으로 1판이 20만 포인트를 발행했다(독립검증 BLK-1).
     */
    @Test
    void backlogSeasonsPayNothingForWeeksNobodyPlayed() {
        setupUserWithDeck("v2_backlog_def");
        String defenderId = userIdOf("v2_backlog_def");
        setupUserWithDeck("v2_backlog_atk");
        String attackerId = userIdOf("v2_backlog_atk");
        settleWin(attackerId, defenderId, "M_BL1");   // 경기는 **지금** 있었다

        long rewardsBefore = seasonRewardsIssued();
        int firstSeason = seasonService.current().seasonNo();

        // ⚠️ 창을 **과거로** 밀어 놓는다 — 지금 한 경기는 그 창 **밖**이다. 상한이 없으면 이 경기가
        // 지나간 주들에 전부 참가로 잡혀 빈 주에도 순위 보상이 나간다(독립검증에서 20만 포인트 실측).
        // 픽스처가 경기를 과거로 밀면(초판이 그랬다) 하한이 먼저 걸러서 **상한은 한 번도 일하지 않는다**.
        jdbcClient.sql("""
                        UPDATE away_seasons
                        SET started_at = datetime('now', '-28 days'), ends_at = datetime('now', '-21 days')
                        WHERE state = 'ACTIVE'
                        """)
                .update();
        assertThat(seasonService.sweepDueSeasons()).isGreaterThan(1);   // 여러 주가 밀렸다

        // ⚠️ 단언은 **첫 backlog 창(-28d~-21d)** 으로 좁힌다. 체인은 결국 "지금"을 품는 창까지
        // 이어지므로(그 창의 참가는 정상이다) 전역 합계로는 판정할 수 없다. 이 창은 우리 경기보다
        // 3주 앞이라 상한이 없으면 우리 경기가 여기에 잡힌다.
        assertThat(jdbcClient.sql("""
                        SELECT COUNT(*) FROM away_season_results
                        WHERE season_no = ? AND user_id IN (?, ?)
                        """)
                        .params(firstSeason, attackerId, defenderId).query(Long.class).single())
                .as("3주 전 창에 오늘 경기가 잡히면 아무도 안 논 주에 순위 보상이 나간다")
                .isZero();
        assertThat(rewardsBefore).isNotNegative();
    }

    /**
     * <b>시즌 순위는 그 시즌에 일어난 일로 정한다.</b> 참가만 창으로 자르고 순위를 현재 누적
     * 레이팅으로 매기면, 앞 시즌 마감이 레이팅을 0 으로 지운 뒤엔 전원 동점이라 tie-break(user_id =
     * ULID = 가입 순)가 순위를 정한다 — 실측에서 <b>3패한 유저가 1위, 3승한 유저가 2위</b>였다.
     */
    @Test
    void seasonRankReflectsThatSeasonsResults() {
        setupUserWithDeck("v2_rank_win");
        String winnerId = userIdOf("v2_rank_win");
        setupUserWithDeck("v2_rank_lose");
        String loserId = userIdOf("v2_rank_lose");
        // 승자가 이 시즌에 이겼다(공격자 WIN = 수비자 LOSS).
        settleWin(winnerId, loserId, "M_RK1");
        settleWin(winnerId, loserId, "M_RK2");
        // 누적 레이팅을 **거꾸로** 심는다 — 순위가 그걸 본다면 진 쪽이 1위가 된다.
        setRating(winnerId, 0);
        setRating(loserId, 9999);

        int seasonNo = seasonService.current().seasonNo();
        expireSeason();
        seasonService.sweepDueSeasons();

        int winnerRank = jdbcClient.sql(
                        "SELECT rank FROM away_season_results WHERE season_no = ? AND user_id = ?")
                .params(seasonNo, winnerId).query(Integer.class).single();
        int loserRank = jdbcClient.sql(
                        "SELECT rank FROM away_season_results WHERE season_no = ? AND user_id = ?")
                .params(seasonNo, loserId).query(Integer.class).single();
        assertThat(winnerRank)
                .as("그 시즌에 이긴 쪽이 위여야 한다 — 누적값이나 가입 순서가 순위를 정하면 안 된다")
                .isLessThan(loserRank);
    }

    /**
     * <b>무승부만 한 유저도 시즌에 남는다.</b> 참가를 "레이팅이 움직였는가"로 물으면 무승부는
     * 원장 행이 없어 통째로 사라진다 — 참가상도 스냅샷도 히스토리도 0(독립검증 MAJ-A 실측).
     */
    @Test
    void drawOnlyParticipantStillCountsForTheSeason() {
        setupUserWithDeck("v2_drawonly_def");
        String defenderId = userIdOf("v2_drawonly_def");
        setupUserWithDeck("v2_drawonly_atk");
        String attackerId = userIdOf("v2_drawonly_atk");

        seedChallenge(attackerId, defenderId, "M_DO1");
        awayService.settle("M_DO1", attackerId, "DRAW", 1, 1);
        // 무승부라 레이팅 원장은 비어 있다 — 그래도 경기는 있었다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM rating_ledger WHERE ref_id = 'M_DO1'")
                .query(Long.class).single()).isZero();

        long before = points(attackerId);
        expireSeason();
        seasonService.sweepDueSeasons();

        assertThat(jdbcClient.sql(
                        "SELECT COUNT(*) FROM away_season_results WHERE user_id IN (?, ?)")
                .params(attackerId, defenderId).query(Long.class).single())
                .as("비기기만 한 유저가 시즌에서 사라지면 안 된다(양쪽 다)")
                .isEqualTo(2);
        assertThat(points(attackerId) - before).as("참가상은 나가야 한다").isPositive();
    }

    /** 바디 없는 원정 생성도 **밴드**를 쓴다 — 여기만 전체 풀을 쓰면 담합 방어의 근거가 무너진다. */
    @Test
    void bodylessStartAlsoRespectsTheBand() {
        String attacker = setupUserWithDeck("v2_body_atk");
        String attackerId = userIdOf("v2_body_atk");
        setRating(attackerId, 0);
        setupOpponentWithDeck("v2_body_near");
        setRating(userIdOf("v2_body_near"), 20);
        setupOpponentWithDeck("v2_body_far");
        setRating(userIdOf("v2_body_far"), 100000);
        // ⚠️ 후보 풀을 **이 셋으로 좁힌다**. 안 좁히면 다른 테스트가 만든 유저가 수십 명 섞여
        // 먼 상대가 뽑힐 확률이 낮아지고, 밴드를 없애는 변이가 그냥 통과한다(초판이 그랬다).
        jdbcClient.sql("UPDATE decks SET is_active = 0 WHERE user_id NOT IN (?, ?, ?)")
                .params(attackerId, userIdOf("v2_body_near"), userIdOf("v2_body_far")).update();
        try {
            for (int i = 0; i < 8; i++) {
                releaseActiveMatches();
                ResponseEntity<Map> res = authPost("/api/away/matches", attacker, Map.of(), Map.class);
                assertThat(res.getStatusCode()).isEqualTo(HttpStatus.CREATED);
                String defender = jdbcClient.sql("SELECT defender_id FROM away_challenges WHERE match_id = ?")
                        .param((String) res.getBody().get("id")).query(String.class).single();
                assertThat(defender)
                        .as("레이팅 10만짜리가 걸리면 밴드가 우회됐다는 뜻이다 (시도 %d)", i + 1)
                        .isNotEqualTo(userIdOf("v2_body_far"));
            }
        } finally {
            jdbcClient.sql("UPDATE decks SET is_active = 1 WHERE user_id NOT IN (?, ?, ?)")
                    .params(attackerId, userIdOf("v2_body_near"), userIdOf("v2_body_far")).update();
            releaseActiveMatches();
        }
    }

    /** 제시는 **세울 수 있는 팀만** — 2택은 폴백이 없어 고르는 순간 남의 덱 오류가 내 오류로 뜬다. */
    @Test
    void brokenDeckCandidatesAreNotOffered() {
        setupOpponentWithDeck("v2_broken_cand");
        String brokenId = userIdOf("v2_broken_cand");
        setupOpponentWithDeck("v2_ok_cand");
        String attacker = setupUserWithDeck("v2_pick_atk");
        String attackerId = userIdOf("v2_pick_atk");
        jdbcClient.sql("UPDATE decks SET is_active = 0 WHERE user_id NOT IN (?, ?, ?)")
                .params(brokenId, userIdOf("v2_ok_cand"), attackerId).update();
        jdbcClient.sql("DELETE FROM deck_slots WHERE deck_id IN (SELECT id FROM decks WHERE user_id = ?)")
                .param(brokenId).update();
        try {
            for (int i = 0; i < 5; i++) {
                assertThat(awayService.offerCandidates(attackerId))
                        .as("덱이 깨진 상대를 제시하면 유저가 고르는 순간 자기 덱 오류로 보인다")
                        .noneMatch(c -> c.userId().equals(brokenId));
            }
        } finally {
            jdbcClient.sql("UPDATE decks SET is_active = 1 WHERE user_id NOT IN (?, ?, ?)")
                    .params(brokenId, userIdOf("v2_ok_cand"), attackerId).update();
        }
        assertThat(attacker).isNotNull();
    }

    /** 다음 시즌은 **직전 종료 시각**부터 — "지금"부터 열면 밀린 주가 통째로 사라진다. */
    @Test
    void nextSeasonStartsWhereThePreviousEnded() {
        jdbcClient.sql("""
                        UPDATE away_seasons
                        SET started_at = datetime('now', '-14 days'), ends_at = datetime('now', '-7 days')
                        WHERE state = 'ACTIVE'
                        """)
                .update();
        String closedEnd = jdbcClient.sql("SELECT ends_at FROM away_seasons WHERE state = 'ACTIVE'")
                .query(String.class).single();

        int closedNo = seasonService.current().seasonNo();
        seasonService.sweepDueSeasons();

        String nextStart = jdbcClient.sql("SELECT started_at FROM away_seasons WHERE season_no = ?")
                .param(closedNo + 1).query(String.class).single();
        // 두 값의 포맷이 다를 수 있으므로(마이그레이션은 ISO, 테스트는 SQLite) 정규화해 비교한다.
        String normalizedNext = jdbcClient.sql("SELECT datetime(?)").param(nextStart)
                .query(String.class).single();
        String normalizedClosed = jdbcClient.sql("SELECT datetime(?)").param(closedEnd)
                .query(String.class).single();
        assertThat(normalizedNext)
                .as("이어 붙지 않으면 서버가 꺼져 있던 주가 사라진다")
                .isEqualTo(normalizedClosed);
    }

    /**
     * 하루 원정 횟수 제한(hero 결정) — 소진되면 **429 AWAY_DAILY_LIMIT**, 남은 횟수는 후보 응답에
     * 미리 실린다(눌렀는데 거부되는 UX 방지).
     */
    @SuppressWarnings("unchecked")
    @Test
    void dailyLimitStopsFurtherRaidsAndIsVisibleBeforePressing() {
        setupOpponentWithDeck("v2_limit_def");
        String attacker = setupUserWithDeck("v2_limit_atk");
        String attackerId = userIdOf("v2_limit_atk");

        int limit = Integer.parseInt(dailyLimitProp);
        assertThat(limit).as("이 계약은 제한이 켜져 있을 때만 의미가 있다").isPositive();

        ResponseEntity<Map> before = authGet("/api/away/candidates", attacker, Map.class);
        assertThat((Integer) before.getBody().get("remainingToday")).isEqualTo(limit);

        for (int i = 0; i < limit; i++) {
            releaseActiveMatches();
            assertThat(authPost("/api/away/matches", attacker, Map.of(), Map.class).getStatusCode())
                    .as("제한 안에서는 계속 갈 수 있어야 한다 (%d번째)", i + 1)
                    .isEqualTo(HttpStatus.CREATED);
        }
        releaseActiveMatches();

        // 소진 — 화면이 먼저 안다.
        ResponseEntity<Map> after = authGet("/api/away/candidates", attacker, Map.class);
        assertThat((Integer) after.getBody().get("remainingToday")).isZero();

        ResponseEntity<String> denied = authPost("/api/away/matches", attacker, Map.of(), String.class);
        assertThat(denied.getStatusCode()).isEqualTo(HttpStatus.TOO_MANY_REQUESTS);
        assertThat(denied.getBody()).contains("AWAY_DAILY_LIMIT");

        // ⚠️ 경계는 **KST 자정**이다. 어제 만든 원정은 오늘 횟수를 먹지 않는다 —
        // created_at(UTC 인스턴트)을 날짜 문자열과 비교하면 UTC 자정이 경계가 되어 새벽 원정이
        // 어제로 세어진다(같은 종류의 시각-문자열 버그를 이 세션에서 두 번 잡혔다).
        jdbcClient.sql("UPDATE matches SET created_at = ? WHERE user_id = ? AND mode = 'away'")
                .params(java.time.Instant.now().minusSeconds(60 * 60 * 30).toString(), attackerId)
                .update();
        ResponseEntity<Map> nextDay = authGet("/api/away/candidates", attacker, Map.class);
        assertThat((Integer) nextDay.getBody().get("remainingToday")).isEqualTo(limit);
    }

    @org.springframework.beans.factory.annotation.Value("${hmb.away.match.daily-limit}")
    private String dailyLimitProp;

    /** 같은 매치를 다시 정산해도 <b>연승이 늘지 않는다</b> — 리포트·원장만 보면 못 잡는 구멍이었다. */
    @Test
    void resettlingDoesNotInflateTheStreak() {
        setupUserWithDeck("v2_idem_def");
        String defenderId = userIdOf("v2_idem_def");
        setupUserWithDeck("v2_idem_atk");
        String attackerId = userIdOf("v2_idem_atk");

        settleWin(attackerId, defenderId, "M_IDEM");
        assertThat(awayService.streakOf(attackerId)).isEqualTo(1);

        awayService.settle("M_IDEM", attackerId, "WIN", 2, 0);
        awayService.settle("M_IDEM", attackerId, "WIN", 2, 0);
        assertThat(awayService.streakOf(attackerId))
                .as("재정산이 연승을 부풀리면 그 다음 진짜 승리의 보너스가 오염된다")
                .isEqualTo(1);
    }

    /**
     * 몰수는 <b>돈을 만들지 않는다</b> — 경기가 열리지도 않았는데 리그 승리 보상을 찍으면 두 계정이
     * 서로 만들고 무르기만 해도 시뮬 0회로 돈이 발행된다.
     *
     * <p>⚠️ 반드시 <b>실제 포기 경로</b>(POST /abandon)로 태운다. 오버로드를 직접 부르면 "그 배선이
     * false 를 넘기는가"를 검증하지 못한다 — 초판이 그렇게 써서 배선 누락을 놓쳤다.
     */
    @Test
    void forfeitGivesRatingButNoMoney() {
        setupUserWithDeck("v2_ff_def");
        String defenderId = userIdOf("v2_ff_def");
        String attacker = setupUserWithDeck("v2_ff_atk");
        String attackerId = userIdOf("v2_ff_atk");

        String matchId = startAwayPinned(attackerId, defenderId).id();
        long before = points(defenderId);
        assertThat(authPost("/api/matches/" + matchId + "/abandon", attacker, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        assertThat(points(defenderId) - before)
                .as("서로 만들고 무르기만 해도 돈이 발행되면 안 된다")
                .isZero();
        assertThat(rating(defenderId)).as("레이팅은 준다(hero D1 몰수패)").isEqualTo(10);
    }

    /**
     * <b>몰수는 시즌에 세지 않는다</b>(hero A-1). 경기가 열리지도 않았는데 리포트가 남는다는 이유로
     * 시즌 참가·연승이 되면, 두 계정이 서로 만들고 무르기만 해도 <b>시뮬 0회·AI 0회로</b> 주간 순위
     * 보상(1위 30k + 2위 20k)을 가져간다. 레이팅 ±10 은 그대로 준다(hero D1 몰수패).
     */
    @Test
    void forfeitCountsForRatingButNotForSeasonOrStreak() {
        setupUserWithDeck("v2_ffs_def");
        String defenderId = userIdOf("v2_ffs_def");
        String attacker = setupUserWithDeck("v2_ffs_atk");
        String attackerId = userIdOf("v2_ffs_atk");

        // 무르기 전에 공격자에게 연승을 만들어 둔다 — 몰수가 그걸 건드리는지 봐야 하기 때문이다.
        setupUserWithDeck("v2_ffs_prey");
        settleWin(attackerId, userIdOf("v2_ffs_prey"), "M_FFS_PRE1");
        settleWin(attackerId, userIdOf("v2_ffs_prey"), "M_FFS_PRE2");
        assertThat(awayService.streakOf(attackerId)).isEqualTo(2);
        releaseActiveMatches();

        String matchId = startAwayPinned(attackerId, defenderId).id();
        long pointsBefore = points(defenderId);
        assertThat(authPost("/api/matches/" + matchId + "/abandon", attacker, Map.of(), Map.class)
                .getStatusCode()).isEqualTo(HttpStatus.OK);

        // 레이팅은 움직이고(D1) 돈·연승은 움직이지 않는다.
        assertThat(rating(defenderId)).isEqualTo(10);
        assertThat(points(defenderId) - pointsBefore).isZero();
        // ⚠️ 수비자 연승은 새 규칙에서 **어차피 안 움직인다** — 그걸 단언하면 몰수 처리와 무관하게
        // 항상 참인 tautology 다(독립검증 지적). 몰수 가드의 실제 효과는 **공격자 쪽**에 있다:
        // 무르는 유저의 연승이 끊기지도, 열리지도 않은 경기로 쌓이지도 않는다.
        assertThat(awayService.streakOf(defenderId)).isZero();
        assertThat(awayService.streakOf(attackerId))
                .as("몰수는 연승 계산에서 **빠진다** — 쌓지도 않고 끊지도 않는다(열리지도 않은 경기다)")
                .isEqualTo(2);
        assertThat(jdbcClient.sql("SELECT forfeit FROM away_reports WHERE match_id = ?")
                .param(matchId).query(Integer.class).single()).isEqualTo(1);

        // 시즌 마감에서도 참가로 세지 않는다 — 몰수만 있는 유저는 스냅샷에 없다.
        long seasonRewardBefore = points(defenderId);
        expireSeason();
        seasonService.sweepDueSeasons();
        // ⚠️ **수비자로 좁힌다** — 공격자는 연승을 만들려고 넣은 진짜 경기 2판으로 정상 참가한다.
        // 여기서 보려는 건 "몰수**만** 있는 쪽이 시즌에 잡히는가" 다.
        assertThat(jdbcClient.sql("SELECT COUNT(*) FROM away_season_results WHERE user_id = ?")
                        .param(defenderId).query(Long.class).single())
                .as("몰수만으로 시즌 순위 보상을 받으면 시뮬 0회 수도꼭지가 된다")
                .isZero();
        assertThat(points(defenderId)).isEqualTo(seasonRewardBefore);
    }

    /**
     * 시즌 마감이 <b>다음 시즌에 이미 쌓인 레이팅까지 지우지 않는다</b>(F1).
     *
     * <p>스윕은 5분 주기라 {@code ends_at} 이후~마감 사이에 끝난 원정이 있다. 그 델타는 다음 시즌
     * 것인데 통째로 0 으로 밀면 라이브 레이팅(밴드 매칭·리더보드·화면)에서만 사라져 시즌 축과
     * 영구히 어긋난다 — 보상 금액은 맞는데 화면만 틀리고 복구 경로가 없다.
     */
    @Test
    void seasonCloseKeepsRatingEarnedAfterTheWindow() {
        setupUserWithDeck("v2_f1_def");
        String defenderId = userIdOf("v2_f1_def");
        setupUserWithDeck("v2_f1_atk");
        String attackerId = userIdOf("v2_f1_atk");

        settleWin(attackerId, defenderId, "M_F1_OLD");   // 이번 시즌 몫
        expireSeason();                                   // 창을 과거로(리포트·원장도 함께)
        settleWin(attackerId, defenderId, "M_F1_NEW");    // ⚠️ 창이 닫힌 **뒤**에 끝난 원정

        seasonService.sweepDueSeasons();

        // 기대값은 하드코딩하지 않는다 — 연승 보너스가 붙으므로 "그 판의 실제 적용값"과 대조한다.
        // ⚠️ 유저로 좁힌다 — ref_id 만으로 합하면 상대의 −10 까지 섞인다(공격자 +12, 수비자 −10 = 2).
        int newSeasonShare = jdbcClient.sql("""
                        SELECT COALESCE(SUM(delta), 0) FROM rating_ledger
                        WHERE ref_id = 'M_F1_NEW' AND user_id = ?
                        """)
                .param(attackerId).query(Integer.class).single();
        assertThat(newSeasonShare).as("창 밖 원정이 실제로 레이팅을 움직였어야 대조가 성립한다").isPositive();
        assertThat(rating(attackerId))
                .as("다음 시즌 몫까지 0 으로 밀면 그 판이 라이브 레이팅에서만 사라진다")
                .isEqualTo(newSeasonShare);
    }

    // ── 헬퍼 ────────────────────────────────────────────────────────────

    /** 제시를 심고 상대를 고정해 원정을 시작한다(hero E2 이후 지목은 제시 안에서만 된다). */
    private online.hmb.match.MatchService.MatchRow startAwayPinned(String attackerId, String defenderId) {
        jdbcClient.sql("""
                        INSERT INTO away_offers(user_id, candidates, created_at) VALUES (?, ?, ?)
                        ON CONFLICT(user_id) DO UPDATE SET
                          candidates = excluded.candidates, created_at = excluded.created_at
                        """)
                .params(attackerId, "[\"" + defenderId + "\"]", java.time.Instant.now().toString())
                .update();
        return awayService.start(attackerId, defenderId);
    }

    private long seasonRewardsIssued() {
        return jdbcClient.sql(
                        "SELECT COALESCE(SUM(delta), 0) FROM point_ledger WHERE reason = 'season_reward'")
                .query(Long.class).single();
    }

    /**
     * 진행 중 시즌을 만료시킨다. ⚠️ 마이그레이션이 심은 값을 <b>ISO 로 덮어쓰지 않는다</b> —
     * 초판 테스트가 그렇게 해서 "V22 가 심은 값을 서비스가 못 읽는다"는 blocker 를 통째로 가렸다
     * (615개 테스트가 green 인데 실배포에선 시즌이 영원히 안 닫혔다). 여기서는 SQLite 자신의
     * 포맷으로 과거로 민다 — 서비스가 그 값도 읽을 수 있어야 한다.
     */
    private void expireSeason() {
        // 정산은 시즌 **창을 잘라** 참가자를 본다 → 경기가 창 안에 있어야 한다. 테스트가 만든 원정은
        // "방금"이므로 창보다 뒤에 있게 된다 — 경기를 과거로 밀어 넣고 창을 그 뒤로 닫는다.
        jdbcClient.sql("""
                        UPDATE away_reports SET created_at = datetime('now', '-2 hours')
                        WHERE datetime(created_at) > datetime('now', '-2 hours')
                        """)
                .update();
        // 점수도 창으로 잘리므로(순위 = 그 시즌 변동 합) 원장도 같이 밀어야 한다 — 리포트만 밀면
        // 참가는 잡히는데 점수가 0 이 되어 "참가했는데 0점"이라는 없는 상황이 만들어진다.
        jdbcClient.sql("""
                        UPDATE rating_ledger SET created_at = datetime('now', '-2 hours')
                        WHERE datetime(created_at) > datetime('now', '-2 hours')
                        """)
                .update();
        jdbcClient.sql("""
                        UPDATE away_seasons
                        SET started_at = datetime('now', '-1 day'), ends_at = datetime('now', '-1 hour')
                        WHERE state = 'ACTIVE'
                        """)
                .update();
    }



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
