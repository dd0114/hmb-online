package online.hmb.match;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/relations (AC-C4, openapi-v2 RelationsResponse) — 팀 사기(morale/streak) + 보유 선수별
 * 신뢰도(trust)·성격(personality). 브리핑/덱 화면 표시용. 관계 갱신은 매치 FINISHED 트랜잭션에서
 * 서버가 처리(RelationService.applyMatchResult).
 */
@RestController
public class RelationsController {

    private final RelationService relationService;

    public RelationsController(RelationService relationService) {
        this.relationService = relationService;
    }

    @GetMapping("/api/relations")
    public RelationService.Relations getRelations(@RequestAttribute("userId") String userId) {
        return relationService.getRelations(userId);
    }
}
