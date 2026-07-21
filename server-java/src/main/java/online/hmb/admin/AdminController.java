package online.hmb.admin;

import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

/**
 * admin 운영 API(PRD-v4 §C). <b>이 클래스에 권한 검사 코드가 한 줄도 없다</b>는 게 설계의 핵심이다 —
 * {@code /api/admin/} 접두사에 걸린 {@link AdminInterceptor} 가 이미 걸렀고, 접두사를 벗어난 매핑은
 * {@link AdminRouteGuard} 가 부팅을 막는다. 컨트롤러가 가드를 "복사"하지 않으므로 빠뜨릴 수도 없다.
 *
 * <p>{@code userId} attribute 는 {@code AuthInterceptor} 가 넣어준 <b>액터(admin 본인)</b>다 —
 * 감사 로그의 actor 로 쓰인다.
 */
@RestController
@RequestMapping("/api/admin")
public class AdminController {

    private final AdminUserQueryService users;
    private final AdminPointsService points;

    public AdminController(AdminUserQueryService users, AdminPointsService points) {
        this.users = users;
        this.points = points;
    }

    /** 유저 목록·닉네임 검색·페이징. 비번은 조회 SQL 에도 DTO 에도 없다. */
    @GetMapping("/users")
    public AdminUserQueryService.UserPage listUsers(@RequestParam(name = "q", required = false) String q,
                                                     @RequestParam(name = "limit", required = false) Integer limit,
                                                     @RequestParam(name = "offset", required = false) Integer offset) {
        return users.list(q, limit, offset);
    }

    /** 유저 상태 — 지갑·보유 선수·덱/프리셋 요약·전적. */
    @GetMapping("/users/{id}")
    public AdminUserQueryService.UserDetail userDetail(@PathVariable("id") String id) {
        return users.detail(id);
    }

    /**
     * 포인트 지급(+)/차감(-). 바디 = {@code {delta, reason}}(web 과 확정된 계약).
     * {@code Idempotency-Key} 헤더를 주면 재전송이 중복 지급되지 않는다({@link AdminPointsService} 참조).
     */
    @PostMapping("/users/{id}/points")
    public AdminPointsService.GrantResult grantPoints(
            @RequestAttribute("userId") String actorUserId,
            @PathVariable("id") String targetUserId,
            @RequestBody GrantPointsRequest body,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        return points.grant(actorUserId, targetUserId,
                body == null ? null : body.delta(),
                body == null ? null : body.reason(),
                idempotencyKey);
    }

    /** 확정 계약 바디 — {@code memo} 가 아니라 {@code reason} 이다(web 세션 합의). */
    public record GrantPointsRequest(Long delta, String reason) {
    }
}
