package online.hmb.auth;

/**
 * POST /api/auth/login 요청 바디.
 *
 * <p>P2-D1(OAuth 목): {@code provider} 로 로그인 방식을 구분한다 — {@code guest}(기본, 닉네임만) /
 * {@code mock:google} / {@code mock:apple}. 실 OAuth 도입 시에도 이 바디 형태는 불변이고
 * AuthProvider 구현체만 교체된다(AC-A2). 생략/blank 는 guest 로 취급(V1 하위호환).
 */
public record LoginRequest(String nickname, String provider) {

    /** provider 생략/blank → guest (V1 nickname-only 로그인 하위호환). */
    public String providerOrDefault() {
        return provider == null || provider.isBlank() ? "guest" : provider;
    }
}
