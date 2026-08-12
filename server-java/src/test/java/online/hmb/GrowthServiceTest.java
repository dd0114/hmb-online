package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

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
 * GrowthService — 메이플 피벗 V2 계산·정산 검증(에픽 #179 §V2-2~V2-4). 로그인으로 온보딩(지갑+스타터
 * user_players)한 뒤 user_players/card_potentials/user_dice 를 SQL 로 조작하고 서비스를 직접 호출한다.
 *
 * <p>테스트 픽스처 P001 = GK/BRONZE, attrs {technical:40..positioning:48}. BRONZE 밴드 [40,55].
 * P010/P011 = GOLD/MF, P016 = LEGEND/FW, P017 = DIA/FW (AC-V5 캡 매트릭스).
 */
@SpringBootTest(webEnvironment = WebEnvironment.RANDOM_PORT)
class GrowthServiceTest extends MatchTestBase {

    @DynamicPropertySource
    static void props(DynamicPropertyRegistry registry) {
        TestDbSupport.registerTempDb(registry);
        // #493 W6-v3: 이 테스트의 주제는 튜토리얼이 아니다 — 가입 무료 쿠폰을 끄고
        // 과금·롤을 '출발 상태 그대로' 본다(TestDbSupport.disableTutorialStarter javadoc).
        TestDbSupport.disableTutorialStarter(registry);
    }

    @Resource
    private GrowthService growthService;

    @Resource
    private WalletService walletService;

    /** #247: 롤 비용의 SoT — 테스트도 상수를 심지 않고 서버와 같은 스냅샷을 읽는다. */
    @Resource
    private online.hmb.catalog.EconomyService economyService;

    private long normalRollCost() {
        return economyService.get().orElseThrow().dice().normalCost();
    }

    private long cashRollCost() {
        return economyService.get().orElseThrow().dice().cashGemCost();
    }

    // ── V2-2 유효스탯 계산 (무회귀) ──────────────────────────────────────

    @Test
    void freshCardEqualsBase_noGrowthNoPotential_regressionSafe() {
        String userId = onboard("g_fresh");
        Map<String, Object> card = growthService.cardEffective(userId, "P001");

        assertThat(card.get("grade")).isEqualTo("BRONZE");
        assertThat(card.get("star")).isEqualTo(1);
        // 성장·잠재 0 → 유효스탯 == 밴드 내 원본(무회귀: SelectData 주입이 원본과 동일해야 리플레이 bit-identical).
        Map<?, ?> attributes = (Map<?, ?>) card.get("attributes");
        Map<?, ?> base = (Map<?, ?>) card.get("base");
        assertThat(((Number) attributes.get("positioning")).doubleValue())
                .isEqualTo(((Number) base.get("positioning")).doubleValue());
        assertThat(((Number) card.get("completion")).doubleValue()).isEqualTo(0.0);
        assertThat(((Map<?, ?>) card.get("potential")).get("unlocked")).isEqualTo(false);
    }

    @Test
    void effectiveAttributesMatchBaseForZeroGrowth() {
        String userId = onboard("g_eff");
        Map<String, Object> eff = growthService.effectiveAttributes(userId, "P001", Map.of("shooting", 999));
        assertThat(((Number) eff.get("positioning")).doubleValue()).isEqualTo(48.0);
        assertThat(((Number) eff.get("technical")).doubleValue()).isEqualTo(40.0);
    }

    /**
     * ⚠️ 이 테스트는 <b>#405 W2a 로 기대값이 바뀌었다</b>. 구 모델은
     * {@code cap = base + starFrac[star] × (band.hi − base)} 라 2★ P001 의 positioning 천장이
     * 51.5 였다(밴드 여백의 절반). 신규 모델은 {@code growCeil[BRONZE](72) + star.ceilBonus[2](1)}
     * = <b>73</b> — 성장 천장이 base 와 무관해지고 승급은 보너스만 준다(설계 §2.6).
     */
    @Test
    void statLevelRaisesAttributeAndClampsAtTheGrowthCeiling() {
        String userId = onboard("g_grow");
        setStar(userId, "P001", 2);
        setStatAdd(userId, "P001", "positioning", 999);

        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        Map<?, ?> attrs = (Map<?, ?>) card.get("attributes");
        assertThat(((Number) attrs.get("positioning")).doubleValue()).isEqualTo(73.0);
        assertThat(((Number) card.get("completion")).doubleValue()).isGreaterThan(0.0);
    }

    @Test
    void allStatsClampedToTheGrowthCeiling() {
        String userId = onboard("g_clamp");
        setStar(userId, "P001", 1); // 1★ 도 등급 천장까지 간다(승급 게이트 없음)
        for (String stat : List.of("technical", "mental", "physical", "passing", "shooting",
                "tackling", "pace", "stamina", "positioning")) {
            setStatAdd(userId, "P001", stat, 999);
        }
        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        Map<?, ?> attrs = (Map<?, ?>) card.get("attributes");
        Map<?, ?> caps = (Map<?, ?>) card.get("caps");
        for (Object key : attrs.keySet()) {
            assertThat(((Number) attrs.get(key)).doubleValue())
                    .isEqualTo(((Number) caps.get(key)).doubleValue());
        }
    }

    @Test
    void potentialFlatThenPctAppliesOnTopOfPrePotential() {
        String userId = onboard("g_pot");
        setStar(userId, "P001", 2);
        insertPotential(userId, "P001", "RARE", 0,
                """
                [{"slot":1,"tier":"RARE","type":"STAT_FLAT","stat":"positioning","value":2},
                 {"slot":2,"tier":"RARE","type":"STAT_PCT","stat":"positioning","value":10}]
                """);
        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        Map<?, ?> attrs = (Map<?, ?>) card.get("attributes");
        Map<?, ?> pre = (Map<?, ?>) card.get("prePotential");
        // prePotential(lv0) = base 48. eff = (48+2) * 1.10 = 55.0
        assertThat(((Number) pre.get("positioning")).doubleValue()).isEqualTo(48.0);
        assertThat(((Number) attrs.get("positioning")).doubleValue()).isEqualTo(55.0);
    }

    // ── AC-V5 등급×성 캡 매트릭스 ────────────────────────────────────────

    @Test
    void capMatrix_bronze2Star_rareOneLine() {
        String userId = onboard("g_cap_bronze");
        setCount(userId, "P001", 3); // B1: 여분 2장 + 원본 1장(원본은 절대 소모 안 됨)
        growthService.starUp(userId, "P001"); // 1★→2★
        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        Map<?, ?> potential = (Map<?, ?>) card.get("potential");
        assertThat(potential.get("maxTier")).isEqualTo("RARE");
        assertThat(potential.get("unlocked")).isEqualTo(true);
    }

    @Test
    void capMatrix_gold4Star_epicTwoLines() {
        String userId = onboard("g_cap_gold");
        setCount(userId, "P010", 20); // GOLD/MF
        starUpTo(userId, "P010", 4);
        Map<String, Object> card = growthService.cardEffective(userId, "P010");
        Map<?, ?> potential = (Map<?, ?>) card.get("potential");
        assertThat(card.get("grade")).isEqualTo("GOLD");
        assertThat(potential.get("maxTier")).isEqualTo("EPIC"); // min(gradeCap=EPIC, starCap[4]=UNIQUE) = EPIC
        // 잠재 줄 수(linesByGrade) — 다이스 롤 후 lines 길이로 확인.
        setWallet(userId, 20_000, 0);
        Map<String, Object> roll = growthService.dice(userId, "P010", "NORMAL");
        assertThat((List<?>) roll.get("lines")).hasSize(2);
    }

    @Test
    void capMatrix_dia4Star_uniqueThreeLines() {
        String userId = onboard("g_cap_dia");
        setCount(userId, "P017", 20); // DIA/FW
        starUpTo(userId, "P017", 4);
        Map<String, Object> card = growthService.cardEffective(userId, "P017");
        Map<?, ?> potential = (Map<?, ?>) card.get("potential");
        assertThat(card.get("grade")).isEqualTo("DIA");
        assertThat(potential.get("maxTier")).isEqualTo("UNIQUE"); // min(UNIQUE, UNIQUE)
        setWallet(userId, 20_000, 0);
        Map<String, Object> roll = growthService.dice(userId, "P017", "NORMAL");
        assertThat((List<?>) roll.get("lines")).hasSize(3);
    }

    // ── 성★ 승급 ─────────────────────────────────────────────────────────

    @Test
    void starUpConsumesCopiesAndUnlocksPotentialAt2Star() {
        String userId = onboard("g_star");
        setCount(userId, "P001", 5);
        Map<String, Object> res = growthService.starUp(userId, "P001");
        assertThat(res.get("star")).isEqualTo(2);
        assertThat(res.get("spentCopies")).isEqualTo(2);
        assertThat(res.get("potentialUnlocked")).isEqualTo(true);
        assertThat(res.get("maxTier")).isEqualTo("RARE");
        assertThat(countOf(userId, "P001")).isEqualTo(3);

        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        assertThat(((Map<?, ?>) card.get("potential")).get("unlocked")).isEqualTo(true);
    }

    @Test
    void starUpInsufficientCopiesRejected() {
        String userId = onboard("g_star_no");
        setCount(userId, "P001", 1); // 필요 2
        assertThat(catchStatus(() -> growthService.starUp(userId, "P001"))).isEqualTo("INSUFFICIENT_MATERIALS");
    }

    @Test
    void starUpBeyond4Rejected() {
        String userId = onboard("g_star_max");
        setCount(userId, "P001", 20);
        starUpTo(userId, "P001", 4);
        assertThat(catchStatus(() -> growthService.starUp(userId, "P001"))).isEqualTo("STAR_MAX");
    }

    // ── 다이스 (AC-V3 랙칫·천장·시드 재현) ──────────────────────────────

    @Test
    void diceRequiresPotentialUnlocked() {
        String userId = onboard("g_dice_locked");
        // 잔액은 충분히 채워 둔다 — 잠금 판정이 "돈이 없어서" 통과하는 가짜 green 을 막는다.
        setWallet(userId, 100_000, 100_000);
        assertThat(catchStatus(() -> growthService.dice(userId, "P001", "NORMAL")))
                .isEqualTo("POTENTIAL_LOCKED");
    }

    /**
     * #247: 구매 단계가 사라졌으므로 부족 코드도 <b>다이스</b>가 아니라 <b>재화</b> 기준이다.
     * 잔액이 롤 비용보다 1 모자라면 거절되고 <b>잠재는 손대지 않는다</b>(같은 트랜잭션).
     */
    @Test
    void diceRejectedWhenPointsBelowRollCost_andPotentialUntouched() {
        String userId = onboard("g_dice_poor");
        setCount(userId, "P001", 3); // B1: 여분 2장 + 원본 1장(원본은 절대 소모 안 됨)
        growthService.starUp(userId, "P001");
        long cost = normalRollCost();
        setWallet(userId, cost - 1, 0);

        assertThat(catchStatus(() -> growthService.dice(userId, "P001", "NORMAL")))
                .isEqualTo("INSUFFICIENT_POINTS");
        assertThat(walletService.points(userId)).isEqualTo(cost - 1); // 롤백
        // 잠재 줄이 하나도 생기지 않았다 — 실패한 롤이 리롤을 반쯤 저지르면 안 된다.
        assertThat((List<?>) ((Map<?, ?>) growthService.cardEffective(userId, "P001").get("potential"))
                .get("lines")).isEmpty();
    }

    /** 유료 롤(CASH)은 유상재화로만 결제한다 — 무료재화가 아무리 많아도 부족은 부족이다. */
    @Test
    void diceCashRejectedWhenGemsBelowRollCost_evenWithPlentyOfPoints() {
        String userId = onboard("g_dice_poor_gem");
        setCount(userId, "P001", 3);
        growthService.starUp(userId, "P001");
        setWallet(userId, 1_000_000, cashRollCost() - 1);

        assertThat(catchStatus(() -> growthService.dice(userId, "P001", "CASH")))
                .isEqualTo("INSUFFICIENT_GEMS");
        assertThat(walletService.points(userId)).isEqualTo(1_000_000L); // 무료재화는 건드리지 않는다
    }

    @Test
    void diceChargesRollCostFromWalletAndPersistsLines() {
        String userId = onboard("g_dice_ok");
        setCount(userId, "P001", 3); // B1: 여분 2장 + 원본 1장(원본은 절대 소모 안 됨)
        growthService.starUp(userId, "P001");
        long cost = normalRollCost();
        setWallet(userId, 20_000, 6_000);

        Map<String, Object> roll = growthService.dice(userId, "P001", "NORMAL");
        assertThat(roll.get("tierBefore")).isEqualTo("RARE");
        // BRONZE 카드는 maxTier RARE == 현재 티어 → 절대 승급 못함(캡 매트릭스와 정합).
        assertThat(roll.get("tierAfter")).isEqualTo("RARE");
        assertThat(roll.get("tierUp")).isEqualTo(false);
        assertThat((List<?>) roll.get("lines")).hasSize(1);
        // 재고 개념이 사라졌다 — diceLeft 대신 지갑이 응답에 실린다(#247, #232 "재화를 정하는 쪽이 잔액도 준다").
        assertThat(roll).doesNotContainKey("diceLeft");
        Map<?, ?> wallet = (Map<?, ?>) roll.get("wallet");
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(20_000L - cost);
        assertThat(((Number) wallet.get("gems")).longValue()).isEqualTo(6_000L); // 무료 롤은 유상재화 무접촉
        assertThat(walletService.points(userId)).isEqualTo(20_000L - cost);

        Map<String, Object> card = growthService.cardEffective(userId, "P001");
        assertThat((List<?>) ((Map<?, ?>) card.get("potential")).get("lines")).hasSize(1);
    }

    @Test
    void diceCashChargesGemsNotPoints() {
        String userId = onboard("g_dice_cash");
        setCount(userId, "P001", 3);
        growthService.starUp(userId, "P001");
        setWallet(userId, 20_000, 6_000);

        Map<String, Object> roll = growthService.dice(userId, "P001", "CASH");
        Map<?, ?> wallet = (Map<?, ?>) roll.get("wallet");
        assertThat(((Number) wallet.get("gems")).longValue()).isEqualTo(6_000L - cashRollCost());
        assertThat(((Number) wallet.get("points")).longValue()).isEqualTo(20_000L);
    }

    /**
     * 롤 결제도 <b>원장에 남는다</b>(reason='dice'). 구매 단계를 지우면서 원장 기록까지 같이
     * 사라지면 "재화가 어디로 갔나"에 답할 수 없다 — 지갑 UPDATE 만 하는 지름길을 막는 계약이다.
     */
    @Test
    void diceRollWritesPointLedgerEntryForAudit() {
        String userId = onboard("g_dice_ledger");
        setCount(userId, "P001", 3);
        growthService.starUp(userId, "P001");
        setWallet(userId, 20_000, 6_000);

        growthService.dice(userId, "P001", "NORMAL");

        Long spent = jdbcClient.sql("SELECT COALESCE(SUM(delta),0) FROM point_ledger WHERE user_id=? AND reason='dice'")
                .param(userId).query(Long.class).single();
        assertThat(spent).isEqualTo(-normalRollCost());
    }

    @Test
    void dicePreview_sameSeedReproducesSameResult() {
        String userId = onboard("g_dice_seed");
        Map<String, Object> a = growthService.previewDiceRoll("fixed-seed-1", "RARE", 0, "NORMAL", "GOLD", 3);
        Map<String, Object> b = growthService.previewDiceRoll("fixed-seed-1", "RARE", 0, "NORMAL", "GOLD", 3);
        assertThat(a).isEqualTo(b);
        Map<String, Object> c = growthService.previewDiceRoll("different-seed", "RARE", 0, "NORMAL", "GOLD", 3);
        // 다른 시드는 (통계적으로) 다른 결과일 수 있음 — 최소한 API 가 결정론적으로 동작함만 확인.
        assertThat(c).isNotNull();
    }

    @Test
    void dicePreview_ceilingGuaranteesTierUpOnNormal() {
        // GOLD/3★ → maxTier EPIC, RARE→EPIC p=0.06, ceilingAt = ceil(1.5/0.06) = 25.
        // rollsBefore=24 → 24+1=25 >= ceilingAt → 강제 승급(byCeiling=true), 시드값과 무관.
        for (String seed : List.of("s1", "s2", "s3", "zzz-anything")) {
            Map<String, Object> res = growthService.previewDiceRoll(seed, "RARE", 24, "NORMAL", "GOLD", 3);
            assertThat(res.get("tierUp")).as("seed=" + seed).isEqualTo(true);
            assertThat(res.get("byCeiling")).as("seed=" + seed).isEqualTo(true);
            assertThat(res.get("tierAfter")).isEqualTo("EPIC");
        }
    }

    @Test
    void dicePreview_cashNeverTiersUpAndDoesNotAdvanceCeilingCounter() {
        Map<String, Object> res = growthService.previewDiceRoll("any-seed", "RARE", 24, "CASH", "GOLD", 3);
        assertThat(res.get("tierUp")).isEqualTo(false);
        assertThat(res.get("byCeiling")).isEqualTo(false);
        assertThat(((Number) res.get("rollsSinceTierUp")).intValue()).isEqualTo(24); // 노말 다이스만 증가
    }

    @Test
    void dicePreview_bronzeCappedAtRareNeverPromotes() {
        // BRONZE maxTier=RARE, 현재 tier=RARE → canPromote=false → 아무리 천장 카운터가 커도 승급 불가.
        Map<String, Object> res = growthService.previewDiceRoll("any-seed", "RARE", 999, "NORMAL", "BRONZE", 2);
        assertThat(res.get("tierUp")).isEqualTo(false);
        assertThat(res.get("tierAfter")).isEqualTo("RARE");
    }

    // ── V2.1-1 전줄 동일 티어(전줄=티어업 후 티어) ──────────────────────

    @Test
    void diceRoll_tierUpRerollsAllLinesToNewTier_twoLineGrade() {
        // GOLD/4★ → maxTier EPIC(min(gradeCap EPIC, starCap[4] UNIQUE)). RARE→EPIC p=0.06,
        // ceilingAt=ceil(1.5/0.06)=25 → rollsBefore=24 로 강제 승급. GOLD linesByGrade=2.
        Map<String, Object> res = growthService.previewDiceRoll("any-seed", "RARE", 24, "NORMAL", "GOLD", 4);
        assertThat(res.get("tierUp")).isEqualTo(true);
        assertThat(res.get("tierAfter")).isEqualTo("EPIC");
        List<?> lines = (List<?>) res.get("lines");
        assertThat(lines).hasSize(2);
        for (Object l : lines) {
            assertThat(((Map<?, ?>) l).get("tier")).isEqualTo("EPIC");
        }
    }

    @Test
    void diceRoll_tierUpRerollsAllLinesToNewTier_threeLineGrade() {
        // DIA/4★ → maxTier UNIQUE(min(gradeCap UNIQUE, starCap[4] UNIQUE)), linesByGrade DIA=3.
        // 승급 전 tier=EPIC → EPIC→UNIQUE p=0.018, ceilingAt=ceil(1.5/0.018)=84.
        Map<String, Object> res = growthService.previewDiceRoll("any-seed", "EPIC", 83, "NORMAL", "DIA", 4);
        assertThat(res.get("tierUp")).isEqualTo(true);
        assertThat(res.get("tierAfter")).isEqualTo("UNIQUE");
        List<?> lines = (List<?>) res.get("lines");
        assertThat(lines).hasSize(3);
        for (Object l : lines) {
            assertThat(((Map<?, ?>) l).get("tier")).isEqualTo("UNIQUE");
        }
    }

    @Test
    void diceRoll_allLines_alwaysMatchTierAfter_acrossManySeedsAndKinds() {
        // 불변식: 승급 여부·시드·다이스 종류와 무관하게 롤 결과 lines 는 전부 tierAfter 와 동일 티어.
        List<String> seeds = List.of("s1", "s2", "s3", "alpha", "beta", "gamma", "zzz",
                "seed-42", "cafe-babe", "random-1");
        for (String seed : seeds) {
            for (String kind : List.of("NORMAL", "CASH")) {
                Map<String, Object> res = growthService.previewDiceRoll(seed, "RARE", 0, kind, "LEGEND", 4);
                Object tierAfter = res.get("tierAfter");
                List<?> lines = (List<?>) res.get("lines");
                assertThat(lines).isNotEmpty();
                for (Object l : lines) {
                    assertThat(((Map<?, ?>) l).get("tier")).as("seed=%s kind=%s", seed, kind).isEqualTo(tierAfter);
                }
            }
        }
    }

    @Test
    void diceRoll_sameSeed_reproducesSameLineTiers() {
        Map<String, Object> a = growthService.previewDiceRoll("fixed-seed-77", "RARE", 24, "NORMAL", "DIA", 4);
        Map<String, Object> b = growthService.previewDiceRoll("fixed-seed-77", "RARE", 24, "NORMAL", "DIA", 4);
        assertThat(a).isEqualTo(b);
        List<?> lines = (List<?>) a.get("lines");
        Object tierAfter = a.get("tierAfter");
        for (Object l : lines) {
            assertThat(((Map<?, ?>) l).get("tier")).isEqualTo(tierAfter);
        }
    }

    @Test
    void diceRoll_variesValueWithinSameTier_acrossSeeds_smoke() {
        // BRONZE/2★ maxTier=RARE==현재 tier → 절대 승급 불가(티어 고정) → value 편차만 관찰(V2.1-2).
        java.util.Set<Double> observedValues = new java.util.HashSet<>();
        for (int i = 0; i < 30; i++) {
            Map<String, Object> res = growthService.previewDiceRoll("smoke-seed-" + i, "RARE", 0, "NORMAL",
                    "BRONZE", 2);
            assertThat(res.get("tierAfter")).isEqualTo("RARE");
            List<?> lines = (List<?>) res.get("lines");
            for (Object l : lines) {
                observedValues.add(((Number) ((Map<?, ?>) l).get("value")).doubleValue());
            }
        }
        assertThat(observedValues.size()).as("롤 편차 스모크 — 30롤에서 서로 다른 value 가 나와야 함")
                .isGreaterThan(1);
    }

    // ── V2-1 성장 정산 멱등 ──────────────────────────────────────────────

    @Test
    void settleMatchIsIdempotent_sameMatchAppliedOnce() {
        String token = setupUserWithDeck("g_settle");
        String userId = userIdOf("g_settle");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");

        List<String> starters = List.of("P001", "P002", "P003", "P004", "P005",
                "P006", "P007", "P008", "P009", "P010", "P011");
        List<String> bench = List.of("P012", "P013");

        growthService.settleMatch(matchId, userId, starters, bench, Set.of(), Set.of(), true, "DRAW");
        long applied1 = appliedCount(matchId);
        int starterLevel1 = cardLevelOf(userId, "P001");
        int benchLevel1 = cardLevelOf(userId, "P012");

        assertThat(applied1).isEqualTo(13); // 11 선발 + 2 벤치
        // 미출전 벤치는 minutesMult=0 → XP 0 → 레벨 변화 없음(V2-1 "미출전 XP=0").
        assertThat(benchLevel1).isEqualTo(1);
        assertThat(starterLevel1).isGreaterThan(1);

        // 재정산 → growth_applied 중복 무시(멱등), 상태 변화 없음.
        growthService.settleMatch(matchId, userId, starters, bench, Set.of(), Set.of(), true, "DRAW");
        assertThat(appliedCount(matchId)).isEqualTo(13);
        assertThat(cardLevelOf(userId, "P001")).isEqualTo(starterLevel1);
        assertThat(cardLevelOf(userId, "P012")).isEqualTo(1);
    }

    private int cardLevelOf(String userId, String playerId) {
        return jdbcClient.sql("SELECT card_level FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
    }

    @Test
    void settlementFeedsGrowthReport() {
        String token = setupUserWithDeck("g_report");
        String userId = userIdOf("g_report");
        String matchId = createMatch(token, "BOT_BAL");
        forceState(matchId, "FINISHED");
        List<String> starters = List.of("P001", "P002", "P003", "P004", "P005",
                "P006", "P007", "P008", "P009", "P010", "P011");
        growthService.settleMatch(matchId, userId, starters, List.of(), Set.of(), Set.of(), true, "DRAW");

        Map<String, Object> report = growthService.growthReport(userId, matchId);
        assertThat(report.get("matchId")).isEqualTo(matchId);
        List<?> entries = (List<?>) report.get("entries");
        assertThat(entries).hasSize(11);
        Map<?, ?> e = (Map<?, ?>) entries.stream()
                .filter(x -> "P001".equals(((Map<?, ?>) x).get("playerId")))
                .findFirst().orElseThrow();
        // #405 W2b: 리포트는 **카드 축**이다 — 스탯별 XP 가 아니라 얻은 XP·레벨·선택 대기다.
        assertThat(((Number) e.get("xpGained")).intValue()).isGreaterThan(0);
        assertThat(((Number) e.get("levelAfter")).intValue())
                .isGreaterThan(((Number) e.get("levelBefore")).intValue());
        assertThat((List<?>) e.get("pendingChoices")).isNotEmpty();
    }

    // ── V2.2 재화 이원화 (젬 지갑, WalletService.applyGems) ─────────────────

    @Test
    void applyGemsCreditsWalletAndLedger() {
        String userId = onboard("g_gems_credit");
        // #212: 가입 시 젬이 지급되므로(initialGems) 시작 잔액은 0이 아니다 — 델타로 검증한다.
        long before = walletService.gems(userId);

        boolean applied = walletService.applyGems(userId, 60, "gem_topup_mock", "pack-p1-1");
        assertThat(applied).isTrue();
        assertThat(walletService.gems(userId)).isEqualTo(before + 60L);

        Long rows = jdbcClient.sql("SELECT COUNT(*) FROM gem_ledger WHERE user_id=? AND reason='gem_topup_mock'")
                .param(userId).query(Long.class).single();
        assertThat(rows).isEqualTo(1L);
    }

    @Test
    void applyGemsIsIdempotentPerReasonRef() {
        String userId = onboard("g_gems_idem");
        long before = walletService.gems(userId); // #212 가입 지급분 기준
        walletService.applyGems(userId, 10, "dice", "ref-1");
        assertThat(walletService.gems(userId)).isEqualTo(before + 10L);

        // 같은 (user, reason, ref) 재적용 — 멱등: false 반환, 잔액 무변화(point_ledger 패턴과 동일).
        boolean second = walletService.applyGems(userId, 10, "dice", "ref-1");
        assertThat(second).isFalse();
        assertThat(walletService.gems(userId)).isEqualTo(before + 10L);
    }

    @Test
    void applyGemsDebitCannotGoNegative_checkBackstop() {
        String userId = onboard("g_gems_floor");
        // #212: 가입 지급분이 있으므로 "잔액보다 1 큰 차감"으로 바닥을 밟아야 CHECK 가 걸린다.
        long balance = walletService.gems(userId);
        assertThatThrownBy(() -> walletService.applyGems(userId, -(balance + 1), "dice", "over-debit"))
                .isInstanceOf(Exception.class); // wallets.gems CHECK(gems>=0) 백스톱 — DB 레벨 방어
        assertThat(walletService.gems(userId)).isEqualTo(balance); // 실패 시 잔액 무변화
    }

    // ── 헬퍼 ──────────────────────────────────────────────────────────────

    private String onboard(String nickname) {
        login(nickname); // 스타터 팩 지급(user_players + wallet)
        return userIdOf(nickname);
    }

    private void starUpTo(String userId, String playerId, int targetStar) {
        int current = jdbcClient.sql("SELECT star FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(Integer.class).single();
        while (current < targetStar) {
            growthService.starUp(userId, playerId);
            current++;
        }
    }

    private void setStar(String userId, String playerId, int star) {
        jdbcClient.sql("UPDATE user_players SET star = ? WHERE user_id=? AND player_id=?")
                .params(star, userId, playerId).update();
    }

    /**
     * 상승분 주입 — #405 W2b 로 저장 형태가 {@code stat_levels_json}(정수 lv)에서
     * {@code stat_add_json}(소수 누적)으로 바뀌었다. 테스트의 <b>의도</b>("이만큼 키운 카드")는
     * 그대로이고 주입 지점만 옮긴다.
     */
    private void setStatAdd(String userId, String playerId, String stat, double add) {
        String json = jdbcClient.sql("SELECT stat_add_json FROM user_players WHERE user_id=? AND player_id=?")
                .params(userId, playerId).query(String.class).optional().orElse(null);
        Map<String, Object> map = new java.util.LinkedHashMap<>();
        if (json != null) {
            try {
                map = new com.fasterxml.jackson.databind.ObjectMapper().readValue(json, Map.class);
            } catch (Exception ignored) {
                map = new java.util.LinkedHashMap<>();
            }
        }
        map.put(stat, add);
        try {
            String out = new com.fasterxml.jackson.databind.ObjectMapper().writeValueAsString(map);
            jdbcClient.sql("UPDATE user_players SET stat_add_json = ? WHERE user_id=? AND player_id=?")
                    .params(out, userId, playerId).update();
        } catch (Exception e) {
            throw new RuntimeException(e);
        }
    }

    private void insertPotential(String userId, String playerId, String tier, int rolls, String linesJson) {
        jdbcClient.sql("""
                        INSERT INTO card_potentials(user_id, player_id, tier, lines_json, rolls_since_tierup, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?)
                        ON CONFLICT(user_id, player_id) DO UPDATE SET
                            tier=excluded.tier, lines_json=excluded.lines_json,
                            rolls_since_tierup=excluded.rolls_since_tierup, updated_at=excluded.updated_at
                        """)
                .params(userId, playerId, tier, linesJson, rolls, java.time.Instant.now().toString())
                .update();
    }

    // ── B1/B2 회귀 (#179 gverify blocker) ───────────────────────────────

    @Test
    void starUpNeverConsumesOriginalCard_b1Boundary() {
        String userId = onboard("g_b1");
        // 여분 1장뿐(총 2) → 승급 거절(필요 여분 2), have = 여분 수(1)로 보고.
        setCount(userId, "P001", 2);
        assertThat(catchStatus(() -> growthService.starUp(userId, "P001")))
                .isEqualTo("INSUFFICIENT_MATERIALS");
        // 딱 필요한 여분(2) + 원본 1 = 총 3 → 승급 성공, 원본 1장은 남는다(카드 소실 금지).
        setCount(userId, "P001", 3);
        Map<String, Object> res = growthService.starUp(userId, "P001");
        assertThat(res.get("star")).isEqualTo(2);
        assertThat(countOf(userId, "P001")).isEqualTo(1); // owned 유지 — 목록·덱에서 사라지지 않음
    }

    /**
     * B2(#179 gverify) 무회귀 — 봇 로스터가 같은 카탈로그를 쓰므로 {@code playerId} 가 겹친다.
     * <b>상대 사이드 이벤트가 귀속되면 안 된다.</b>
     *
     * <p>#405 W2b 로 이벤트가 흘러 들어가는 자리가 바뀌었다(스탯별 XP → {@code perfBonus} 와 후보
     * 가중). 그래서 계약도 <b>대조군 대비 관계식</b>으로 다시 세운다: away 골 100개짜리 매치의
     * XP 가 <b>이벤트가 아예 없는 매치</b>의 XP 와 같아야 한다. 필터를 떼면 100 × 0.15 가
     * {@code perfBonusCap} 까지 차서 XP 가 눈에 띄게 커진다(= 이 단언이 죽는다).
     */
    @Test
    void settleMatchIgnoresOpponentSideEvents_b2() {
        String userId = onboard("g_b2");
        StringBuilder events = new StringBuilder();
        events.append("{\"type\":\"kickoff\",\"team\":\"home\",\"tick\":0}");
        for (int i = 0; i < 100; i++) {
            events.append(",{\"type\":\"goal\",\"playerId\":\"P001\",\"team\":\"away\",\"tick\":")
                    .append(i + 2).append("}");
        }
        int noisyXp = settleWithLog(userId, "gb2-noisy", "{\"events\":[" + events + "]}");
        int quietXp = settleWithLog(userId, "gb2-quiet", "{\"events\":[]}");

        assertThat(noisyXp)
                .as("상대 사이드 골 100개가 유저 선수의 XP 를 움직였다 — event.team 필터가 죽었다")
                .isEqualTo(quietXp);
        assertThat(quietXp).as("대조군 XP 가 0 이면 이 관계식이 공허해진다").isGreaterThan(0);
    }

    /** 주어진 매치 로그로 P001 을 선발 정산하고 적립된 XP 를 돌려준다. */
    private int settleWithLog(String userId, String matchId, String log) {
        jdbcClient.sql("""
                        INSERT INTO matches(id, user_id, bot_id, state, seed, engine_version, user_deck_json, created_at)
                        VALUES (?, ?, 'BOT_BAL', 'FINISHED', 's', 'v', '{}', ?)
                        """)
                .params(matchId, userId, java.time.Instant.now().toString()).update();
        jdbcClient.sql("""
                        INSERT INTO match_halves(match_id, half, select_data_json, home_input_json,
                            away_input_json, half_seed, match_log_json, last_hash)
                        VALUES (?, 1, '{}', '{}', '{}', 's1', ?, 'h')
                        """)
                .params(matchId, log).update();
        growthService.settleMatch(matchId, userId, List.of("P001"), List.of(), Set.of(), Set.of(), true, "DRAW");
        return jdbcClient.sql("SELECT xp_delta FROM growth_applied WHERE match_id=? AND player_id='P001'")
                .param(matchId).query(Integer.class).single();
    }

    /**
     * #247: 다이스 재고(user_dice)가 사라지고 롤이 <b>지갑에서 직접</b> 결제하므로, 롤 테스트의
     * 준비물은 "다이스 n개"가 아니라 "잔액"이다. 구 {@code setUserDice} 는 그래서 은퇴했다.
     */
    private void setWallet(String userId, long points, long gems) {
        jdbcClient.sql("UPDATE wallets SET points = ?, gems = ? WHERE user_id = ?")
                .params(points, gems, userId).update();
    }

    private void setCount(String userId, String playerId, int count) {
        jdbcClient.sql("""
                        INSERT INTO user_players(user_id, player_id, count, acquired_at)
                        VALUES (?, ?, ?, ?)
                        ON CONFLICT(user_id, player_id) DO UPDATE SET count=excluded.count
                        """)
                .params(userId, playerId, count, java.time.Instant.now().toString())
                .update();
    }

    private int countOf(String userId, String playerId) {
        return jdbcClient.sql("SELECT count FROM user_players WHERE user_id=? AND player_id=?")
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
