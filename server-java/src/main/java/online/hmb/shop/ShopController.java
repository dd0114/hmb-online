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
 * POST /api/shop/dice {kind: NORMAL|CASH, count} — 다이스 구매(에픽 #179 V2-4, point_ledger 원장·reason='dice').
 */
@RestController
public class ShopController {

    private final GachaService gachaService;
    private final GrowthService growthService;

    public ShopController(GachaService gachaService, GrowthService growthService) {
        this.gachaService = gachaService;
        this.growthService = growthService;
    }

    @PostMapping("/api/shop/gacha")
    public GachaResponse gacha(@RequestAttribute("userId") String userId,
                                @RequestBody GachaRequest request) {
        return gachaService.pull(userId, request == null ? null : request.kind());
    }

    @PostMapping("/api/shop/dice")
    public Map<String, Object> dice(@RequestAttribute("userId") String userId,
                                    @RequestBody(required = false) DiceRequest request) {
        if (request == null) {
            throw ApiException.validation("kind/count가 필요합니다");
        }
        return growthService.buyDice(userId, request.kind(), request.count());
    }

    public record GachaRequest(String kind) {
    }

    public record DiceRequest(String kind, int count) {
    }
}
