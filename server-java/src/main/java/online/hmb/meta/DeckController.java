package online.hmb.meta;

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

    public DeckController(DeckService deckService) {
        this.deckService = deckService;
    }

    @GetMapping("/api/deck")
    public DeckResponse getDeck(@RequestAttribute("userId") String userId) {
        return deckService.getActiveDeck(userId);
    }

    @PutMapping("/api/deck")
    public DeckResponse putDeck(@RequestAttribute("userId") String userId,
                                 @RequestBody DeckUpdateRequest request) {
        return deckService.replaceDeck(userId, request);
    }
}
