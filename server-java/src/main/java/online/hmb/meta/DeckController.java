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

    public DeckController(DeckService deckService, MatchLockService lockService) {
        this.deckService = deckService;
        this.lockService = lockService;
    }

    @GetMapping("/api/deck")
    public DeckResponse getDeck(@RequestAttribute("userId") String userId) {
        return deckService.getActiveDeck(userId);
    }

    @PutMapping("/api/deck")
    public DeckResponse putDeck(@RequestAttribute("userId") String userId,
                                 @RequestBody DeckUpdateRequest request) {
        // #217 AC2: 이미 킥오프한 매치가 있으면 덱은 읽기 전용이다. 덱은 하프타임 교체 벤치의
        // 원장이라, 진행 중에 바꾸면 화면(현재 덱)과 매치 스냅샷이 소리 없이 어긋난다.
        // BRIEFING 은 잠그지 않는다 — 킥오프 재캡처(AC-B2)가 명시적으로 지원하는 창이다.
        lockService.assertNotLocked(userId, "deck.replace");
        return deckService.replaceDeck(userId, request);
    }
}
