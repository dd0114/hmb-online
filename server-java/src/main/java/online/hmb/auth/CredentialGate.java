package online.hmb.auth;

import org.springframework.stereotype.Component;

/**
 * <b>자격 미제시 로그인 경로(guest/mock:*)의 단일 관문.</b> 불변식은 하나다 —
 * "자격이 걸린 계정({@code users.password} 값 존재)은 자격을 제시하지 않은 경로로 로그인될 수 없다".
 * P3-D2(평문 목업)는 <b>해시를 유예할 뿐 자격 검사를 유예하지 않는다</b>.
 *
 * <p><b>왜 관문이 두 개인가(출구를 세지 않기 위해)</b>: 1차 수정에서 "기존 계정 발견" 출구마다
 * 조건을 복사했다가 세 번째 출구({@code UserOnboardingService} 의 tx 내부 재확인)를 빠뜨렸고,
 * 그 경로는 UNIQUE 위반도 나지 않아 어떤 사전 가드에도 닿지 않았다(동시 요청에서 실제 세션 탈취 발생).
 * 그래서 이제 <b>출구를 열거하지 않는다</b>:
 * <ol>
 *   <li>{@link #acceptExistingWithoutCredentials} — 기존 계정을 {@link AuthResult} 로 바꾸는 <b>사전</b> 관문.
 *       온보딩 계층은 더 이상 {@code AuthResult} 를 만들지 못하므로({@code OnboardingResult} sealed 타입)
 *       이 변환은 여기로 모인다.</li>
 *   <li>{@link #assertPasswordless} — {@link DelegatingAuthProvider} 가 <b>모든</b> 비-local 결과에
 *       적용하는 <b>사후</b> 관문. 내부에 어떤 출구가 몇 개 생기든, 세션 발급 전에 반드시 여기를 지난다.
 *       즉 "네 번째 출구"가 생겨도 자동으로 막힌다 — 이 관문은 출구 개수와 무관하기 때문이다.</li>
 * </ol>
 * 사후 관문은 <b>userId</b> 로 재조회한다(닉네임으로 다시 조회하면 같은 TOCTOU 를 반복한다).
 */
@Component
public class CredentialGate {

    private final AccountLookup accounts;

    public CredentialGate(AccountLookup accounts) {
        this.accounts = accounts;
    }

    /**
     * 자격 미제시 경로가 <b>기존 계정</b>을 받아들이는 유일한 방법. 비번이 걸려 있으면 401.
     * (기존 guest/mock:* 계정은 password 가 NULL 이라 그대로 통과 — 무회귀.)
     */
    public AuthResult acceptExistingWithoutCredentials(AccountLookup.Account account, String nickname) {
        if (account.hasPassword()) {
            throw AuthErrors.badCredentials();
        }
        return new AuthResult(account.id(), nickname, false);
    }

    /**
     * 사후 관문 — 자격 미제시 경로가 낸 결과가 비번 걸린 계정을 가리키면 401.
     *
     * <p>동시 경합(가입 커밋이 목업 로그인의 tx 내부 재확인과 겹치는 인터리빙)에서는 사전 가드가
     * 볼 수 없던 사실이 <b>이 시점에는 커밋돼 보인다</b> — 그래서 이 검사가 경합 창을 닫는다.
     */
    public AuthResult assertPasswordless(AuthResult result) {
        boolean credentialed = accounts.findById(result.userId())
                .map(AccountLookup.Account::hasPassword)
                .orElse(false);
        if (credentialed) {
            throw AuthErrors.badCredentials();
        }
        return result;
    }
}
