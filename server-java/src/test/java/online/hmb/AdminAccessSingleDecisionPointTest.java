package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * <b>구조 회귀 박제</b> — "admin 판정은 단일 지점"이라는 성질을 소스에서 직접 검사한다.
 *
 * <p>W1 의 두 번의 FAIL 은 모두 <b>조건을 여러 곳에 복사</b>해서 생겼다(출구 하나를 빠뜨림).
 * 그래서 여기서는 런타임 동작이 아니라 <b>코드의 모양</b>을 단정한다:
 * <ul>
 *   <li>{@code is_admin} 컬럼을 읽는 SQL 은 {@code AdminAccess} 와 {@code AdminBootstrap}(부여 주체)
 *       밖에 존재하지 않는다 — 다른 곳에서 독자적으로 권한을 판정할 수 없다.</li>
 *   <li>{@code adminAccess.isAdmin(...)} 호출은 게이트({@code AdminInterceptor})와
 *       표시용({@code MeController}) 두 곳뿐이다 — 컨트롤러가 가드를 복사하기 시작하면 여기서 깨진다.</li>
 * </ul>
 * 새 admin 기능을 만들면서 어딘가에 {@code if (isAdmin)} 를 복사하는 순간 이 테스트가 실패하고,
 * 올바른 길(=/api/admin/ 접두사에 얹기)로 돌아가게 만든다.
 */
class AdminAccessSingleDecisionPointTest {

    private static final Path MAIN = Path.of("src/main/java/online/hmb");

    /** is_admin 컬럼 읽기/쓰기가 허용된 파일. */
    private static final List<String> IS_ADMIN_SQL_ALLOWED = List.of(
            "admin/AdminAccess.java",        // 판정(읽기) 단일 지점
            "admin/AdminBootstrap.java",     // 부여/회수(쓰기) 단일 지점
            "admin/AdminUserQueryService.java" // 운영 화면 표시(목록/상세의 표시 컬럼)
    );

    /** isAdmin(...) 호출이 허용된 파일. */
    private static final List<String> IS_ADMIN_CALL_ALLOWED = List.of(
            "admin/AdminAccess.java",        // 선언부
            "admin/AdminInterceptor.java",   // 유일한 **권한 판정** 소비자
            "meta/MeController.java"         // 표시용(권한 결정 아님)
    );

    @Test
    void isAdminColumnIsOnlyTouchedByTheAdminModule() throws IOException {
        List<String> offenders = filesContaining("is_admin", IS_ADMIN_SQL_ALLOWED);
        assertThat(offenders)
                .as("is_admin 을 직접 읽는 곳이 늘었다 — 권한 판정이 분산되면 W1 처럼 한 곳을 빠뜨린다")
                .isEmpty();
    }

    @Test
    void isAdminIsCalledOnlyByTheGateAndTheDisplayEndpoint() throws IOException {
        List<String> offenders = filesContaining("isAdmin(", IS_ADMIN_CALL_ALLOWED);
        assertThat(offenders)
                .as("컨트롤러가 admin 판정을 복사하기 시작했다 — 새 admin API 는 /api/admin/ 접두사에 얹어야 한다")
                .isEmpty();
    }

    /** 허용 목록이 실제로 존재하는 파일을 가리키는지(오타로 검사가 무력화되지 않게). */
    @Test
    void allowListEntriesExist() {
        Stream.concat(IS_ADMIN_SQL_ALLOWED.stream(), IS_ADMIN_CALL_ALLOWED.stream())
                .distinct()
                .forEach(rel -> assertThat(MAIN.resolve(rel)).exists());
    }

    private List<String> filesContaining(String needle, List<String> allowed) throws IOException {
        List<String> offenders = new ArrayList<>();
        try (var paths = Files.walk(MAIN)) {
            for (Path p : paths.filter(p -> p.toString().endsWith(".java")).toList()) {
                String rel = MAIN.relativize(p).toString();
                if (allowed.contains(rel)) {
                    continue;
                }
                String src = Files.readString(p);
                // javadoc/주석 언급은 무시 — 코드 라인만 본다.
                boolean hit = src.lines()
                        .map(String::strip)
                        .filter(line -> !line.startsWith("*") && !line.startsWith("//") && !line.startsWith("/*"))
                        .anyMatch(line -> line.contains(needle));
                if (hit) {
                    offenders.add(rel);
                }
            }
        }
        return offenders;
    }
}
