package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Files;
import java.nio.file.Path;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.ResultSet;
import java.sql.Statement;
import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/**
 * V21 소각 박제 계약 (#247).
 *
 * <p><b>왜 별도 테스트인가.</b> 기보유 다이스 소각은 hero 확정이지만 <b>되돌릴 수 없는 데이터
 * 변경</b>이다. 보상 요구가 오면 {@code dice_burned} 가 "얼마였는지"에 답할 <b>유일한 근거</b>다
 * — 가격은 economy override 로 바뀌므로 사후 재계산이 성립하지 않는다({@code starter_grants} 와
 * 같은 원칙). {@link FlywayMigrationTest} 는 <b>테이블 이름만</b> 보므로, 박제가 실제로 잔량을
 * 옮기는지는 아무도 안 봤다(독립검증 minor-4).
 *
 * <p>스프링 컨텍스트를 띄우지 않고 <b>빈 파일에 V1..V21 을 순서대로 적용</b>한 뒤, 소각 직전
 * 상태를 직접 만들어 V21 만 다시 재현한다 — 마이그레이션 파일 자체가 검사 대상이다.
 */
class DiceBurnMigrationTest {

    private static final Path MIGRATIONS = Path.of("src/main/resources/db/migration");

    @Test
    void v21SnapshotsStockBeforeBurningIt_andKeepsLegacyTables(@TempDir Path tmp) throws Exception {
        Path db = tmp.resolve("v21.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + db)) {
            applyThrough(c, 20);

            // 소각 직전 상태 — 잔량 있는 유저 2명 + 빈 유저 1명.
            exec(c, "INSERT INTO users(id, nickname, created_at) VALUES "
                    + "('u1','a','2026-01-01T00:00:00Z'),"
                    + "('u2','b','2026-01-01T00:00:00Z'),"
                    + "('u3','c','2026-01-01T00:00:00Z')");
            exec(c, "INSERT INTO user_dice(user_id, normal, cash) VALUES ('u1',7,3),('u2',0,0),('u3',0,12)");

            apply(c, 21);

            // ① 잔량이 있던 유저만 박제된다(빈 유저까지 남기면 "누가 손해를 봤나"가 흐려진다).
            assertThat(rows(c, "SELECT user_id || ':' || normal || '/' || cash FROM dice_burned ORDER BY user_id"))
                    .containsExactly("u1:7/3", "u3:0/12");
            assertThat(rows(c, "SELECT burned_at FROM dice_burned")).allSatisfy(
                    ts -> assertThat(ts).matches("\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}Z"));

            // ② 재고는 실제로 0 이 된다(소각).
            assertThat(rows(c, "SELECT COALESCE(SUM(normal + cash), 0) FROM user_dice")).containsExactly("0");

            // ③ 구 테이블을 드롭하지 않았다 — 롤백 여유(V10 선례). dice_rolls 는 감사 로그라 계속 쓰인다.
            assertThat(rows(c, "SELECT name FROM sqlite_master WHERE type='table' "
                    + "AND name IN ('user_dice','dice_rolls') ORDER BY name"))
                    .containsExactly("dice_rolls", "user_dice");

            // ④ 박제만으로 복원이 성립한다 — 이게 성립하지 않으면 소각은 진짜로 되돌릴 수 없다.
            exec(c, "UPDATE user_dice SET "
                    + "normal = (SELECT normal FROM dice_burned d WHERE d.user_id = user_dice.user_id), "
                    + "cash   = (SELECT cash   FROM dice_burned d WHERE d.user_id = user_dice.user_id) "
                    + "WHERE user_id IN (SELECT user_id FROM dice_burned)");
            assertThat(rows(c, "SELECT user_id || ':' || normal || '/' || cash FROM user_dice ORDER BY user_id"))
                    .containsExactly("u1:7/3", "u2:0/0", "u3:0/12");
        }
    }

    /** 잔량이 하나도 없는 DB 에서도 V21 은 조용히 지나간다(신규 배포·클린 설치). */
    @Test
    void v21IsANoOpWhenNobodyHeldDice(@TempDir Path tmp) throws Exception {
        Path db = tmp.resolve("empty.db");
        try (Connection c = DriverManager.getConnection("jdbc:sqlite:" + db)) {
            applyThrough(c, 21);
            assertThat(rows(c, "SELECT COUNT(*) FROM dice_burned")).containsExactly("0");
        }
    }

    // ── 헬퍼 ──────────────────────────────────────────────────────────────

    private static void applyThrough(Connection c, int lastVersion) throws Exception {
        for (int v = 1; v <= lastVersion; v++) {
            apply(c, v);
        }
    }

    /** {@code V{n}__*.sql} 을 전부 적용(같은 번호가 둘이면 파일명 순). */
    private static void apply(Connection c, int version) throws Exception {
        List<Path> files;
        try (var stream = Files.list(MIGRATIONS)) {
            files = stream
                    .filter(p -> p.getFileName().toString().startsWith("V" + version + "__"))
                    .filter(p -> p.getFileName().toString().endsWith(".sql"))
                    .sorted()
                    .toList();
        }
        assertThat(files).as("V%d 마이그레이션이 있어야 한다", version).isNotEmpty();
        for (Path f : files) {
            exec(c, Files.readString(f));
        }
    }

    private static void exec(Connection c, String sql) throws Exception {
        try (Statement st = c.createStatement()) {
            // SQLite JDBC 는 멀티 스테이트먼트를 지원하지 않으므로 세미콜론으로 나눠 실행한다.
            for (String part : stripComments(sql).split(";")) {
                if (!part.isBlank()) {
                    st.execute(part);
                }
            }
        }
    }

    /** `--` 줄 주석 제거 — 주석 안의 세미콜론이 스테이트먼트를 잘못 쪼개지 않게. */
    private static String stripComments(String sql) {
        StringBuilder out = new StringBuilder();
        for (String line : sql.split("\n")) {
            int idx = line.indexOf("--");
            out.append(idx >= 0 ? line.substring(0, idx) : line).append('\n');
        }
        return out.toString();
    }

    private static List<String> rows(Connection c, String sql) throws Exception {
        List<String> out = new ArrayList<>();
        try (Statement st = c.createStatement(); ResultSet rs = st.executeQuery(sql)) {
            while (rs.next()) {
                out.add(rs.getString(1));
            }
        }
        return out;
    }
}
