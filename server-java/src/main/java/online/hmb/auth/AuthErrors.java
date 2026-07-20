package online.hmb.auth;

import online.hmb.common.ApiException;
import org.springframework.http.HttpStatus;

/**
 * 인증 실패 응답 규약 단일 SoT — 모든 로그인 경로가 같은 코드·같은 문구를 쓴다.
 * 실패 사유(계정 미존재 / 비번 불일치 / 비번 있는 계정에 잘못된 provider)를 구분하지 않는 이유는
 * 닉네임 열거·계정 존재 여부 누설을 막기 위해서다.
 */
final class AuthErrors {

    /** 인증 실패 코드 — openapi.yaml components.schemas.ErrorCode 열거값. */
    static final String CODE_BAD_CREDENTIALS = "BAD_CREDENTIALS";
    static final String CODE_DUPLICATE_NICKNAME = "DUPLICATE_NICKNAME";

    private AuthErrors() {
    }

    static ApiException badCredentials() {
        return new ApiException(HttpStatus.UNAUTHORIZED, CODE_BAD_CREDENTIALS,
                "아이디 또는 비밀번호가 올바르지 않습니다");
    }

    static ApiException duplicateNickname() {
        return new ApiException(HttpStatus.CONFLICT, CODE_DUPLICATE_NICKNAME,
                "이미 사용 중인 아이디입니다");
    }
}
