package online.hmb.rewards;

import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * 보상 봉투 엔드포인트(#405 W2b, 설계 §2.9).
 *
 * <ul>
 *   <li>POST /api/rewards/{bundleId}/ack — 확인 처리(<b>멱등</b>, 이미 확인이면 그대로 200)</li>
 * </ul>
 *
 * <p>조회는 별도 경로를 두지 않는다 — 봉투는 그것을 만든 화면(매치 결과)에 <b>additive 블록</b>으로
 * 실려 온다(#368 선례). 별도 GET 을 두면 클라가 결과 화면에서 두 번 왕복하게 된다.
 */
@RestController
public class RewardController {

    private final RewardBundleService rewardBundleService;

    public RewardController(RewardBundleService rewardBundleService) {
        this.rewardBundleService = rewardBundleService;
    }

    @PostMapping("/api/rewards/{bundleId}/ack")
    public RewardBundleService.Bundle ack(@RequestAttribute("userId") String userId,
                                          @PathVariable("bundleId") String bundleId) {
        return rewardBundleService.acknowledge(userId, bundleId);
    }
}
