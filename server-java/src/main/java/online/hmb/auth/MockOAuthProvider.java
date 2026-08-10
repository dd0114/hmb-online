package online.hmb.auth;

import java.util.Map;
import java.util.Optional;
import java.util.Set;
import online.hmb.common.ApiException;
import online.hmb.events.BusinessEvent;
import online.hmb.events.BusinessEventRecorder;
import online.hmb.common.SqliteErrors;
import org.springframework.dao.DataAccessException;
import org.springframework.stereotype.Component;

/**
 * 목업 OAuth 공급자(P2-D1, AC-A1). 세 방식을 모두 처리한다: {@code guest}(닉네임만) /
 * {@code mock:google} / {@code mock:apple} — 어느 경우든 닉네임으로 세션을 발급하고
 * {@code users.auth_provider} 에 provider 값을 기록한다(mock 동의 화면·닉네임 입력은 웹 목업).
 * 신규 닉네임이면 하나의 트랜잭션으로 users + wallets + 스타터 팩(user_players, economy starterPack)
 * + 원장('starter', ref=userId)을 생성한다(AC-S1) — 온보딩 본체는
 * {@link UserOnboardingService}(전 provider 공용 SoT)에 있다.
 *
 * <p><b>실 OAuth 교체 지점(AC-A2)</b>: 실제 구글/애플 연동이 필요하면 {@link AuthProvider} 를
 * 구현한 별도 클래스(예: {@code GoogleOAuthProvider})를 추가하고 {@link DelegatingAuthProvider}
 * 라우팅에 provider 값을 얹으면 된다 — {@link AuthController}/{@link SessionService}/온보딩 로직은
 * <b>불변</b>이다. 컨트롤러는 provider 값을 해석하지 않고 이 인터페이스에만 의존한다
 * (AuthProviderSwapTest 로 증명). 이 목업은 비밀번호를 다루지 않는다(비번은 {@link LocalAuthProvider}
 * 전용이며 평문 저장은 P3-D2 의 임시 목업 — 해시 전환은 백로그).
 */
@Component
public class MockOAuthProvider implements AuthProvider {

    /** 지원 provider (P2-D1). 실 OAuth 구현체는 이 목록 밖의 값을 자기 방식으로 처리한다. */
    static final Set<String> SUPPORTED_PROVIDERS = Set.of("guest", "mock:google", "mock:apple");

    private final UserOnboardingService onboarding;
    private final AccountLookup accounts;
    private final CredentialGate gate;
    private final BusinessEventRecorder events;

    public MockOAuthProvider(UserOnboardingService onboarding, AccountLookup accounts, CredentialGate gate,
                             BusinessEventRecorder events) {
        this.onboarding = onboarding;
        this.accounts = accounts;
        this.gate = gate;
        this.events = events;
    }

    @Override
    public AuthResult authenticate(LoginRequest request) {
        String provider = request == null ? "guest" : request.providerOrDefault();
        if (!SUPPORTED_PROVIDERS.contains(provider)) {
            throw ApiException.validation(
                    "지원하지 않는 provider 입니다(guest|mock:google|mock:apple): " + provider);
        }

        String nickname = request == null ? null : request.nickname();
        if (!Nicknames.isValid(nickname)) {
            throw ApiException.validation(Nicknames.RULE_MESSAGE);
        }

        Optional<AccountLookup.Account> existing = accounts.findByNickname(nickname);
        if (existing.isPresent()) {
            // 기존 유저 재로그인 — auth_provider 는 최초 가입 값 유지(재기록 안 함).
            // 자격 검사는 CredentialGate 가 한다(비번 걸린 계정이면 401): P3-D2 는 해시를 유예할 뿐
            // 자격 검사를 유예하지 않으며, local 계정은 목업 provider 로 우회 로그인될 수 없다.
            return gate.acceptExistingWithoutCredentials(existing.get(), nickname);
        }

        try {
            // 비번 없는 계정(users.password NULL) — local 로그인 대상이 아니다.
            UserOnboardingService.OnboardingResult result = onboarding.createUser(nickname, provider, null);
            // sealed 타입이라 두 경우를 모두 다뤄야 한다. 경합에서 졌으면(다른 요청이 먼저 커밋)
            // 기존 계정 수용은 반드시 관문을 거친다 — 예전엔 이 경로가 검사 없이 통과했다.
            if (result instanceof UserOnboardingService.OnboardingResult.Created created) {
                // #492: 계정이 **실제로 만들어진** 분기에서만 기록한다 — 아래 경합 패자(AlreadyExists)와
                // 위 재로그인(existing.isPresent)은 가입이 아니다. 그리고 여기는 createUser 의
                // 트랜잭션이 **커밋된 뒤**다(그 메서드는 전체가 tx 라 안에 넣으면 가입이 롤백된다).
                events.record(BusinessEvent.USER_SIGNUP, created.userId(),
                        () -> Map.of("provider", provider, "nickname", nickname));
                return new AuthResult(created.userId(), nickname, true);
            }
            AccountLookup.Account raced =
                    ((UserOnboardingService.OnboardingResult.AlreadyExists) result).account();
            return gate.acceptExistingWithoutCredentials(raced, nickname);
        } catch (DataAccessException e) {
            // 동시 첫 로그인 경합: 다른 요청이 먼저 같은 닉네임을 커밋한 경우(users.nickname
            // UNIQUE 위반, tx 전체 롤백됨) → 기존 유저 재조회로 로그인 처리 (W1 이월사항 c)
            if (!SqliteErrors.isUniqueViolation(e)) {
                throw e;
            }
            AccountLookup.Account raced = accounts.findByNickname(nickname).orElseThrow(() -> e);
            return gate.acceptExistingWithoutCredentials(raced, nickname);
        }
    }
}
