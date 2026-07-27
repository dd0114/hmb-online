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
    private final online.hmb.match.DeckPrewarmService prewarmService;

    public OnboardingController(OnboardingService onboardingService,
                                online.hmb.match.DeckPrewarmService prewarmService) {
        this.onboardingService = onboardingService;
        this.prewarmService = prewarmService;
    }

    @GetMapping("/api/me/starter-grant")
    public OnboardingService.StarterGrantResponse starterGrant(@RequestAttribute("userId") String userId) {
        return onboardingService.starterGrant(userId)
                .map(p -> new OnboardingService.StarterGrantResponse(true, p))
                .orElseGet(() -> new OnboardingService.StarterGrantResponse(false, null));
    }

    @PostMapping("/api/me/tutorial-complete")
    public OnboardingService.Result completeTutorial(@RequestAttribute("userId") String userId) {
        OnboardingService.Result result = onboardingService.complete(userId);
        if (result.deckGranted()) {
            // 가입 직후 첫 경기가 곧바로 이어지는 경로다 — 덱을 받은 그 순간 A 를 돌려두지 않으면
            // 신규 유저는 항상 풀생성 폴백을 본다(#215 W1 의 오픈베타 테스터 케이스).
            prewarmService.onDeckSaved(userId);
        }
        return result;
    }
}
