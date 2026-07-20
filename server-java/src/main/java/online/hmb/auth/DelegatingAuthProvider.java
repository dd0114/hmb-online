package online.hmb.auth;

import org.springframework.context.annotation.Primary;
import org.springframework.stereotype.Component;

/**
 * provider 값으로 인증 구현체를 고르는 라우터(P3 §A). {@link AuthController} 는 여전히
 * {@link AuthProvider} 인터페이스 하나에만 의존한다 — 분기는 전부 여기로 모인다.
 *
 * <ul>
 *   <li>{@code local} → {@link LocalAuthProvider} (id+비번 자체 로그인, P3-D2 평문 목업)</li>
 *   <li>그 외(guest / mock:google / mock:apple / 미지원값) → {@link MockOAuthProvider}
 *       — 미지원 provider 의 400 VALIDATION_ERROR 판정도 기존과 동일하게 그쪽이 내린다(무회귀).</li>
 * </ul>
 *
 * <p><b>실 OAuth 교체 지점</b>: {@code oauth:google} 등 실 구현체가 생기면 이 라우팅 표에만
 * 한 줄 추가한다 — 컨트롤러·세션·온보딩은 불변(AC-A2).
 */
@Primary
@Component
public class DelegatingAuthProvider implements AuthProvider {

    private final LocalAuthProvider localAuthProvider;
    private final MockOAuthProvider mockOAuthProvider;
    private final CredentialGate gate;

    public DelegatingAuthProvider(LocalAuthProvider localAuthProvider,
                                  MockOAuthProvider mockOAuthProvider,
                                  CredentialGate gate) {
        this.localAuthProvider = localAuthProvider;
        this.mockOAuthProvider = mockOAuthProvider;
        this.gate = gate;
    }

    @Override
    public AuthResult authenticate(LoginRequest request) {
        String provider = request == null ? "guest" : request.providerOrDefault();
        if (LocalAuthProvider.PROVIDER.equals(provider)) {
            return localAuthProvider.authenticate(request);
        }
        // 자격 미제시 경로의 **단일 초크포인트**: 목업 구현 내부에 출구가 몇 개 있든(기존 유저 분기,
        // tx 내부 경합 재확인, UNIQUE 위반 재조회, 앞으로 생길 무엇이든) 세션 발급 전에 반드시
        // 여기를 지난다. 출구를 열거해 가드를 복사하는 방식은 실제로 한 곳을 빠뜨렸고(동시 요청에서
        // 세션 탈취), 그 실패에서 배운 구조다 — 이 검사는 **출구 개수와 무관**하다.
        return gate.assertPasswordless(mockOAuthProvider.authenticate(request));
    }
}
