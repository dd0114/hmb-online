package online.hmb.away;

import java.util.List;
import online.hmb.match.MatchLockService;
import online.hmb.match.MatchService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 원정 API (#245).
 *
 * <ul>
 *   <li>{@code POST /api/away/matches} — 원정 출발(상대 = 실유저 덱 고스트)</li>
 *   <li>{@code GET  /api/me/away-reports} — 피원정 리포트 + 부재중 요약(요구 1·3)</li>
 *   <li>{@code POST /api/me/away-reports/ack} — 팝업 확인(멱등)</li>
 * </ul>
 */
@RestController
public class AwayController {

    private final AwayService awayService;
    private final MatchService matchService;
    private final MatchLockService lockService;
    private final AwaySeasonService seasonService;

    public AwayController(AwayService awayService, MatchService matchService,
                          MatchLockService lockService,
                          AwaySeasonService seasonService) {
        this.awayService = awayService;
        this.matchService = matchService;
        this.lockService = lockService;
        this.seasonService = seasonService;
    }

    /**
     * 원정 매치 생성. 진행 중 매치가 있으면 409 {@code MATCH_IN_PROGRESS}(#217) — 새 매치를 만드는
     * 경로는 전부 같은 게이트를 지난다. 게이트를 빠뜨리면 원정이 잠금의 우회로가 된다.
     */
    /**
     * 원정 매치 생성. 상대는 <b>서버가 고른다</b>.
     *
     * <p>⚠️ 상대 <b>지목</b>은 열지 않는다(#245 독립검증 MAJ-4). 레이팅이 ±10 으로 움직이는 축이 된 이상
     * 클라가 상대를 고를 수 있으면 부계정을 반복 지목해 레이팅을 무한 생성할 수 있다. 지목 원정은
     * 쿨다운·중복 제한·상대 동의 같은 규칙을 정한 뒤에 여는 기능이지, 파라미터 하나로 여는 게 아니다.
     * (서비스 계층 {@code AwayService#start(String, String)} 의 지목 인자는 테스트 시임이다.)
     */
    @PostMapping("/api/away/matches")
    public ResponseEntity<MatchService.MatchDetail> start(@RequestAttribute("userId") String userId,
                                                          @RequestBody(required = false) StartRequest request) {
        lockService.assertCanCreateMatch(userId);
        MatchService.MatchRow row = awayService.start(userId,
                request == null ? null : request.defenderId());
        return ResponseEntity.status(HttpStatus.CREATED).body(matchService.toDetail(row));
    }

    /**
     * 상대 후보 제시(hero E2/E3) — 레이팅이 비슷한 사람 중 무작위 N명. 화면은 이 중 하나를 골라
     * {@code POST /api/away/matches} 에 실어 보낸다(그 밖의 id 는 서버가 거부한다).
     */
    @GetMapping("/api/away/candidates")
    public CandidatesResponse candidates(@RequestAttribute("userId") String userId) {
        AwaySeasonService.Season season = seasonService.current();
        return new CandidatesResponse(awayService.offerCandidates(userId),
                awayService.streakOf(userId), season.seasonNo(), season.endsAt(),
                awayService.remainingToday(userId));
    }

    /** 시즌 현황 + 내 지난 성적(hero E5) — "이번 주 언제 끝나고 지난주 몇 등이었나". */
    @GetMapping("/api/away/season")
    public SeasonResponse season(@RequestAttribute("userId") String userId) {
        AwaySeasonService.Season s = seasonService.current();
        return new SeasonResponse(s.seasonNo(), s.startedAt(), s.endsAt(),
                awayService.streakOf(userId), seasonService.myHistory(userId, 8));
    }

    /**
     * 복수 큐(#286 W4 · #319) — 나를 친 최근 기록 ≤5 + 오늘 남은 원정 횟수.
     *
     * <p>남은 횟수를 <b>같이</b> 싣는 이유는 후보 응답과 같다: 눌렀는데 거부되는 건 나쁜 UX 다.
     * 복수 판도 일반 원정과 <b>같은 한도</b>를 쓴다(hero Q3-②).
     */
    @GetMapping("/api/away/revenge")
    public AwayService.RevengeResponse revenge(@RequestAttribute("userId") String userId) {
        return awayService.revengeQueue(userId);
    }

    /**
     * 지목 복수 경기 생성 — <b>이 서버에서 상대를 고를 수 있는 유일한 경로</b>다.
     *
     * <p>⚠️ 그래서 게이트가 두 층이다. ①{@code assertCanCreateMatch} — 새 매치를 만드는 모든 경로가
     * 지나는 잠금(#217). 빠뜨리면 복수가 잠금의 우회로가 된다. ②{@code startRevenge} 안의 복수
     * 자물쇠(소유·방어함·연쇄·완료·소진·창·일일한도) — 클라가 버튼을 숨기는 것은 <b>안내</b>이고,
     * 거부는 여기서만 일어난다.
     */
    @PostMapping("/api/away/revenge/{reportId}/matches")
    public ResponseEntity<MatchService.MatchDetail> startRevenge(
            @RequestAttribute("userId") String userId,
            @PathVariable("reportId") String reportId) {
        lockService.assertCanCreateMatch(userId);
        return ResponseEntity.status(HttpStatus.CREATED)
                .body(matchService.toDetail(awayService.startRevenge(userId, reportId)));
    }

    /**
     * 원정 레이팅 랭킹보드(#319). 순위 정의는 <b>시즌 마감과 같은 함수</b>가 소유한다
     * ({@code AwaySeasonService.standings}) — 보드가 마감과 다른 표를 그리면 "1등이었는데 보상은
     * 3등"이 되고, 그 불일치는 원장이 있어도 복구되지 않는다.
     */
    @GetMapping("/api/away/rankings")
    public AwayService.RankingsResponse rankings(@RequestAttribute("userId") String userId,
                                                 @RequestParam(name = "limit", defaultValue = "50")
                                                 int limit) {
        return awayService.rankings(userId, limit);
    }

    @GetMapping("/api/me/away-reports")
    public AwayService.ReportsResponse reports(@RequestAttribute("userId") String userId,
                                               @RequestParam(name = "status", defaultValue = "unseen")
                                               String status) {
        return awayService.reports(userId, status);
    }

    @PostMapping("/api/me/away-reports/ack")
    public AckResponse ack(@RequestAttribute("userId") String userId,
                           @RequestBody(required = false) AckRequest request) {
        return new AckResponse(awayService.ack(userId, request == null ? null : request.ids()));
    }

    /**
     * defenderId = **직전에 제시받은 후보 중 하나**(hero E2). 비우면 서버가 무작위로 고른다.
     * ⚠️ 임의 id 는 거부된다 — 제시 목록은 서버가 소유한다(`away_offers`). 그게 "2택"과 "지목"의 차이다.
     */
    public record StartRequest(String defenderId) {
    }

    /** remainingToday: 오늘 남은 원정 횟수. <b>-1 = 무제한</b>(daily-limit 0). */
    public record CandidatesResponse(List<AwayService.Candidate> candidates, int streak,
                                     int seasonNo, String seasonEndsAt, int remainingToday) {
    }

    public record SeasonResponse(int seasonNo, String startedAt, String endsAt, int streak,
                                 List<java.util.Map<String, Object>> history) {
    }

    public record AckRequest(List<String> ids) {
    }

    public record AckResponse(int acked) {
    }
}
