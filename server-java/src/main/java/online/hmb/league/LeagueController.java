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
    private final online.hmb.events.BusinessEventRecorder events;

    public LeagueController(LeagueService leagueService, MatchOrchestrator orchestrator,
                            online.hmb.events.BusinessEventRecorder events) {
        this.leagueService = leagueService;
        this.orchestrator = orchestrator;
        this.events = events;
    }

    /**
     * 시즌 시작(멱등). 시즌이 만들어지면 그 자리에서 <b>상대 9팀 전부의 A 를 예열</b>한다(#402 AC7).
     *
     * <p>왜 여기인가: 리그는 더블 라운드로빈이라 상대를 각각 두 번 만난다. A 를 매치 생성 때만
     * 예열하면 첫 만남 9번이 전부 풀생성(라이브 19~107초)이고 두 번째 만남만 캐시에 맞는다.
     * 시즌이 생기는 순간 상대는 이미 정해져 있으므로 한꺼번에 세워 둔다.
     *
     * <p>⚠️ {@code startSeason} 의 <b>트랜잭션이 커밋된 뒤</b>다. 선실행은 최적화지 정합성 경로가
     * 아니므로 큐잉이 시즌 생성 트랜잭션을 오염시키거나 실패시키면 안 된다(오케스트레이터가
     * 봇 단위로 예외를 삼킨다). 이미 ACTIVE 인 시즌으로 되돌아온 경우에도 같은 자리를 지난다 —
     * 전부 멱등이라 새 잡은 생기지 않고, 캐시가 회수된 뒤라면 오히려 복구된다.
     */
    @PostMapping("/api/league/start")
    public LeagueService.LeagueResponse start(@RequestAttribute("userId") String userId) {
        // #492: 시즌이 **새로 생겼는지**는 호출 전 상태로만 알 수 있다(startSeason 은 멱등이라
        // 재진입도 같은 모양의 응답을 준다). 맨몸 조회는 계측이 시즌 시작을 실패시킬 수 있으므로
        // probe 로 감싼다 — 실패하면 "이미 있었다"로 보수적으로 판단해 이벤트를 남기지 않는다.
        String activeBefore = events.probe(() -> leagueService.activeSeasonIdOrNull(userId), null);
        LeagueService.LeagueResponse response = leagueService.startSeason(userId);
        // ⚠️ **재진입 분기에서는 기록하지 않는다**(LeagueService:235) — 시즌 화면을 열 때마다
        //    'league_season_start' 가 쌓이면 "몇 번째 시즌인가"가 이벤트 수로 답해지지 않는다.
        //    훅이 컨트롤러인 이유는 startSeason 이 **메서드 전체가 트랜잭션**이기 때문이다.
        LeagueService.LeagueSeason season = response.season();
        if (season != null && !season.id().equals(activeBefore)) {
            events.record(online.hmb.events.BusinessEvent.LEAGUE_SEASON_START, userId,
                    () -> java.util.Map.of(
                            "seasonId", season.id(),
                            "seasonNo", season.seasonNo(),
                            "division", season.division()));
        }
        orchestrator.prefetchBotBaseInputs(opponentTeamIds(response));
        return response;
    }

    /** 이 시즌의 상대(봇) teamId = bots.id. 유저 팀은 빠진다. */
    private static java.util.List<String> opponentTeamIds(LeagueService.LeagueResponse response) {
        if (response.season() == null || response.season().teams() == null) {
            return java.util.List.of();
        }
        return response.season().teams().stream()
                .filter(t -> !t.isUser())
                .map(LeagueService.LeagueTeam::teamId)
                .toList();
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
        // ⚠️ **픽스처 재사용 분기는 이벤트가 아니다**(LeagueService:300) — 진행 중이던 매치로
        //    돌아가는 것은 재입장이지 매치 생성이 아니다. 그걸 세면 "몇 판 시작했나"가 새로고침
        //    횟수를 센다. 생성 여부는 응답 상태(BRIEFING 이면서 처음 만들어진 것)로는 알 수 없으므로
        //    **호출 전 그 픽스처에 살아 있는 매치가 있었는가**로 가른다.
        String reusedMatchId = events.probe(() -> leagueService.activeNextFixtureMatchIdOrNull(userId), "?");
        LeagueService.LeagueNextMatchResponse response = leagueService.nextMatch(userId);
        // A 프리페치(#95): 유저팀 A + 봇 A 를 브리핑 진입 즉시 크로스매치 캐시로 enqueue(매치 플로우와 동일).
        orchestrator.prefetchBaseInputs(response.match().id());
        if (!response.match().id().equals(reusedMatchId)) {
            LeagueService.LeagueFixture fixture = response.fixture();
            // 봇 팀 = 픽스처의 유저 팀이 아닌 쪽. 판정 리터럴을 다시 적지 않는다(SoT = LeagueService 상수).
            String botTeamId = LeagueService.USER_TEAM_ID.equals(fixture.homeTeam())
                    ? fixture.awayTeam() : fixture.homeTeam();
            events.record(online.hmb.events.BusinessEvent.MATCH_START, userId, () -> java.util.Map.of(
                    "mode", online.hmb.events.BusinessEvent.MODE_LEAGUE,
                    "matchId", response.match().id(),
                    "botId", botTeamId,
                    "leagueFixtureId", fixture.id(),
                    "round", fixture.round()));
        }
        return ResponseEntity.status(HttpStatus.CREATED).body(response);
    }
}
