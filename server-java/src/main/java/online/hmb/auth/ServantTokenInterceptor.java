package online.hmb.auth;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import online.hmb.common.ApiException;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

/**
 * /internal/** 보호(AC-Q3, W4). 서번트 전용 shared secret을 X-Servant-Token 헤더로 검사한다 —
 * 없거나 틀리면 401 UNAUTHORIZED. health 포함 전 /internal/* 에 적용(W0 InternalHealthController의
 * "TODO W4: 인증" 해소).
 *
 * 비교는 상수시간(MessageDigest.isEqual) — 타이밍 사이드채널로 토큰을 알아내지 못하게 한다.
 */
@Component
public class ServantTokenInterceptor implements HandlerInterceptor {

    private final byte[] expectedToken;

    public ServantTokenInterceptor(@Value("${hmb.servant.internal-token}") String internalToken) {
        this.expectedToken = internalToken.getBytes(StandardCharsets.UTF_8);
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        String provided = request.getHeader("X-Servant-Token");
        byte[] providedBytes = provided == null ? new byte[0] : provided.getBytes(StandardCharsets.UTF_8);
        // MessageDigest.isEqual은 길이 인지 상수시간 비교 — 존재/불일치 모두 동일 코드경로로 401.
        if (!MessageDigest.isEqual(providedBytes, expectedToken)) {
            throw ApiException.unauthorized("유효하지 않은 서번트 토큰입니다");
        }
        return true;
    }
}
