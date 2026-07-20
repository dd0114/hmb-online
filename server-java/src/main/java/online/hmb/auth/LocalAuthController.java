package online.hmb.auth;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/**
 * POST /api/auth/register — 자체 로그인 회원가입(P3 §A, AC-A1). additive 전용 엔드포인트라
 * {@link AuthController}(로그인)는 손대지 않는다 — 컨트롤러가 {@link AuthProvider} 인터페이스에만
 * 의존하는 구조(AuthProviderSwapTest) 유지.
 *
 * <p>인증 불필요(WebMvcConfig 가 {@code /api/auth/**} 를 AuthInterceptor 에서 제외).
 * 응답은 로그인과 같은 {@link AuthController.LoginResponse} 형태 — 가입 즉시 세션 토큰이 나온다.
 * 비번은 요청에만 존재하고 응답 어디에도 담기지 않는다(AC-A2).
 */
@RestController
public class LocalAuthController {

    private final LocalAuthProvider localAuthProvider;
    private final SessionService sessionService;

    public LocalAuthController(LocalAuthProvider localAuthProvider, SessionService sessionService) {
        this.localAuthProvider = localAuthProvider;
        this.sessionService = sessionService;
    }

    @PostMapping("/api/auth/register")
    public AuthController.LoginResponse register(@RequestBody RegisterRequest request) {
        AuthResult result = localAuthProvider.register(request);
        String token = sessionService.createSession(result.userId());
        return new AuthController.LoginResponse(
                token, new AuthController.LoginResponse.UserRef(result.userId(), result.nickname()), result.isNew());
    }
}
