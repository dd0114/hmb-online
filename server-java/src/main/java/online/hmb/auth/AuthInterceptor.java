package online.hmb.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.util.Optional;
import online.hmb.common.ApiException;
import org.springframework.http.HttpStatus;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * /api/** 보호(로그인 자체는 WebMvcConfig에서 제외). Authorization: Bearer <token> -> sessions 조회.
 * 인증 성공 시 request attribute "userId"에 세팅.
 */
@Component
public class AuthInterceptor implements HandlerInterceptor {

    public static final String USER_ID_ATTR = "userId";

    private final SessionService sessionService;

    public AuthInterceptor(SessionService sessionService) {
        this.sessionService = sessionService;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String header = request.getHeader("Authorization");
        String token = (header != null && header.startsWith("Bearer "))
                ? header.substring("Bearer ".length()).trim()
                : null;

        Optional<String> userId = sessionService.resolveUserId(token);
        if (userId.isEmpty()) {
            throw new ApiException(HttpStatus.UNAUTHORIZED, "UNAUTHORIZED", "유효하지 않거나 만료된 토큰입니다");
        }

        request.setAttribute(USER_ID_ATTR, userId.get());
        return true;
    }
}
