package online.hmb.auth;

/** authenticate() 결과 — 세션 발급 전 단계. */
public record AuthResult(String userId, String nickname, boolean isNew) {
}
