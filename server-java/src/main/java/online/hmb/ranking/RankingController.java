package online.hmb.ranking;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 랭킹 API (AC-E2, openapi-v2 GET /api/rankings). 컨트롤러는 얇게 — 집계·파생은 {@link RankingService}.
 */
@RestController
public class RankingController {

    private final RankingService rankingService;

    public RankingController(RankingService rankingService) {
        this.rankingService = rankingService;
    }

    @GetMapping("/api/rankings")
    public RankingService.RankingsResponse rankings(@RequestAttribute("userId") String userId,
                                                    @RequestParam(name = "limit", defaultValue = "20") int limit) {
        return rankingService.getRankings(userId, limit);
    }
}
