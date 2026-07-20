package online.hmb.auth;

/**
 * POST /api/auth/login 요청 바디.
 *
 * <p>P2-D1(OAuth 목): {@code provider} 로 로그인 방식을 구분한다 — {@code guest}(기본, 닉네임만) /
 * {@code mock:google} / {@code mock:apple}. 실 OAuth 도입 시에도 이 바디 형태는 불변이고
 * AuthProvider 구현체만 교체된다(AC-A2). 생략/blank 는 guest 로 취급(V1 하위호환).
 *
 * <p>P3-D2(자체 로그인): {@code provider="local"} 이면 {@code password} 를 함께 보낸다
 * (로그인 id 는 nickname 재사용). {@code password} 는 <b>옵션</b> 필드라 기존 바디(nickname만 /
 * nickname+provider)는 그대로 동작한다. 비번 평문 저장은 임시 목업 — 해시 전환은 백로그.
 *
 * <p><b>AC-A2</b>: {@link #toString()} 을 재정의해 비번을 마스킹한다. record 기본 toString 은
 * 전 필드를 찍기 때문에, 스프링/로깅/디버거가 바디를 문자열화하는 순간 비번이 로그로 샌다.
 */
public record LoginRequest(String nickname, String provider, String password) {

    /** provider 생략/blank → guest (V1 nickname-only 로그인 하위호환). */
    public String providerOrDefault() {
        return provider == null || provider.isBlank() ? "guest" : provider;
    }

    @Override
    public String toString() {
        return "LoginRequest[nickname=" + nickname + ", provider=" + provider + ", password=***]";
    }
}
