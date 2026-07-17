package online.hmb.shop;

import online.hmb.shop.GachaService.GachaResponse;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** POST /api/shop/gacha {kind: single|ten} — LLD §4.1. */
@RestController
public class ShopController {

    private final GachaService gachaService;

    public ShopController(GachaService gachaService) {
        this.gachaService = gachaService;
    }

    @PostMapping("/api/shop/gacha")
    public GachaResponse gacha(@RequestAttribute("userId") String userId,
                                @RequestBody GachaRequest request) {
        return gachaService.pull(userId, request == null ? null : request.kind());
    }

    public record GachaRequest(String kind) {
    }
}
