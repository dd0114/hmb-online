package online.hmb.meta;

import online.hmb.match.MatchLockService;
import online.hmb.meta.DeckService.DeckResponse;
import online.hmb.meta.DeckService.DeckUpdateRequest;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** GET/PUT /api/deck — LLD §4, AC-S2. */
@RestController
public class DeckController {

    private final DeckService deckService;
    private final MatchLockService lockService;
    private final online.hmb.match.DeckPrewarmService prewarmService;

    public DeckController(DeckService deckService,
                          MatchLockService lockService,
                          online.hmb.match.DeckPrewarmService prewarmService) {
        this.deckService = deckService;
        this.lockService = lockService;
        this.prewarmService = prewarmService;
    }

    @GetMapping("/api/deck")
    public DeckResponse getDeck(@RequestAttribute("userId") String userId) {
        return deckService.getActiveDeck(userId);
    }

    /**
     * 순서가 계약이다: <b>잠금 검사 → 저장 → 선실행</b>.
     * 잠긴 매치(#217)면 저장 자체가 409 라 선실행도 일어나지 않아야 하고(안 그러면 거부된 덱으로 AI 를
     * 태운다), 선실행은 저장이 커밋된 뒤여야 그 덱의 A 를 만든다(#215).
     */
    @PutMapping("/api/deck")
    public DeckResponse putDeck(@RequestAttribute("userId") String userId,
                                 @RequestBody DeckUpdateRequest request) {
        // #217 AC2: 이미 킥오프한 매치가 있으면 덱은 읽기 전용이다. 덱은 하프타임 교체 벤치의
        // 원장이라, 진행 중에 바꾸면 화면(현재 덱)과 매치 스냅샷이 소리 없이 어긋난다.
        // BRIEFING 은 잠그지 않는다 — 킥오프 재캡처(AC-B2)가 명시적으로 지원하는 창이다.
        lockService.assertNotLocked(userId, "deck.replace");
        DeckResponse saved = deckService.replaceDeck(userId, request);
        // 저장이 커밋된 뒤 AI 인풋을 미리 돌린다(#215 W2) — 응답을 막지 않도록 큐잉만 하고 끝낸다.
        // 컨트롤러에서 부르는 건 MatchController 의 prefetchBaseInputs 와 같은 자리·같은 이유다.
        prewarmService.onDeckSaved(userId);
        return saved;
    }
}
