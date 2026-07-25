package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import jakarta.annotation.Resource;
import java.util.List;
import java.util.Map;
import java.util.Set;
import online.hmb.growth.GrowthService;
import online.hmb.meta.WalletService;
import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.SpringBootTest.WebEnvironment;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;

/**
 * GrowthService 성장·강화 계산·정산 검증(#179 §2~§4). 로그인으로 온보딩(지갑+스타터 user_players)한 뒤
 * user_players 를 SQL 로 조작하고 서비스를 직접 호출한다.
 *
 * <p>테스트 픽스처 P001 = GK/BRONZE, attrs {technical:40..positioning:48}. BRONZE 밴드 [40,55].
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthServiceTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
    }

    @Resource
    private GrowthService growthService;

    @Resource
    private WalletService walletService;

    // ── §2 유효스탯 계산 ─────────────────────────────────────────────────

    @Test
    void freshCardEqualsBase_noGrowthNoEnhance_regressionSafe() {
        String userId = onboard("g_fresh");
        Map<String, Object> card = growthService.cardEffective(userId, "P001");

        assertThat(card.get("baseGrade")).isEqualTo("BRONZE");
        assertThat(card.get("effectiveGrade")).isEqualTo("BRONZE");
        // 성장 0 → 유효스탯 == 밴드 내 원본(무회귀: SelectData 주입이 원본과 동일해야 리플레이 bit-identical).
        Map<?, ?> attributes = (Map<?, ?>) card.get("attributes");
        Map<?, ?> base = (Map<?, ?>) card.get("base");
        assertThat(attributes).isEqualTo(base);
        assertThat(((Number) card.get("completion")).doubleValue()).isEqualTo(0.0);
        // caps = BRONZE 밴드 상한 55.
        assertThat(((Map<?, ?>) card.get("caps")).values()).allMatch(v -> ((Number) v).intValue() == 55);
    }

    @Test
    void effectiveAttributesMatchBaseForZeroGrowth() {
        String userId = onboard("g_eff");
        // 원본과 값이 동일해야 함(무회귀 가드).
        Map<String, Object> eff = growthService.effectiveAttributes(userId, "P001", Map.of("shooting", 999));
        assertThat(eff.get("positioning")).isEqualTo(48);
        assertThat(eff.get("technical")).isEqualTo(40);
    }

    @Test
    void growthRaisesTopWeightedStatTowardCap() {
        String userId = onboard("g_grow");
        double freshOvr = ((Number) growthService.cardEffective(userId, "P001").get("ovr")).doubleValue();

        setGrowthLevel(userId, "P001", 10); // g = clamp(10/7.2) = 1.0 → 최상위 가중치 스탯이 천장 도달

        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        Map<?, ?> attrs = (Map<?, ?>) card.get("attributes");
        // GK 최상위 방향 = positioning(가중치 0.24) → 천장 55 도달. mental(0.20) 은 부분 상승.
        assertThat(((Number) attrs.get("positioning")).intValue()).isEqualTo(55);
        assertThat(((Number) attrs.get("mental")).intValue()).isGreaterThan(41).isLessThanOrEqualTo(55);
        // 완성도·OVR 상승.
        assertThat(((Number) card.get("completion")).doubleValue()).isGreaterThan(0.0);
        assertThat(((Number) card.get("ovr")).doubleValue()).isGreaterThan(freshOvr);
    }

    @Test
    void allStatsClampedToBandCap() {
        String userId = onboard("g_clamp");
        setGrowthLevel(userId, "P001", 999);
        setEnhance(userId, "P001", 5); // enhanceFill 도 더해도 cap 초과 금지
        Map<?, ?> attrs = (Map<?, ?>) growthService.cardEffective(userId, "P001").get("attributes");
        assertThat(attrs.values()).allMatch(v -> ((Number) v).intValue() <= 55);
    }

    // ── §3 강화 / 한계돌파 ───────────────────────────────────────────────

    @Test
    void enhanceConsumesCopyAndPointsRaisesLevel() {
        String userId = onboard("g_enh");
        setCount(userId, "P001", 3);
        long pointsBefore = walletService.points(userId);

        Map<String, Object> res = growthService.enhance(userId, "P001");
        assertThat(res.get("enhanceLevel")).isEqualTo(1);
        assertThat(res.get("promoted")).isEqualTo(false);
        assertThat(((Map<?, ?>) res.get("spent")).get("points")).isEqualTo(200);
        assertThat(walletService.points(userId)).isEqualTo(pointsBefore - 200);
        assertThat(countOf(userId, "P001")).isEqualTo(2); // 중복 1 소모
    }

    @Test
    void limitBreakPromotesGradeAndReopensEnhanceCap() {
        String userId = onboard("g_lb");
        setCount(userId, "P001", 5);
        // 강화를 상한(5)까지: 카운트 부족 방지 위해 count 를 넉넉히.
        setCount(userId, "P001", 20);
        for (int i = 0; i < 5; i++) {
            growthService.enhance(userId, "P001");
        }
        // 상한 도달 → 추가 강화 4xx.
        assertThat(catchStatus(() -> growthService.enhance(userId, "P001"))).isEqualTo("ENHANCE_MAX");

        Map<String, Object> lb = growthService.limitBreak(userId, "P001");
        assertThat(lb.get("promoted")).isEqualTo(true);
        assertThat(lb.get("limitBreak")).isEqualTo(1);
        assertThat(lb.get("effectiveGrade")).isEqualTo("SILVER"); // BRONZE + 돌파1

        // 등급 개방 → cap 65, 강화 상한 재개방(→10) → 다시 강화 가능.
        Map<?, ?> card = (Map<?, ?>) growthService.cardEffective(userId, "P001");
        assertThat(((Map<?, ?>) card.get("caps")).values()).allMatch(v -> ((Number) v).intValue() == 65);
        Map<String, Object> again = growthService.enhance(userId, "P001");
        assertThat(again.get("enhanceLevel")).isEqualTo(6);
    }

    @Test
    void enhanceInsufficientCopiesRejected() {
        String userId = onboard("g_nocopy");
        setCount(userId, "P001", 0);
        assertThat(catchStatus(() -> growthService.enhance(userId, "P001"))).isEqualTo("INSUFFICIENT_MATERIALS");
    }

    @Test
    void limitBreakInsufficientCopiesRejected() {
        String userId = onboard("g_nolb");
        setCount(userId, "P001", 2); // 필요 3
        assertThat(catchStatus(() -> growthService.limitBreak(userId, "P001"))).isEqualTo("INSUFFICIENT_MATERIALS");
    }

    // ── §4 성장 정산 멱등 ────────────────────────────────────────────────

    @Test
    void settleMatchIsIdempotent_sameMatchAppliedOnce() {
        String token = setupUserWithDeck("g_settle");
        String userId = userIdOf("g_settle");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");

        List<String> starters = List.of("P001", "P002", "P003", "P004", "P005",
                "P006", "P007", "P008", "P009", "P010", "P011");
        List<String> bench = List.of("P012", "P013");

        growthService.settleMatch(matchId, userId, starters, bench, Set.of(), Set.of());
        long applied1 = appliedCount(matchId);
        int starterXp1 = xpOf(userId, "P001");
        int benchXp1 = xpOf(userId, "P012");

        assertThat(applied1).isEqualTo(13); // 11 선발 + 2 벤치
        assertThat(starterXp1).isGreaterThan(0);
        // 선발(minutesMult 1.0) > 미출전 벤치(benchGrowthMult 0.2).
        assertThat(starterXp1).isGreaterThan(benchXp1);

        // 재정산 → growth_applied 중복 무시(멱등), xp 변화 없음.
        growthService.settleMatch(matchId, userId, starters, bench, Set.of(), Set.of());
        assertThat(appliedCount(matchId)).isEqualTo(13);
        assertThat(xpOf(userId, "P001")).isEqualTo(starterXp1);
        assertThat(xpOf(userId, "P012")).isEqualTo(benchXp1);
    }

    @SuppressWarnings("unchecked")
    @Test
    void settlementFeedsGrowthReport() {
        String token = setupUserWithDeck("g_report");
        String userId = userIdOf("g_report");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");
        growthService.settleMatch(matchId, userId, List.of("P001"), List.of(), Set.of(), Set.of());

        Map<String, Object> report = growthService.growthReport(userId, matchId);
        assertThat(report.get("matchId")).isEqualTo(matchId);
        List<?> entries = (List<?>) report.get("entries");
        assertThat(entries).hasSize(1);
        Map<?, ?> e = (Map<?, ?>) entries.get(0);
        assertThat(e.get("playerId")).isEqualTo("P001");
        assertThat(((Number) e.get("xpDelta")).intValue()).isGreaterThan(0);
        assertThat(((Number) e.get("ovrAfter")).doubleValue())
                .isGreaterThanOrEqualTo(((Number) e.get("ovrBefore")).doubleValue());
        assertThat((List<String>) e.get("topAttrs")).contains("positioning"); // GK 방향 상위
    }

    // ── 헬퍼 ──────────────────────────────────────────────────────────────

    private String onboard(String nickname) {
        login(nickname); // 스타터 팩 지급(user_players + wallet)
        return userIdOf(nickname);
    }

    private void setGrowthLevel(String userId, String playerId, int level) {
        jdbcClient.sql("UPDATE user_players SET growth_level = ?, match_xp = ? WHERE user_id=? AND player_id=?")
                .params(level, level * 300, userId, playerId).update();
    }

    private void setEnhance(String userId, String playerId, int level) {
        jdbcClient.sql("UPDATE user_players SET enhance_level = ? WHERE user_id=? AND player_id=?")
                .params(level, userId, playerId).update();
    }

    private void setCount(String userId, String playerId, int count) {
        jdbcClient.sql("UPDATE user_players SET count = ? WHERE user_id=? AND player_id=?")
                .params(count, userId, playerId).update();
    }

    private int countOf(String userId, String playerId) {
        return jdbcClient.sql("SELECT count FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    private int xpOf(String userId, String playerId) {
        return jdbcClient.sql("SELECT match_xp FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    private long appliedCount(String matchId) {
        return jdbcClient.sql("SELECT COUNT(*) FROM growth_applied WHERE match_id=?")
                .param(matchId).query(Long.class).single();
    }

    private String catchStatus(Runnable r) {
        try {
            r.run();
            return "NO_ERROR";
        } catch (online.hmb.common.ApiException e) {
            return e.getCode();
        }
    }
}
