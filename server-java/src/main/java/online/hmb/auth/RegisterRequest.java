package online.hmb.auth;

/**
 * POST /api/auth/register 요청 바디(P3 §A, P3-D2 — 자체 로그인 회원가입).
 *
 * <p>로그인 id = {@code nickname}(기존 users.nickname UNIQUE 재사용, 신규 식별자 없음).
 * {@code password} 는 평문 목업 — <b>해시 전환은 백로그</b>.
 *
 * <p><b>AC-A2</b>: {@link #toString()} 을 재정의해 비번을 마스킹한다. record 기본 toString 은
 * 전 필드를 찍기 때문에, 스프링/로깅/디버거가 바디를 문자열화하는 순간 비번이 로그로 샌다.
 */
public record RegisterRequest(String nickname, String password) {

    @Override
    public String toString() {
        return "RegisterRequest[nickname=" + nickname + ", password=***]";
    }
}
