package online.hmb.league;

import online.hmb.match.MatchOrchestrator;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 리그 API (openapi-v2 league 3종, AC-F). 도메인 로직·트랜잭션 = {@link LeagueService}(컨트롤러는 얇게).
 * next-match 후 봇(away/home) 잡 프리페치는 기존 매치 플로우와 동일하게 오케스트레이터에 위임한다.
 */
@RestController
public class LeagueController {

    private final LeagueService leagueService;
    private final MatchOrchestrator orchestrator;

    public LeagueController(LeagueService leagueService, MatchOrchestrator orchestrator) {
        this.leagueService = leagueService;
        this.orchestrator = orchestrator;
    }

    @PostMapping("/api/league/start")
    public LeagueService.LeagueResponse start(@RequestAttribute("userId") String userId) {
        return leagueService.startSeason(userId);
    }

    @GetMapping("/api/league")
    public LeagueService.LeagueResponse get(@RequestAttribute("userId") String userId) {
        return leagueService.getLeague(userId);
    }

    /**
     * 디비전 통합 랭킹보드(#319) — 정렬 = <b>디비전 우선 → 승점</b>(hero Q2).
     *
     * <p>⚠️ 매핑 순서상 이 메서드는 {@code /api/league} 보다 <b>구체적인 경로</b>라 충돌하지 않는다
     * (Spring 은 리터럴 경로를 정확히 매칭한다). {@code /api/league/{something}} 같은 변수 경로를
     * 나중에 추가하면 그때 순서를 확인해라.
     */
    @GetMapping("/api/league/rankings")
    public LeagueService.LeagueRankingsResponse rankings(
            @RequestAttribute("userId") String userId,
            @RequestParam(name = "scope", defaultValue = "global") String scope,
            @RequestParam(name = "limit", defaultValue = "50") int limit) {
        return leagueService.rankings(userId, scope, limit);
    }

    @PostMapping("/api/league/next-match")
    public ResponseEntity<LeagueService.LeagueNextMatchResponse> nextMatch(
            @RequestAttribute("userId") String userId) {
        LeagueService.LeagueNextMatchResponse response = leagueService.nextMatch(userId);
        // A 프리페치(#95): 유저팀 A + 봇 A 를 브리핑 진입 즉시 크로스매치 캐시로 enqueue(매치 플로우와 동일).
        orchestrator.prefetchBaseInputs(response.match().id());
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }
}
