package online.hmb.notice;

import java.util.List;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

/**
 * {@code GET /api/notices/active} — 홈(로비) 팝업이 읽는 공개 피드 (#248 §2.1, hero 컨펌 Q5).
 *
 * <p><b>인증이 필요 없다</b>({@code WebMvcConfig.excludePathPatterns}). 근거는 {@code /api/config}
 * 와 같다 — 유저별 데이터가 0인 전체 브로드캐스트이고, 무엇보다 <b>점검 공지는 로그인이 안 될 때
 * 가장 필요하다</b>. 여기에 401 을 두면 정확히 그 순간에 안 보인다(#232 독립검증 BL-1 의 반복).
 * 계약 = {@code NoticeActiveApiTest.activeNoticesAreReachableWithoutAuth}.
 *
 * <p>응답은 항상 {@code {"notices":[…]}} 객체다(배열 통짜가 아니다). 필드를 나중에 얹을 때
 * 클라 파서를 깨지 않기 위한 것이고, 활성 0건이면 <b>빈 배열</b>이라 클라가 길이를 그대로 만져도 안전하다.
 */
@RestController
public class NoticeController {

    private final NoticeService notices;

    public NoticeController(NoticeService notices) {
        this.notices = notices;
    }

    @GetMapping("/api/notices/active")
    public ActiveNoticesResponse active() {
        return new ActiveNoticesResponse(notices.active());
    }

    public record ActiveNoticesResponse(List<NoticeService.ActiveNotice> notices) {
    }
}
