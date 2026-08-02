package online.hmb.growth;

import java.util.Map;
import online.hmb.common.ApiException;
import online.hmb.match.MatchLockService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 성장/성★/잠재 엔드포인트 — 메이플 피벗 V2 (에픽 #179, SoT §V2-4). 계산·트랜잭션·멱등은
 * {@link GrowthService}. 구 enhance/limitbreak 엔드포인트는 제거됐다(폐기 모델).
 *
 * <ul>
 *   <li>GET  /api/growth/card/{playerId}   — CardEffective(스탯Lv·★·잠재 lines·caps·ovr·완성도)</li>
 *   <li>POST /api/growth/star              — 성★ 승급(중복 N → 스탯 천장 개방 + 잠재 티어 캡 상향)</li>
 *   <li>POST /api/growth/dice              — 잠재 리롤(NORMAL|CASH → 3줄 리롤 + 승급 판정).
 *       <b>#247 로 구매 단계가 사라졌다</b> — 재고를 깎지 않고 지갑에서 직접 결제한다.
 *       그래서 잔액조회 {@code GET /api/growth/dice} 도 같이 은퇴했다(잔액이라는 게 없다).</li>
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

    public record ChoiceRequest(String stat) {
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

    /**
     * 대기 중인 3지선다 목록(#405 W2b). {@code playerId} 를 주면 그 카드만 — 강화탭은 카드별로,
     * 홈 뱃지는 전체로 묻는다.
     */
    @GetMapping("/api/growth/choices")
    public Map<String, Object> choices(@RequestAttribute("userId") String userId,
                                       @RequestParam(name = "playerId", required = false) String playerId) {
        return Map.of("choices", growthService.pendingChoices(userId,
                playerId == null || playerId.isBlank() ? null : playerId));
    }

    /**
     * 3지선다 선택 — 박제된 gain 을 {@code stat_add_json} 에 가산한다.
     *
     * <p>⚠️ {@code growth.star}·{@code growth.dice} 와 <b>같은 이유로</b> 진행 중 매치에서 막는다
     * (#217 AC2): {@code MatchOrchestrator.buildSelectData} 가 시뮬 시점에 유효스탯을 읽으므로,
     * 전·후반 사이에 스탯을 올리면 같은 경기 안에서 후반만 강해진다. 취향이 아니라 버그 차단이다.
     */
    @PostMapping("/api/growth/choices/{choiceId}")
    public Map<String, Object> choose(@RequestAttribute("userId") String userId,
                                      @PathVariable("choiceId") String choiceId,
                                      @RequestBody(required = false) ChoiceRequest body) {
        lockService.assertNotLocked(userId, "growth.choice");
        if (body == null || body.stat() == null || body.stat().isBlank()) {
            throw ApiException.validation("stat이 필요합니다");
        }
        return growthService.applyChoice(userId, choiceId, body.stat());
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
