package online.hmb.meta;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/users/{targetUserId}/squad} — 원정 후보·랭킹보드에서 유저를 눌렀을 때 여는
 * 선수단(#432, #403 W5 선행).
 *
 * <p>경로 변수 이름이 {@code targetUserId} 인 이유: 이 리포의 컨트롤러는 전부
 * {@code @RequestAttribute("userId")} 로 <b>본인</b>만 받아 왔다. 둘 다 {@code userId} 면 한 메서드
 * 안에 같은 이름의 "나"와 "남"이 생기고, 그 자리에서 잘못 쓰면 <b>남의 화면에 내 데이터</b>가
 * 뜬다. 이름으로 갈라 둔다.
 */
@RestController
public class UserSquadController {

    private final UserSquadService squadService;

    public UserSquadController(UserSquadService squadService) {
        this.squadService = squadService;
    }

    /** ⚠️ <b>읽기 전용</b> — {@code GET /api/deck} 의 AI 프리워밍 부수효과를 여기로 옮기지 마라. */
    @GetMapping("/api/users/{targetUserId}/squad")
    public UserSquadService.SquadResponse squad(@RequestAttribute("userId") String viewerId,
                                                @PathVariable("targetUserId") String targetUserId) {
        return squadService.squadOf(viewerId, targetUserId);
    }
}
