package online.hmb.auth;

import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RestController;

/** POST /api/auth/login — AC-S1. */
@RestController
public class AuthController {

    private final AuthProvider authProvider;
    private final SessionService sessionService;

    public AuthController(AuthProvider authProvider, SessionService sessionService) {
        this.authProvider = authProvider;
        this.sessionService = sessionService;
    }

    @PostMapping("/api/auth/login")
    public LoginResponse login(@RequestBody LoginRequest request) {
        AuthResult result = authProvider.authenticate(request);
        String token = sessionService.createSession(result.userId());
        return new LoginResponse(token, new LoginResponse.UserRef(result.userId(), result.nickname()), result.isNew());
    }

    public record LoginResponse(String token, UserRef user, boolean isNew) {
        public record UserRef(String id, String nickname) {
        }
    }
}
