package online.hmb.growth;

import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.match.MatchLockService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 성장/성★/잠재 엔드포인트 — 메이플 피벗 V2 (에픽 #179, SoT §V2-4). 계산·트랜잭션·멱등은
 * {@link GrowthService}. 구 enhance/limitbreak 엔드포인트는 제거됐다(폐기 모델).
 *
 * <ul>
 *   <li>GET  /api/growth/card/{playerId}   — CardEffective(스탯Lv·★·잠재 lines·caps·ovr·완성도)</li>
 *   <li>POST /api/growth/star              — 성★ 승급(중복 N → 스탯 천장 개방 + 잠재 티어 캡 상향)</li>
 *   <li>GET  /api/growth/dice              — DiceBalance {normal,cash}(페이지 로드 시 잔액 조회)</li>
 *   <li>POST /api/growth/dice              — 잠재 다이스 롤(NORMAL|CASH → 3줄 리롤 + 승급 판정)</li>
 *   <li>GET  /api/growth/report/{matchId}  — MatchGrowthReport(ResultPage 성장 리포트)</li>
 * </ul>
 */
@RestController
public class GrowthController {

    private final GrowthService growthService;
    private final MatchLockService lockService;

    public GrowthController(GrowthService growthService, MatchLockService lockService) {
        this.growthService = growthService;
        this.lockService = lockService;
    }

    public record PlayerRef(String playerId) {
    }

    public record DiceRequest(String playerId, String kind) {
    }

    @GetMapping("/api/growth/card/{playerId}")
    public Map<String, Object> card(@RequestAttribute("userId") String userId,
                                    @PathVariable("playerId") String playerId) {
        return growthService.cardEffective(userId, playerId);
    }

    @PostMapping("/api/growth/star")
    public Map<String, Object> star(@RequestAttribute("userId") String userId,
                                    @RequestBody(required = false) PlayerRef body) {
        // #217 AC2 — 이건 UX 잠금이 아니라 **버그 차단**이다: MatchOrchestrator.buildSelectData 가
        // 시뮬 시점에 growthService.effectiveAttributes 를 읽으므로, 전반과 후반 사이에 강화하면
        // 같은 경기 안에서 후반만 스탯이 오른다.
        lockService.assertNotLocked(userId, "growth.star");
        return growthService.starUp(userId, requirePlayerId(body));
    }

    @GetMapping("/api/growth/dice")
    public Map<String, Object> diceBalance(@RequestAttribute("userId") String userId) {
        return growthService.diceBalance(userId);
    }

    @PostMapping("/api/growth/dice")
    public Map<String, Object> dice(@RequestAttribute("userId") String userId,
                                    @RequestBody(required = false) DiceRequest body) {
        if (body == null || body.playerId() == null || body.playerId().isBlank()) {
            throw ApiException.validation("playerId가 필요합니다");
        }
        // 잠재 리롤도 유효스탯을 바꾼다 — star 와 같은 이유로 진행 중 매치에서는 막는다.
        lockService.assertNotLocked(userId, "growth.dice");
        return growthService.dice(userId, body.playerId(), body.kind());
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
