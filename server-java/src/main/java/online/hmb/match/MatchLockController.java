package online.hmb.match;

import java.util.Optional;
import online.hmb.match.MatchService.MatchDetail;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * GET /api/me/active-match (#217 AC1) — <b>재입장의 유일한 진입점</b>.
 *
 * <p>web 은 로그인 직후·로비 진입마다 이걸 물어 진행 중 매치가 있으면 그 매치로 보낸다. 새로고침·
 * 재로그인·다른 기기가 전부 같은 답을 받는 이유는 상태가 서버에만 있기 때문이다(로컬 저장 0).
 *
 * <p><b>왜 MeController 가 아닌가</b>: 이 응답은 {@link MatchDetail} 통짜다 — 그래야 web 이 한 번의
 * 요청으로 {@code clock} 까지 받아 <b>seek-to-now</b>(#170 기존 경로)를 그대로 태울 수 있다.
 * meta 패키지가 매치 상세 조립을 끌어오지 않도록 매치 도메인에 둔다.
 */
@RestController
public class MatchLockController {

    private final MatchLockService lockService;
    private final MatchService matchService;
    private final MatchClockService clockService;

    public MatchLockController(MatchLockService lockService, MatchService matchService,
                               MatchClockService clockService) {
        this.lockService = lockService;
        this.matchService = matchService;
        this.clockService = clockService;
    }

    /**
     * @param match      진행 중 매치 상세(없으면 null)
     * @param locked     이미 킥오프했나 = web 이 메타 화면을 막고 강제 재입장시켜야 하는가(AC1/AC2)
     * @param abandonable 지금 포기 버튼을 보여도 되는가(AC3) — 판정은 서버가 한다(리롤 방지 규칙이
     *                    클라에 복제되면 조용히 어긋난다)
     */
    public record ActiveMatchResponse(MatchDetail match, boolean locked, boolean abandonable) {
    }

    @GetMapping("/api/me/active-match")
    public ActiveMatchResponse activeMatch(@RequestAttribute("userId") String userId) {
        Optional<MatchService.MatchRow> found = lockService.activeMatch(userId);
        if (found.isEmpty()) {
            return new ActiveMatchResponse(null, false, false);
        }
        // 만료된 단계를 먼저 반영한다 — 안 그러면 "전반 진행 중"으로 돌아갔는데 이미 감독시간인
        // 화면을 1초(스위퍼 주기) 동안 보게 된다. GET /api/matches/{id} 와 같은 가벼운 전이만.
        clockService.advanceDueForRead(found.get().id());
        MatchService.MatchRow row = matchService.getOwned(userId, found.get().id());
        if (!MatchService.ACTIVE_STATES.contains(row.state())) {
            return new ActiveMatchResponse(null, false, false); // 방금 끝났다
        }
        return new ActiveMatchResponse(matchService.toDetail(row),
                MatchLockService.isLocked(row), lockService.abandonable(row));
    }
}
