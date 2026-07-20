package online.hmb.auth;

import java.util.Optional;
import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * 닉네임(= 로그인 id)으로 계정 자격 정보를 읽는 단일 창구. 인증 공급자들이 각자 SQL 을 갖지 않게 해
 * "비번 있는 계정인가"를 <b>모든 로그인 경로가 같은 사실</b>로 판단하게 만든다.
 *
 * <p>이 클래스가 존재하는 이유(P3 §A 검증 지적): 예전에는 {@link MockOAuthProvider} 가 id 만 조회해
 * 기존 유저를 무조건 통과시켜, 비번을 건 계정을 {@code guest}/{@code mock:*} 로 우회 로그인할 수 있었다.
 */
@Component
public class AccountLookup {

    private final JdbcClient jdbcClient;

    public AccountLookup(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    public Optional<Account> findByNickname(String nickname) {
        if (nickname == null) {
            return Optional.empty();
        }
        return jdbcClient.sql("SELECT id AS id, password AS password FROM users WHERE nickname = ?")
                .param(nickname)
                .query(Account.class)
                .optional();
    }

    public Optional<Account> findById(String userId) {
        if (userId == null) {
            return Optional.empty();
        }
        return jdbcClient.sql("SELECT id AS id, password AS password FROM users WHERE id = ?")
                .param(userId)
                .query(Account.class)
                .optional();
    }

    public boolean exists(String nickname) {
        return findByNickname(nickname).isPresent();
    }

    /**
     * 계정 자격 홀더 — 응답/로그로 나가지 않는다(AC-A2: toString 마스킹).
     *
     * @param password 자체 로그인 비번(평문 목업, P3-D2). NULL = 비번 없는 계정(guest/mock:*).
     */
    public record Account(String id, String password) {

        /**
         * 자격 검사가 필요한 계정인가 — 판정은 <b>값의 존재(non-null)</b> 하나뿐이다.
         *
         * <p>빈 문자열도 "자격이 걸린 것"으로 취급한다. 불변식이 "자격이 걸렸으면 자격을 요구"이므로
         * 빈 비번을 예외로 두면(운영자가 {@code password-min-length: 0} 으로 낮추는 경우)
         * guest 로는 로그인되는데 local 로는 401 인 모순 상태가 생긴다 — fail-closed 로 통일한다.
         * 해시 전환 후에도 "값이 있으면 검사"라 규칙이 그대로 성립한다.
         */
        public boolean hasPassword() {
            return password != null;
        }

        @Override
        public String toString() {
            return "Account[id=" + id + ", password=***]";
        }
    }
}
