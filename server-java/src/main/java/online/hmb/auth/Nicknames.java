package online.hmb.auth;

import java.util.regex.Pattern;

/**
 * 닉네임 규칙 단일 SoT — openapi.yaml LoginRequest.nickname.pattern 과 동일해야 한다.
 * 자체 로그인(P3-D2)에서는 이 닉네임이 곧 <b>로그인 id</b> 다(별도 식별자 컬럼 없음, users.nickname UNIQUE).
 */
public final class Nicknames {

    /** 2~16자, 유니코드 문자/숫자/_/- 만. */
    public static final Pattern PATTERN = Pattern.compile("^[\\p{L}\\p{N}_-]{2,16}$");

    public static final String RULE_MESSAGE = "닉네임은 2~16자의 문자/숫자/_/-만 허용됩니다";

    private Nicknames() {
    }

    public static boolean isValid(String nickname) {
        return nickname != null && PATTERN.matcher(nickname).matches();
    }
}
