package online.hmb.shop;

import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.growth.GrowthService;
import online.hmb.shop.GachaService.GachaResponse;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/shop/gacha {kind: single|ten} — LLD §4.1.
 * POST /api/shop/gems/topup {packId} — 젬 충전(목업, V2.2 재화 이원화, 실결제 없음).
 *
 * <p><b>{@code POST /api/shop/dice} 는 은퇴했다</b>(#247, hero 확정 2026-07-29) — "다이스는 사는
 * 게 아니다". 잠재 리롤은 강화탭에서 {@code POST /api/growth/dice} 가 지갑에서 직접 결제한다.
 * 여기에 구매 엔드포인트를 되살리면 재고(user_dice)라는 개념이 같이 살아난다.
 */
@RestController
public class ShopController {

    private final GachaService gachaService;
    private final GrowthService growthService;
    private final online.hmb.events.BusinessEventRecorder events;

    public ShopController(GachaService gachaService, GrowthService growthService,
                          online.hmb.events.BusinessEventRecorder events) {
        this.gachaService = gachaService;
        this.growthService = growthService;
        this.events = events;
    }

    @PostMapping("/api/shop/gacha")
    public GachaResponse gacha(@RequestAttribute("userId") String userId,
                                @RequestBody GachaRequest request) {
        String kind = request == null ? null : request.kind();
        GachaResponse response = gachaService.pull(userId, kind);
        // #492: 훅이 **컨트롤러**인 이유 = GachaService.pull 은 메서드 전체가 트랜잭션이다
        // (차감·원장·보유풀이 한 단위). 그 안에 기록을 넣으면 실패 시 뽑기가 통째로 롤백된다.
        events.record(online.hmb.events.BusinessEvent.GACHA_PULL, userId, () -> java.util.Map.of(
                "kind", kind,
                "count", response.results().size(),
                "cost", gachaService.costOf(kind),
                "currency", gachaService.currencyCode(),
                "grades", response.results().stream().map(r -> r.player().grade()).toList()));
        return response;
    }

    @PostMapping("/api/shop/gems/topup")
    public Map<String, Object> gemsTopup(@RequestAttribute("userId") String userId,
                                         @RequestBody(required = false) GemTopupRequest request) {
        if (request == null || request.packId() == null) {
            throw ApiException.validation("packId가 필요합니다");
        }
        return growthService.topupGems(userId, request.packId());
    }

    public record GachaRequest(String kind) {
    }

    public record GemTopupRequest(String packId) {
    }
}
