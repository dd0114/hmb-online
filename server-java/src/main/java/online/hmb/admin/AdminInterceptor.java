package online.hmb.admin;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import online.hmb.auth.AuthInterceptor;
import online.hmb.common.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * {@code /api/admin/**} 전용 권한 게이트(AC-C2). 경로 <b>패턴</b>에 바인딩되므로 admin 엔드포인트를
 * 몇 개 추가하든 등록 작업이 없다 — 그게 "가드 빠뜨린 엔드포인트"를 구조적으로 막는 방식이다
 * ({@link AdminAccess} javadoc 참조).
 *
 * <p><b>{@link AuthInterceptor} 와의 관계(순서·중복 없음)</b>:
 * <ul>
 *   <li>{@code AuthInterceptor}(order 0) 가 {@code /api/**} 에서 <b>먼저</b> 돈다 —
 *       {@code /api/admin/**} 도 그 부분집합이라 토큰 검증은 <b>여기서 다시 하지 않는다</b>(중복 없음).
 *       미인증이면 그 단계에서 이미 401 이 나므로 이 인터셉터에는 도달하지 않는다.</li>
 *   <li>{@code AdminInterceptor}(order 10) 는 <b>인증 이후</b>의 인가만 본다 — 비admin 이면 403.</li>
 * </ul>
 * 순서는 등록 순서에 의존하지 않고 {@code WebMvcConfig} 에서 <b>명시적 order</b> 로 고정한다.
 *
 * <p>그럼에도 userId 부재를 401 로 처리하는 이유: 누군가 {@code AuthInterceptor} 의 경로 패턴을
 * 좁히면 이 인터셉터가 "인증 안 된 요청"을 받게 된다. 그 경우 attribute 가 없어 admin 판정이
 * 무의미해지므로 <b>열지 않고 401</b> 로 닫는다(fail-closed). 권한이 열리는 실패 모드가 없다.
 */
@Component
public class AdminInterceptor implements HandlerInterceptor {

    /** 게이트가 바인딩되는 유일한 경로 접두사. 이 값이 곧 "admin API 란 무엇인가"의 정의다. */
    public static final String ADMIN_PATH_PREFIX = "/api/admin/";
    public static final String ADMIN_PATH_PATTERN = "/api/admin/**";

    private final AdminAccess adminAccess;

    public AdminInterceptor(AdminAccess adminAccess) {
        this.adminAccess = adminAccess;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        Object userId = request.getAttribute(AuthInterceptor.USER_ID_ATTR);
        if (!(userId instanceof String uid) || uid.isBlank()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "유효하지 않거나 만료된 토큰입니다");
        }
        if (!adminAccess.isAdmin(uid)) {
            // 사유를 세분화하지 않는다(계정 권한 구조를 누설하지 않음). 부수효과는 이 시점에 0 —
            // 핸들러가 아직 실행되지 않았으므로 지갑·원장·감사 어디에도 쓰기가 일어나지 않는다.
            throw new ApiException(HttpStatus.FORBIDDEN, "FORBIDDEN", "admin 권한이 필요합니다");
        }
        return true;
    }
}
