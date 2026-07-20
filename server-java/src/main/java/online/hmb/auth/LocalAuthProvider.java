package online.hmb.auth;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import online.hmb.common.ApiException;
import online.hmb.common.SqliteErrors;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Component;

/**
 * 자체 로그인 공급자(P3 §A, P3-D2 — AC-A1·AC-A2). 로그인 id 는 기존 {@code users.nickname}
 * (UNIQUE)을 그대로 쓰고, 비번은 {@code users.password} 에 저장한다.
 *
 * <p><b>⚠️ 비번 평문 저장은 임시 목업이다</b>(P3-D2 로 명시 승인된 내부 테스터 배포 범위).
 * 실서비스 전 해시(BCrypt/Argon2) 전환은 백로그 — 전환 지점은 {@link #matches} 와
 * {@link #register} 두 곳뿐이며, 저장 포맷만 바뀌고 API/컨트롤러/온보딩은 불변이다.
 *
 * <p><b>실 OAuth 교체 지점(AC-A2)</b>: 이 클래스는 {@code provider="local"} 분기만 담당하고,
 * {@link DelegatingAuthProvider} 가 provider 값으로 라우팅한다. 실 구글/애플 연동은
 * {@link AuthProvider} 구현체를 추가하고 라우팅에 얹으면 되며 — 여기 비번 로직과 무관하다.
 *
 * <p><b>AC-A2</b>: 이 클래스는 비번을 <b>절대 로깅하지 않는다</b>(로거 자체를 두지 않는다).
 * 예외 메시지에도 비번을 담지 않으며, 실패 사유는 계정 존재 여부를 누설하지 않도록 통일한다.
 *
 * <p><b>우회 금지(양방향)</b>: P3-D2 는 <b>해시를 유예할 뿐 자격 검사를 유예하지 않는다</b>.
 * <ul>
 *   <li>비번 있는 계정 → 목업 provider(guest/mock:*) 로그인 불가 ({@link MockOAuthProvider} 가 401)</li>
 *   <li>비번 없는 계정 → local 로그인 불가 ({@link #matches} 가 stored=null 에서 false)</li>
 * </ul>
 * 두 방향 모두 회귀 테스트로 박제돼 있다(LocalAuthTest).
 */
@Component
public class LocalAuthProvider implements AuthProvider {

    /** LoginRequest.provider 값. */
    public static final String PROVIDER = "local";

    private final UserOnboardingService onboarding;
    private final AccountLookup accounts;
    private final int passwordMinLength;
    private final int passwordMaxLength;

    // 기본값(:4 / :64)을 둬서 키 누락 배포에도 컨텍스트가 뜬다 — 운영 값은 application.yml 이 SoT.
    public LocalAuthProvider(UserOnboardingService onboarding,
                             AccountLookup accounts,
                             @Value("${hmb.auth.local.password-min-length:4}") int passwordMinLength,
                             @Value("${hmb.auth.local.password-max-length:64}") int passwordMaxLength) {
        this.onboarding = onboarding;
        this.accounts = accounts;
        this.passwordMinLength = passwordMinLength;
        this.passwordMaxLength = passwordMaxLength;
    }

    /** 로그인 — 실패는 전부 401 BAD_CREDENTIALS(계정 존재 여부 누설 금지). */
    @Override
    public AuthResult authenticate(LoginRequest request) {
        String nickname = request == null ? null : request.nickname();
        String password = request == null ? null : request.password();

        if (!Nicknames.isValid(nickname) || password == null || password.isEmpty()) {
            throw AuthErrors.badCredentials();
        }

        AccountLookup.Account account = accounts.findByNickname(nickname)
                .orElseThrow(AuthErrors::badCredentials);
        if (!matches(password, account.password())) {
            throw AuthErrors.badCredentials();
        }
        return new AuthResult(account.id(), nickname, false);
    }

    /**
     * 회원가입 — 중복 닉네임은 409. 신규 유저는 다른 provider 와 <b>동일한 온보딩</b>
     * ({@link UserOnboardingService}: 지갑·스타터팩·원장·관계 초기화, 같은 tx)을 거친다.
     */
    public AuthResult register(RegisterRequest request) {
        String nickname = request == null ? null : request.nickname();
        String password = request == null ? null : request.password();

        if (!Nicknames.isValid(nickname)) {
            throw ApiException.validation(Nicknames.RULE_MESSAGE);
        }
        // 메시지에 비번 값을 넣지 않는다(AC-A2) — 길이 규칙만 노출.
        if (password == null || password.length() < passwordMinLength || password.length() > passwordMaxLength) {
            throw ApiException.validation(
                    "비밀번호는 " + passwordMinLength + "~" + passwordMaxLength + "자여야 합니다");
        }

        if (accounts.exists(nickname)) {
            throw AuthErrors.duplicateNickname();
        }

        UserOnboardingService.OnboardingResult result;
        try {
            result = onboarding.createUser(nickname, PROVIDER, password);
        } catch (DataAccessException e) {
            // 동시 가입 경합(users.nickname UNIQUE 위반, tx 롤백) → 409.
            if (!SqliteErrors.isUniqueViolation(e)) {
                throw e;
            }
            throw AuthErrors.duplicateNickname();
        }
        // 이 요청이 실제로 만든 계정만 토큰을 받는다. 경합 패자(AlreadyExists)는 남의 계정이므로 409 —
        // sealed 타입이라 "기존 계정을 성공으로 반환"하는 선택지가 아예 없다.
        if (result instanceof UserOnboardingService.OnboardingResult.Created created) {
            return new AuthResult(created.userId(), nickname, true);
        }
        throw AuthErrors.duplicateNickname();
    }

    /**
     * 비번 대조. <b>해시 전환 지점</b>(백로그) — 지금은 평문 상수시간 비교(P3-D2 목업).
     * {@code MessageDigest.isEqual} 은 길이 인지 상수시간 비교라 타이밍 사이드채널을 줄인다.
     */
    private boolean matches(String provided, String stored) {
        if (stored == null) {
            return false; // guest/mock:* 계정(비번 없음)은 local 로그인 불가
        }
        return MessageDigest.isEqual(
                provided.getBytes(StandardCharsets.UTF_8),
                stored.getBytes(StandardCharsets.UTF_8));
    }

}
