package online.hmb.away;

import java.util.List;
import online.hmb.match.MatchLockService;
import online.hmb.match.MatchService;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.GetMapping;
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

    public AwayController(AwayService awayService, MatchService matchService,
                          MatchLockService lockService) {
        this.awayService = awayService;
        this.matchService = matchService;
        this.lockService = lockService;
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
        MatchService.MatchRow row = awayService.start(userId, null);
        return ResponseEntity.status(HttpStatus.CREATED).body(matchService.toDetail(row));
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

    /** 현재 바디는 비어 있다(상대는 서버가 고른다). 지목 원정을 열 땐 규칙과 함께 필드를 추가한다. */
    public record StartRequest() {
    }

    public record AckRequest(List<String> ids) {
    }

    public record AckResponse(int acked) {
    }
}
