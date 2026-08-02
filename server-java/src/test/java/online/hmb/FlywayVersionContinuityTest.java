package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * <b>마이그레이션 번호에 결번이 없다</b> — 배포를 죽이는 결번을 사람 주석이 아니라 기계가 막는다
 * (독립검증 MJ-4).
 *
 * <p><b>왜 결번이 사고인가</b>: {@code application.yml} 의 {@code spring.flyway} 는 {@code enabled} 와
 * {@code locations} 만 지정한다 = 나머지는 Spring Boot 기본값이고, 그 기본이
 * {@code out-of-order=false} + {@code validate-on-migrate=true} 다. 번호가 빈 채로
 * <b>라이브에 먼저 적용되면</b>, 나중에 그 빈 번호를
 * 들고 오는 브랜치가 머지되는 순간 다음 배포의 Flyway 가
 * "Detected resolved migration not applied to database: N" 으로 <b>부팅을 거부</b>한다 =
 * 서비스 정지다. 되돌리려면 프로덕션 DB 의 {@code flyway_schema_history} 를 손으로 고쳐야 한다.
 *
 * <p><b>실제로 이 가드가 일을 했다.</b> #248(공지)은 V23 으로 만들어졌는데, 머지를 기다리는 동안
 * #245(원정)가 V21/V22 를, #253/#254 가 V23/V24 를, #247 이 V25 를 차례로 가져갔다.
 * 리베이스할 때마다 이 테스트가 <b>결번과 중복을 동시에</b> 잡아 V23 → V25 → V26 으로 옮기게 했다 — 주석에만 "머지 직전 재확인"이라고
 * 적혀 있었다면 그대로 지나갔을 자리다.
 */
class FlywayVersionContinuityTest {

    private static final Path MIGRATION_DIR = Path.of("src/main/resources/db/migration");
    private static final Pattern VERSIONED = Pattern.compile("^V(\\d+)__.+\\.sql$");

    /*
     * ⚠️ 예외 목록(구 {@code RESERVED_BY_OTHER_BRANCH})은 <b>없다</b> — 되살리지 마라.
     *
     * <p>한때 main 이 병렬 에픽에 번호를 미리 나눠 줘서(#405=V38, #408=V39) 뒤 번호를 받은 브랜치가
     * 혼자서는 결번이었고, 그동안만 열거된 번호를 예외로 뒀다. #405 가 머지되며 V38·V39 가 둘 다
     * 들어왔고 #408 은 V40 으로 옮겼다 = <b>결번이 없다</b>. 예외가 사라진 지금 연속성 검사는
     * 제 힘으로 선다.
     *
     * <p>다시 필요해지면 <b>그때 다시 만들되</b>, 예약이 채워지면 목록을 지우도록 강제하는 짝
     * 테스트를 반드시 같이 둬라. 목록만 남고 강제가 없으면 그 번호는 영구 사각지대가 된다 —
     * 아래 {@link #migrationVersionsHaveNoGaps} 가 그 번호에서 조용히 눈을 감는다.
     */

    @Test
    void migrationVersionsHaveNoGaps() {
        List<Integer> versions = versions();

        assertThat(versions).as("마이그레이션이 하나도 없으면 이 검사가 공허해진다").isNotEmpty();

        List<Integer> missing = Stream.iterate(1, v -> v + 1)
                .limit(versions.get(versions.size() - 1))
                .filter(v -> !versions.contains(v))
                .toList();

        assertThat(missing).as("""
                        마이그레이션 번호에 결번이 있다: %s (최신 V%d).
                        out-of-order=false + validate-on-migrate=true 이므로, 결번인 채로 배포되면
                        나중에 그 번호를 들고 오는 브랜치가 머지되는 순간 **다음 배포가 부팅에 실패**한다.
                        해야 할 일 — 둘 중 하나:
                          (1) 그 번호를 소유한 브랜치(#245 원정: V21/V22)가 main 에 들어간 뒤 리베이스한다.
                          (2) 그 브랜치가 안 들어가면 이 브랜치의 마이그레이션을 빈 번호로 renumber 한다.
                        ⚠️ 이미 라이브 DB 에 적용된 파일의 번호는 절대 바꾸지 마라(체크섬·이력이 깨진다).
                        """.formatted(missing, versions.get(versions.size() - 1)))
                .isEmpty();
    }

    /** 같은 번호를 둘이 쓰면 Flyway 가 부팅에서 죽는다 — 결번보다 먼저 드러나야 한다. */
    @Test
    void migrationVersionsAreUnique() {
        List<Integer> versions = versions();
        assertThat(versions).doesNotHaveDuplicates();
    }

    /** {@code V19__match_abandon.sql.conf} 같은 짝 파일은 마이그레이션이 아니다 — 확장자로 거른다. */
    private static List<Integer> versions() {
        try (Stream<Path> files = Files.list(MIGRATION_DIR)) {
            return files.map(p -> p.getFileName().toString())
                    .map(VERSIONED::matcher)
                    .filter(Matcher::matches)
                    .map(m -> Integer.parseInt(m.group(1)))
                    .sorted()
                    .toList();
        } catch (IOException e) {
            throw new IllegalStateException("마이그레이션 디렉토리를 읽지 못했다: " + MIGRATION_DIR.toAbsolutePath(), e);
        }
    }
}
