package online.hmb.admin;

import org.springframework.jdbc.core.simple.JdbcClient;
import org.springframework.stereotype.Component;

/**
 * <b>admin 판정의 유일한 지점</b>(PRD-v4 §C, AC-C2). "이 유저가 admin 인가"라는 질문에 답하는
 * 코드는 이 클래스 하나뿐이고, <b>권한 판정</b> 목적으로 이걸 호출하는 곳은
 * {@link AdminInterceptor} 하나뿐이다({@code AdminAccessSingleDecisionPointTest} 가 소스에서 검증).
 *
 * <p><b>왜 이 구조여야 하는가 — W1 의 교훈</b>: W1 은 "조건을 여러 출구에 복사"해서 두 번 뚫렸다.
 * 그래서 여기서는 컨트롤러가 {@code if (isAdmin)} 를 <b>쓸 일 자체를 없앤다</b>:
 * <ol>
 *   <li>admin 기능은 URL 접두사 {@code /api/admin/} 하나로만 표현된다.</li>
 *   <li>게이트({@link AdminInterceptor})는 <b>핸들러 목록이 아니라 그 접두사</b>에 바인딩된다
 *       — 새 admin 엔드포인트를 추가해도 등록할 곳이 없고, 자동으로 게이트를 지난다.</li>
 *   <li>{@link AdminRouteGuard} 가 부팅 시 "admin 패키지의 모든 핸들러가 그 접두사 안에 있는가"를
 *       검사해 실패하면 <b>부팅을 막는다</b> — 접두사 밖으로 admin API 를 내보내는 순간 서버가 안 뜬다.</li>
 * </ol>
 * 즉 "가드를 빠뜨린 admin 엔드포인트"는 <b>출구를 세지 않고도</b> 구조적으로 만들 수 없다.
 *
 * <p>{@code MeController} 도 이 메서드를 쓰지만 그건 <b>표시용</b>이다(web 의 /admin 라우트 게이팅
 * 힌트). 표시값이 조작돼도 실제 접근은 서버 게이트가 막으므로 권한 결정과 무관하다.
 */
@Component
public class AdminAccess {

    private final JdbcClient jdbcClient;

    public AdminAccess(JdbcClient jdbcClient) {
        this.jdbcClient = jdbcClient;
    }

    /**
     * admin 여부. 계정이 없으면 <b>false</b>(fail-closed) — 세션은 살아 있는데 유저 행이 사라진
     * 상태에서 권한이 열리는 일이 없게 한다.
     */
    public boolean isAdmin(String userId) {
        if (userId == null) {
            return false;
        }
        // INTEGER 로 읽고 0 비교한다(드라이버의 Boolean 변환 규칙에 기대지 않는다 — 0 만 비admin).
        return jdbcClient.sql("SELECT is_admin FROM users WHERE id = ?")
                .param(userId)
                .query(Integer.class)
                .optional()
                .map(flag -> flag != 0)
                .orElse(false);
    }
}
