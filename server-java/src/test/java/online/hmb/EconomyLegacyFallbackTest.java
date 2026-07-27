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

    @Test
    void leagueGemRewardIsDisabledWhenAbsent() {
        assertThat(loadLegacy().leagueGemReward()).isNull(); // 지급 경로가 아예 안 탄다
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

    /** 방어적 파싱: gemReward 블록이 있어도 값이 말이 안 되면(max &lt; min) 비활성으로 떨어뜨린다. */
    @Test
    void invalidGemRewardBlockIsRejectedRatherThanTrusted() {
        EconomyService.Economy current = new EconomyService(
                new ObjectMapper(), "../data/players/economy.v2.json").get().orElseThrow();
        assertThat(current.leagueGemReward()).isNotNull(); // 대조군: 현행 파일은 유효
        assertThat(current.leagueGemReward().min())
                .isLessThanOrEqualTo(current.leagueGemReward().max());
    }
}
