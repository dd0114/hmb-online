package online.hmb.meta;

import com.fasterxml.jackson.databind.JsonNode;
import java.util.List;
import online.hmb.meta.DeckService.DeckResponse;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import online.hmb.match.MatchLockService;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * 팀 스냅샷 프리셋 3슬롯 — LLD-p2-server §2 (AC-B1~B2).
 * GET /api/presets/team, PUT /api/presets/team/{slot}, POST /api/presets/team/{slot}/apply.
 * (기존 문자열 프리셋 {@link PresetController} 는 유지 — 위치만 웹에서 재배치.)
 */
@RestController
public class TeamPresetController {

    private final TeamPresetService service;
    private final MatchLockService lockService;

    public TeamPresetController(TeamPresetService service, MatchLockService lockService) {
        this.service = service;
        this.lockService = lockService;
    }

    @GetMapping("/api/presets/team")
    public List<TeamPresetService.PresetSlot> list(@RequestAttribute("userId") String userId) {
        return service.listSlots(userId);
    }

    @PutMapping("/api/presets/team/{slot}")
    public TeamPresetService.PresetSlot save(@RequestAttribute("userId") String userId,
                                             @PathVariable("slot") int slot,
                                             @RequestBody JsonNode body) {
        return service.save(userId, slot, body);
    }

    @PostMapping("/api/presets/team/{slot}/apply")
    public DeckResponse apply(@RequestAttribute("userId") String userId,
                              @PathVariable("slot") int slot) {
        // apply 는 활성 덱 통짜 덮어쓰기 = PUT /api/deck 과 같은 쓰기다(#217 AC2).
        lockService.assertNotLocked(userId, "preset.apply");
        return service.apply(userId, slot);
    }
}
