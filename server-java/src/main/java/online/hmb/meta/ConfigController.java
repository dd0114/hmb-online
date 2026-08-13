package online.hmb.meta;

import java.util.List;
import online.hmb.catalog.EconomyService;
import online.hmb.catalog.EconomyService.Currency;
import online.hmb.catalog.EconomyService.Economy;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/config} — 클라이언트 부트스트랩 config (#232).
 *
 * <p><b>왜 있나.</b> 재화 표기(심볼·이름·아이콘)와 상점 가격이 web 에 하드코딩돼 있었고, #212 가
 * 서버 경제를 바꿨을 때 web 이 따라오지 못해 <b>화면 숫자가 실제 결제와 달라졌다</b>
 * (뽑기 "300 P" ← 실제로는 다이아 300 차감 / 다이스 "500 P" ← 실제 5,000). 심볼만 서버로 옮기면
 * 그 거짓말은 그대로 남는다 — 그래서 <b>표기와 가격을 같은 페이로드로</b> 내린다.
 *
 * <p><b>클라 계약.</b> 클라는 심볼·이름·아이콘·가격·재화종류를 하나도 몰라야 한다. 여기서 받은
 * 값만 렌더한다. 조회 실패 시 클라는 마지막 성공값을 쓰고, 그것도 없으면 코드를 그대로 노출한다
 * (못생겨도 거짓말은 아니다) — "P" 같은 하드코딩으로 되돌아가지 않는다.
 *
 * <p><b>무배포 변경.</b> 값의 출처는 {@link EconomyService} 스냅샷이라 override 파일 +
 * {@code POST /api/admin/economy/reload} 로 바뀐다(#209 배관 재사용). web 재배포가 필요 없다.
 *
 * <p>economy 파일이 없으면 {@code shop} 은 null 이고 {@code currencies} 는 기본 표기가 나간다 —
 * 상점을 못 그리는 것과 단위를 못 그리는 것은 심각도가 다르다.
 */
@RestController
public class ConfigController {

    private final EconomyService economyService;
    private final AiModeService aiModeService;
    private final online.hmb.tutorial.TutorialStarterService tutorialStarterService;

    public ConfigController(EconomyService economyService, AiModeService aiModeService,
                            online.hmb.tutorial.TutorialStarterService tutorialStarterService) {
        this.economyService = economyService;
        this.aiModeService = aiModeService;
        this.tutorialStarterService = tutorialStarterService;
    }

    @GetMapping("/api/config")
    public ConfigResponse config() {
        List<Currency> currencies = economyService.currencies();
        Economy economy = economyService.snapshot().economy().orElse(null);
        return new ConfigResponse(currencies,
                economy == null ? null : shopOf(economy),
                economy == null ? null : new Grants(economy.initialPoints(), economy.initialGems()),
                aiModeService.current(),
                new TutorialConfig(tutorialStarterService.starterCardId()));
    }

    private static ShopConfig shopOf(Economy e) {
        EconomyService.Gacha g = e.gacha();
        GachaConfig gacha = g == null ? null : new GachaConfig(
                new Price(g.currency(), g.singleCost()),
                new Price(g.currency(), g.tenCost()),
                g.tenCount());
        EconomyService.Dice d = e.dice();
        // 노말 다이스는 무료재화(POINT), 캐시 다이스는 유상재화(GEM) — #179 V2.2 이원화가 SoT.
        DiceConfig dice = d == null ? null : new DiceConfig(
                new Price(EconomyService.CURRENCY_POINT, d.normalCost()),
                new Price(EconomyService.CURRENCY_GEM, d.cashGemCost()));
        EconomyService.Gems gems = e.gems();
        GemTopupConfig topup = gems == null ? null : new GemTopupConfig(
                gems.topupEnabled(),
                gems.topupPacks() == null ? List.of() : gems.topupPacks().stream()
                        .map(p -> new TopupPack(p.id(), p.gems(), p.mockPrice()))
                        .toList());
        return new ShopConfig(gacha, dice, topup);
    }

    /**
     * {@code ai} 는 <b>additive</b> 다 (#471 AC3) — 구 클라이언트는 모르는 필드를 무시하고 그대로 돈다.
     * 이 엔드포인트는 인증 예외(공개)라 <b>로그인 전 시작 화면</b>에서도 읽힌다: hero 요구의
     * "게임시작할때 안내말만" 이 성립하는 자리가 여기다.
     */
    public record ConfigResponse(List<Currency> currencies, ShopConfig shop, Grants grants,
            AiModeService.AiModeView ai, TutorialConfig tutorial) {
    }

    /**
     * 온레일 튜토리얼이 클라에 필요한 서버 값 (#493 W9, <b>additive</b>).
     *
     * <p>{@code starterCardId} = 가입 시 재료를 얹어 주는 <b>고정 카드</b>
     * ({@code hmb.tutorial.starter.card-id}). web 은 이 값이 없어서 "대기 중인 3지선다의 주인"으로
     * 추론하고 있었다 — 유저가 다른 카드로 경기를 치르거나 선택권을 이미 써 버리면 어긋나는 추론이다
     * (apps/web {@code onrail-api.ts}). <b>서버가 이미 아는 값</b>이므로 그대로 내려 준다.
     *
     * <p>값의 출처는 지급 로직({@code TutorialStarterService})이 쓰는 그 필드다 — 여기서
     * 프로퍼티를 따로 읽으면 지급과 표시가 서로 다른 카드를 가리킬 수 있다.
     *
     * <p>{@code starterCardId} 는 <b>null 일 수 있다</b> — 튜토리얼 재료 지급이 꺼진 배포
     * ({@code hmb.tutorial.starter.enabled=false})엔 고정 카드가 없다. 클라는 그때 종전의
     * 추론/폴백 경로를 탄다(없는 카드를 가리키는 것보다 "없다"가 낫다).
     */
    public record TutorialConfig(String starterCardId) {
    }

    /**
     * 가입 지급액 (#232). 가입 연출이 클라 상수(3,000)를 그리고 있었고 <b>유상재화 지급은 아예
     * 표기가 없었다</b> — 리그 우승에서 고친 "받은 재화가 화면에 없다"와 같은 형태다.
     * 실제로 운영이 무배포 override 로 유상재화 지급액을 올린 이력이 있어(#209) 클라 상수는 이미 틀렸다.
     */
    public record Grants(int initialPoints, int initialGems) {
    }

    public record ShopConfig(GachaConfig gacha, DiceConfig dice, GemTopupConfig gemTopup) {
    }

    /**
     * 금액 + <b>그 금액이 무슨 재화인지</b>. 이 둘을 떼어 놓은 것이 #213 버그의 형태였으므로
     * 가격을 내릴 땐 언제나 붙여서 내린다.
     */
    public record Price(String currency, int cost) {
    }

    public record GachaConfig(Price single, Price ten, int tenCount) {
    }

    public record DiceConfig(Price normal, Price cash) {
    }

    /** 충전 목업 — {@code enabled=false} 면 클라는 탭 자체를 숨긴다(누르면 403 이라 죽은 버튼이 된다). */
    public record GemTopupConfig(boolean enabled, List<TopupPack> packs) {
    }

    public record TopupPack(String id, int gems, String mockPrice) {
    }
}
