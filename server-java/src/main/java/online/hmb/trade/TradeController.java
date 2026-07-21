package online.hmb.trade;

import java.util.List;
import online.hmb.common.ApiException;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 트레이드 API (AC-D1~D5, openapi-v2 trade 5종) — 슬롯 3개, FA/TRADE 2종.
 * 모든 도메인 로직·검증·트랜잭션은 {@link TradeService} (컨트롤러는 얇게). slot 경로변수는
 * 1|2|3 만 허용(그 외 VALIDATION_ERROR).
 */
@RestController
public class TradeController {

    private final TradeService tradeService;

    public TradeController(TradeService tradeService) {
        this.tradeService = tradeService;
    }

    @GetMapping("/api/trade")
    public TradeService.TradeSlotsResponse getSlots(@RequestAttribute("userId") String userId) {
        return tradeService.getSlots(userId);
    }

    /** [장 시작!] (#149) — IDLE 최초 시작 / OPEN 에서는 [거래 안함](오퍼 폐기 후 새 장). */
    @PostMapping("/api/trade/{slot}/start")
    public TradeService.TradeStartResponse start(@RequestAttribute("userId") String userId,
                                                 @PathVariable("slot") int slot) {
        return tradeService.start(userId, requireSlotNo(slot));
    }

    @PostMapping("/api/trade/{slot}/speedup")
    public TradeService.TradeSpeedupResponse speedup(@RequestAttribute("userId") String userId,
                                                     @PathVariable("slot") int slot) {
        return tradeService.speedup(userId, requireSlotNo(slot));
    }

    @PostMapping("/api/trade/{slot}/propose")
    public TradeService.TradeResolveResponse propose(@RequestAttribute("userId") String userId,
                                                     @PathVariable("slot") int slot,
                                                     @RequestBody(required = false) TradeService.FaProposeRequest body) {
        List<String> playerIds = body == null ? List.of()
                : (body.playerIds() == null ? List.of() : body.playerIds());
        int points = body == null || body.points() == null ? 0 : body.points();
        return tradeService.proposeFa(userId, requireSlotNo(slot), playerIds, points);
    }

    @PostMapping("/api/trade/{slot}/accept")
    public TradeService.TradeResolveResponse accept(@RequestAttribute("userId") String userId,
                                                    @PathVariable("slot") int slot) {
        return tradeService.accept(userId, requireSlotNo(slot));
    }

    @PostMapping("/api/trade/{slot}/decline")
    public TradeService.TradeResolveResponse decline(@RequestAttribute("userId") String userId,
                                                     @PathVariable("slot") int slot) {
        return tradeService.decline(userId, requireSlotNo(slot));
    }

    private static int requireSlotNo(int slot) {
        if (slot < 1 || slot > 3) {
            throw ApiException.validation("트레이드 슬롯 번호는 1|2|3 만 허용됩니다: " + slot);
        }
        return slot;
    }
}
