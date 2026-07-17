package online.hmb.auth;

/**
 * 인증 공급자 인터페이스. Mock 구현만 W0/W1 대상.
 * 추후 OAuth 구현체 추가 지점: 이 인터페이스를 구현한 별도 클래스(예: GoogleOAuthProvider)를
 * 추가하고 AuthController가 주입받는 빈을 교체하면 된다 — 컨트롤러/세션 로직은 불변.
 */
public interface AuthProvider {
    AuthResult authenticate(LoginRequest request);
}
