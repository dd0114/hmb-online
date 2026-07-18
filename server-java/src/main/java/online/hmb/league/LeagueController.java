package online.hmb.league;

import online.hmb.match.MatchOrchestrator;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
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

    @PostMapping("/api/league/next-match")
    public ResponseEntity<LeagueService.LeagueNextMatchResponse> nextMatch(
            @RequestAttribute("userId") String userId) {
        LeagueService.LeagueNextMatchResponse response = leagueService.nextMatch(userId);
        // #1 프리페치: 봇 h1 잡을 브리핑 진입 즉시 enqueue(기존 매치 플로우와 동일 — 크리티컬 패스에서 봇 제거).
        orchestrator.prefetchBotHalf(response.match().id(), 1);
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }
}
