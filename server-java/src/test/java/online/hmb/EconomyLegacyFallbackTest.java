package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import com.fasterxml.jackson.databind.ObjectMapper;
import online.hmb.catalog.EconomyService;
import org.junit.jupiter.api.Test;

/**
 * #212 가 economy config 에 신규 필드를 여럿 추가하면서(`initialGems` · `gacha.currency` ·
 * `rewards.byMode` · `league.gemReward` · `gems.topupEnabled`) <b>구파일 폴백</b>을 주석으로 계약했다.
 *
 * <p>문제는 스프링 테스트가 전부 쓰는 픽스처가 신규 필드를 <b>다 갖도록</b> 갱신됐다는 것 —
 * 즉 레거시 경로를 밟는 테스트가 하나도 없어서, 폴백이 조용히 깨져도 429개가 전부 green 이다.
 * 여기서 <b>#212 이전 모양의 파일</b>로 직접 로더를 태워 폴백을 박제한다(스프링 불필요 — 순수 로더).
 *
 * <p>왜 중요한가: 롤백이나 구버전 data 발행물로 부팅했을 때 뽑기가 갑자기 P 를 긁거나(currency),
 * 리그 매판이 연습 단가로 떨어지는(byMode) 사고를 막는 안전망이다.
 */
class EconomyLegacyFallbackTest {

    private static final String LEGACY = "src/test/resources/fixtures/economy-legacy-pre212.json";

    private static EconomyService.Economy loadLegacy() {
        return new EconomyService(new ObjectMapper(), LEGACY).get().orElseThrow();
    }

    @Test
    void legacyFileLoadsWithoutBlowingUp() {
        assertThat(loadLegacy().version()).isEqualTo("legacy");
    }

    @Test
    void gachaFallsBackToPointCurrency() {
        EconomyService.Gacha gacha = loadLegacy().gacha();
        assertThat(gacha.currency()).isEqualTo(EconomyService.CURRENCY_POINT);
        assertThat(gacha.paysWithGems()).isFalse(); // 구파일에선 예전처럼 P 로 뽑는다
    }

    @Test
    void initialGemsIsZeroSoNoAccidentalGrant() {
        assertThat(loadLegacy().initialGems()).isZero();
    }

    @Test
    void rewardsFallBackToFlatForEveryMode() {
        EconomyService.Rewards rewards = loadLegacy().rewards();
        assertThat(rewards.byMode()).isEmpty();
        for (String mode : new String[] {"practice", "league", null, "무언가이상한모드"}) {
            assertThat(rewards.forMode(mode).win()).as("mode=%s", mode).isEqualTo(500);
            assertThat(rewards.forMode(mode).draw()).isEqualTo(200);
            assertThat(rewards.forMode(mode).loss()).isEqualTo(100);
        }
    }

    /**
     * #251 로 <b>의도가 뒤집힌 자리</b>다. #212 때는 블록이 없으면 "지급 경로를 아예 안 탄다"(null)가
     * 맞았다 — 우승 보너스였으니 없으면 안 주는 게 안전했다. 지금은 <b>완주 기본 보상</b>이라
     * 없으면 안 주는 쪽이 사고다: 운영 override(구 스냅샷)를 얹은 환경에서만 보상이 조용히 0 이 된다.
     * 그래서 구파일도 <b>기본값으로 메워</b> 신 보상이 그대로 나간다.
     */
    @Test
    void leagueGemRewardFallsBackToDefaultsWhenAbsentSoRewardsNeverSilentlyVanish() {
        EconomyService.LeagueGemReward cfg = loadLegacy().leagueGemReward();
        assertThat(cfg).isEqualTo(EconomyService.DEFAULT_LEAGUE_GEM_REWARD);
        assertThat(cfg.amountFor(1)).isEqualTo(9000);
        assertThat(cfg.amountFor(10)).isEqualTo(3000);
    }

    @Test
    void topupStaysEnabledOnLegacyFilesSoOldBehaviourIsNotSilentlyChanged() {
        assertThat(loadLegacy().gems().topupEnabled()).isTrue();
    }

    /**
     * `dice` 블록은 있는데 `normalCost` 만 빠진 파일의 기본값은 **신 가격(5,000)** 이어야 한다.
     * 구값 500 이 남아 있으면 그 좁은 경로에서 10배 싼 다이스가 조용히 팔린다(#212 검증 지적).
     */
    @Test
    void diceNormalCostDefaultsToCurrentPriceNotTheOldOne() {
        assertThat(loadLegacy().dice().normalCost()).isEqualTo(500); // 구파일은 자기 값을 그대로 쓴다

        // normalCost 가 아예 없는 블록 → 기본값이 발화한다.
        EconomyService.Dice parsed = new EconomyService(new ObjectMapper(),
                "src/test/resources/fixtures/economy-dice-no-normalcost.json").get().orElseThrow().dice();
        assertThat(parsed.normalCost()).isEqualTo(5000);
        assertThat(parsed.cashGemCost()).isEqualTo(10);
    }

    /**
     * <b>override 트랩 계약(#251 핵심)</b> — 운영에 얹힌 override 는 <b>구 스냅샷</b>이라
     * {@code gemReward} 가 옛 모양({@code maxRank/min/max})이다. 그 필드들은 이제 의미가 없으므로
     * <b>무시하고 기본값으로 메운다</b>. economy.v2.json 이 실제 그 모양이라 라이브 override 의 대역이 된다.
     *
     * <p>여기가 깨지면 = override 가 깔린 환경에서만 보상이 0 이거나 옛 랜덤으로 돌아간다는 뜻이다
     * (발행물로 부팅하는 테스트 환경에선 절대 안 보이는 사고 — #232 에서 같은 형태를 겪었다).
     */
    @Test
    void legacyShapedGemRewardBlockIsIgnoredAndFilledWithDefaults() {
        EconomyService.Economy legacyShaped = new EconomyService(
                new ObjectMapper(), "../data/players/economy.v2.json").get().orElseThrow();
        assertThat(legacyShaped.leagueGemReward()).isEqualTo(EconomyService.DEFAULT_LEAGUE_GEM_REWARD);
    }

    /**
     * 방어적 파싱: 값이 <b>있는데</b> 음수/비정수 키면 그 항목만 버리고 기본값으로 간다 —
     * 손편집 override 하나가 마이너스 지급을 만들지 않는다.
     */
    @Test
    void malformedGemRewardValuesFallBackFieldByField() throws Exception {
        java.nio.file.Path tmp = java.nio.file.Files.createTempFile("economy-bad-gemreward", ".json");
        java.nio.file.Files.writeString(tmp, """
                {"version":"bad","initialPoints":0,"starterPack":[],
                 "league":{"gemReward":{"completion":-500,"rankBonus":{"1":-1,"두번째":3000,"3":1000}}}}
                """);
        EconomyService.LeagueGemReward cfg = new EconomyService(new ObjectMapper(), tmp.toString())
                .get().orElseThrow().leagueGemReward();

        // completion 은 음수라 기본값으로. rankBonus 는 유효한 항목(3위)만 살고 나머지는 버려진다.
        assertThat(cfg.completion()).isEqualTo(EconomyService.DEFAULT_LEAGUE_GEM_REWARD.completion());
        assertThat(cfg.rankBonus()).containsExactly(java.util.Map.entry(3, 1000));
        assertThat(cfg.amountFor(1)).as("버려진 1위 보너스는 0 가산 — 음수 지급 없음").isEqualTo(3000);
        java.nio.file.Files.deleteIfExists(tmp);
    }

    /**
     * <b>{@code rankBonus} 는 순위표 통짜 교체</b>(순위별 병합이 아니다) — 한 줄만 적은 표는 나머지
     * 순위 보너스를 <b>지운다</b>. 운영이 손편집할 때 걸려 넘어지는 자리라 명시적으로 박제한다
     * (독립검증 MINOR-1: 문서는 "필드 단위 병합"이라 적혀 있었지만 구현은 통짜였다 — 지금은 구현이
     * 정본이고 이 테스트가 그 계약이다).
     */
    @Test
    void rankBonusTableIsReplacedWholesaleNotMergedPerRank() throws Exception {
        java.nio.file.Path tmp = java.nio.file.Files.createTempFile("economy-partial-bonus", ".json");
        java.nio.file.Files.writeString(tmp, """
                {"version":"partial","initialPoints":0,"starterPack":[],
                 "league":{"gemReward":{"completion":3000,"rankBonus":{"1":7000}}}}
                """);
        EconomyService.LeagueGemReward cfg = new EconomyService(new ObjectMapper(), tmp.toString())
                .get().orElseThrow().leagueGemReward();

        assertThat(cfg.amountFor(1)).isEqualTo(10000);
        assertThat(cfg.amountFor(2)).as("적지 않은 순위는 기본 표가 남는 게 아니라 보너스 0").isEqualTo(3000);
        assertThat(cfg.amountFor(3)).isEqualTo(3000);
        java.nio.file.Files.deleteIfExists(tmp);
    }

    /** 발행물(현행 v3)이 hero 확정 금액을 싣고 있는지 — data 발행물이 SoT 라는 계약. */
    @Test
    void publishedEconomyCarriesTheConfirmedSeasonGemAmounts() {
        EconomyService.LeagueGemReward cfg = new EconomyService(
                new ObjectMapper(), "../data/players/economy.v3.json").get().orElseThrow()
                .leagueGemReward();
        assertThat(cfg.amountFor(1)).isEqualTo(9000);
        assertThat(cfg.amountFor(2)).isEqualTo(6000);
        assertThat(cfg.amountFor(3)).isEqualTo(4000);
        assertThat(cfg.amountFor(4)).isEqualTo(3000);
        assertThat(cfg.amountFor(10)).isEqualTo(3000);
    }
}
