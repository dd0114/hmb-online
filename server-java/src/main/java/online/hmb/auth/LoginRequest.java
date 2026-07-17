package online.hmb.auth;

/** POST /api/auth/login 요청 바디. */
public record LoginRequest(String nickname) {
}
