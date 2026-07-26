package online.hmb.meta;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * 온보딩 API (#209).
 *
 * <ul>
 *   <li>{@code GET  /api/me/starter-grant} — 가입 시 받은 최상위 유닛(연출 재료, AC3). 없으면 granted=false.</li>
 *   <li>{@code POST /api/me/tutorial-complete} — 튜토리얼 완료/건너뛰기. 멱등이며 덱이 없으면 지급(AC2).</li>
 * </ul>
 *
 * 계약 문서: web 측 타입 SoT 는 {@code apps/web/src/api/p3.ts}(openapi-v3 미발행 — P3/P4 관례).
 */
@RestController
public class OnboardingController {

    private final OnboardingService onboardingService;

    public OnboardingController(OnboardingService onboardingService) {
        this.onboardingService = onboardingService;
    }

    @GetMapping("/api/me/starter-grant")
    public OnboardingService.StarterGrantResponse starterGrant(@RequestAttribute("userId") String userId) {
        return onboardingService.starterGrant(userId)
                .map(p -> new OnboardingService.StarterGrantResponse(true, p))
                .orElseGet(() -> new OnboardingService.StarterGrantResponse(false, null));
    }

    @PostMapping("/api/me/tutorial-complete")
    public OnboardingService.Result completeTutorial(@RequestAttribute("userId") String userId) {
        return onboardingService.complete(userId);
    }
}
