package online.hmb.growth;

import java.util.Map;
import online.hmb.common.ApiException;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 성장/강화 엔드포인트 (에픽 #179). 계산·트랜잭션·멱등은 {@link GrowthService}.
 *
 * <ul>
 *   <li>GET  /api/growth/card/{playerId}   — CardEffective(시안3: base/attributes/caps/ovr/완성도/등급)</li>
 *   <li>POST /api/growth/enhance           — 강화(중복1+포인트 → cap 내 fill↑, 상한 도달 시 4xx)</li>
 *   <li>POST /api/growth/limitbreak        — 한계돌파(중복 N → effectiveGrade↑, 강화 상한 재개방)</li>
 *   <li>GET  /api/growth/report/{matchId}  — MatchGrowthReport(ResultPage 성장 리포트)</li>
 * </ul>
 */
@RestController
public class GrowthController {

    private final GrowthService growthService;

    public GrowthController(GrowthService growthService) {
        this.growthService = growthService;
    }

    public record PlayerRef(String playerId) {
    }

    @GetMapping("/api/growth/card/{playerId}")
    public Map<String, Object> card(@RequestAttribute("userId") String userId,
                                    @PathVariable("playerId") String playerId) {
        return growthService.cardEffective(userId, playerId);
    }

    @PostMapping("/api/growth/enhance")
    public Map<String, Object> enhance(@RequestAttribute("userId") String userId,
                                       @RequestBody(required = false) PlayerRef body) {
        return growthService.enhance(userId, requirePlayerId(body));
    }

    @PostMapping("/api/growth/limitbreak")
    public Map<String, Object> limitBreak(@RequestAttribute("userId") String userId,
                                          @RequestBody(required = false) PlayerRef body) {
        return growthService.limitBreak(userId, requirePlayerId(body));
    }

    @GetMapping("/api/growth/report/{matchId}")
    public Map<String, Object> report(@RequestAttribute("userId") String userId,
                                      @PathVariable("matchId") String matchId) {
        return growthService.growthReport(userId, matchId);
    }

    private static String requirePlayerId(PlayerRef body) {
        if (body == null || body.playerId() == null || body.playerId().isBlank()) {
            throw ApiException.validation("playerId가 필요합니다");
        }
        return body.playerId();
    }
}
