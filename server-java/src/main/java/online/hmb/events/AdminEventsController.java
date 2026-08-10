package online.hmb.events;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * 이벤트 보드 admin API (#492 D3 — <b>계약 동결</b>, web 이 이 스펙 그대로 목을 만든다).
 *
 * <ul>
 *   <li>{@code GET /api/admin/events?event=&userId=&mode=&limit=&offset=} — 스트림 + 필터·페이징</li>
 *   <li>{@code GET /api/admin/events/funnel} — <b>유저별 도달 지점</b>(hero 의 실제 목적)</li>
 * </ul>
 *
 * <p>미인증 401 / 비admin 403 은 <b>여기에 없다</b> — 경로가 {@code /api/admin/**} 이므로
 * {@code AdminInterceptor} 가 자동으로 덮고, {@code AdminGateTest} 가 핸들러 매핑을 반사로 훑어
 * 새 라우트까지 전부 커버한다(#492 R2). 여기에 가드를 또 짜면 규칙이 두 벌이 된다.
 *
 * <p>⚠️ 이 컨트롤러는 {@code AdminErrorHandler.assignableTypes} 에 등록돼 있다 — 빠뜨리면
 * {@code ?limit=abc} 같은 요청이 전역 핸들러로 떨어져 예외 메시지가 응답으로 샌다.
 *
 * <p>⚠️ 기간 필터({@code from}/{@code to})는 이 웨이브 스코프 밖이다(hero 승인안 B 축소).
 * 넣으려면 web 과 함께 계약을 다시 얼려야 한다.
 */
@RestController
@RequestMapping("/api/admin/events")
public class AdminEventsController {

    private final BusinessEventQueryService events;

    public AdminEventsController(BusinessEventQueryService events) {
        this.events = events;
    }

    /**
     * ⚠️ {@code /funnel} 보다 <b>뒤에 선언해도 상관없다</b> — 스프링은 리터럴 경로를 먼저 매칭한다.
     * 그래도 읽는 사람이 헷갈리지 않게 목록을 위에 둔다(AdminCatalogController 와 같은 관례).
     */
    @GetMapping
    public BusinessEventQueryService.EventPage list(
            @RequestParam(name = "event", required = false) String event,
            @RequestParam(name = "userId", required = false) String userId,
            @RequestParam(name = "mode", required = false) String mode,
            @RequestParam(name = "limit", required = false) Integer limit,
            @RequestParam(name = "offset", required = false) Integer offset) {
        return events.page(event, userId, mode, limit, offset);
    }

    /** 유저 1행 × 단계 체크 그리드의 데이터. 정렬 = 최근 움직인 순. */
    @GetMapping("/funnel")
    public BusinessEventQueryService.FunnelResponse funnel() {
        return events.funnel();
    }
}
