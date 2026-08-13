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
    private final online.hmb.events.BusinessEventRecorder events;

    public OnboardingController(OnboardingService onboardingService,
                                online.hmb.match.DeckPrewarmService prewarmService,
                                online.hmb.events.BusinessEventRecorder events) {
        this.onboardingService = onboardingService;
        this.prewarmService = prewarmService;
        this.events = events;
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
        // #492: 훅이 **컨트롤러**인 이유 = OnboardingService.complete 는 메서드 전체가 트랜잭션이라
        // (덱 지급이 그 안에서 일어난다) 안에 넣으면 기록 실패가 덱 지급을 롤백시킨다.
        // #496: 이 엔드포인트는 **멱등**이라 여러 번 불린다(모달을 다시 닫기·건너뛰기 재시도). 예전엔
        //    그때마다 1행을 남겨 스트림 상단이 같은 "튜토리얼 완료"로 도배됐다 — 퍼널의 tutorial 칸은
        //    "1건 이상"이라 수치는 멀쩡했지만, 스트림을 읽는 유일한 이유("이 유저가 무엇을 했나"를
        //    시간순으로 본다)가 갉힌다. `recordOnce` 가 **유저당 1행**으로 좁힌다.
        //    ⚠️ 게이트는 `users.tutorial_done` 플래그가 아니라 **스트림에 그 행이 있는가**다 —
        //    근거는 recordOnce javadoc(첫 기록이 실패하면 플래그 방식은 영영 결손된다).
        events.recordOnce(online.hmb.events.BusinessEvent.TUTORIAL_COMPLETE, userId,
                () -> java.util.Map.of("grantedDeck", result.deckGranted()));
        if (result.deckGranted()) {
            // 가입 직후 첫 경기가 곧바로 이어지는 경로다 — 덱을 받은 그 순간 A 를 돌려두지 않으면
            // 신규 유저는 항상 풀생성 폴백을 본다(#215 W1 의 오픈베타 테스터 케이스).
            prewarmService.onDeckSaved(userId);
        }
        return result;
    }
}
