package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;
import org.junit.jupiter.api.Test;

/**
 * <b>#492 AC3-①(구조) — 이벤트 훅은 {@code txRunner.run(...)} 람다 안에 있을 수 없다.</b>
 *
 * <p>왜 소스 스캔인가: 이 리포엔 {@code @Transactional} 이 없고 트랜잭션은 {@code TxRunner}
 * (PROPAGATION_REQUIRED)로 명시적이다. 그 람다 <b>안</b>에서 이벤트 INSERT 가 실패하면 예외를
 * 삼켜도 <b>바깥 트랜잭션이 같이 롤백</b>되고 SQLite 트랜잭션이 오염된다 — 즉 계측이 가입·저장·
 * 뽑기·정산을 되돌린다. <b>try/catch 로는 이 성질을 만들 수 없으므로</b> 무영향의 1차 근거는
 * "코드가 어디에 있는가"라는 구조뿐이고, 구조는 소스로만 검사할 수 있다.
 *
 * <p>런타임 백스톱은 별도로 있다({@code BusinessEventRecorder} 가 트랜잭션 안이면 쓰지 않는다,
 * 계약 = {@code BusinessEventNoImpactTest}). 이 테스트는 그 백스톱이 <b>발화하지 않아야 한다</b>는
 * 쪽을 지킨다 — 백스톱이 도는 순간 그 이벤트는 영영 기록되지 않기 때문이다.
 *
 * <p>⚠️ <b>공허해지지 않게</b> 훅 개수와 파일 목록을 같이 못박는다. 스캐너가 아무것도 못 찾아도
 * "위반 0"은 참이라, 훅을 통째로 지운 변이체가 통과한다.
 */
class BusinessEventHookPlacementTest {

    private static final Path MAIN_JAVA = Path.of("src/main/java");

    /** 훅 호출 = 레코더 필드에 대한 {@code .record(} 호출. 필드명은 두 관용구뿐이다. */
    private static final Pattern RECORD_CALL =
            Pattern.compile("\\b(events|eventRecorder)\\s*\\.\\s*record\\s*\\(");
    private static final Pattern TX_RUN = Pattern.compile("\\btxRunner\\s*\\.\\s*run\\s*\\(");

    /**
     * 훅이 있어야 하는 파일(= 이벤트 7종의 발생 지점). 여기서 사라지면 그 계측이 죽은 것이므로
     * <b>이름으로</b> 못박는다 — 개수만 세면 한 곳을 지우고 다른 곳에 둘을 넣어도 통과한다.
     */
    private static final Map<String, Integer> EXPECTED_HOOKS = new LinkedHashMap<>(Map.of(
            "online/hmb/auth/LocalAuthProvider.java", 1,          // user_signup (local)
            "online/hmb/auth/MockOAuthProvider.java", 1,          // user_signup (guest/mock:*)
            "online/hmb/meta/OnboardingController.java", 1,       // tutorial_complete
            "online/hmb/meta/DeckController.java", 1,             // deck_save (source=deck)
            "online/hmb/meta/TeamPresetController.java", 1,       // deck_save (source=preset)
            "online/hmb/shop/ShopController.java", 1,             // gacha_pull
            "online/hmb/match/MatchController.java", 1,           // match_start (practice)
            "online/hmb/league/LeagueController.java", 2,         // league_season_start + match_start (league)
            "online/hmb/away/AwayController.java", 1,             // match_start (away · revenge 공용 헬퍼)
            "online/hmb/match/MatchOrchestrator.java", 1));       // match_finish (커밋 후)

    // ── ① 훅이 트랜잭션 람다 안에 있으면 안 된다 ──────────────────────────

    @Test
    void noEventHookSitsInsideATransactionLambda() throws IOException {
        List<String> violations = new ArrayList<>();
        int scanned = 0;

        for (Path file : javaFiles()) {
            String code = stripCommentsAndStrings(Files.readString(file, StandardCharsets.UTF_8));
            List<int[]> txRanges = transactionRanges(code);
            Matcher m = RECORD_CALL.matcher(code);
            while (m.find()) {
                scanned++;
                for (int[] range : txRanges) {
                    if (m.start() > range[0] && m.start() < range[1]) {
                        violations.add(MAIN_JAVA.relativize(file) + " @" + lineOf(code, m.start()));
                    }
                }
            }
        }

        assertThat(scanned)
                .as("훅을 하나도 못 찾았다면 이 검사는 공허하다 — 스캐너나 훅 중 하나가 죽었다")
                .isGreaterThanOrEqualTo(EXPECTED_HOOKS.values().stream().mapToInt(Integer::intValue).sum());
        assertThat(violations)
                .as("이벤트 기록이 txRunner.run 람다 안에 있다 — 기록 실패가 본 동작을 롤백시킨다(#492 R1)")
                .isEmpty();
    }

    // ── ② 훅이 있어야 할 곳에 실제로 있다(공허 방지) ──────────────────────

    @Test
    void everyExpectedHookSiteStillHasItsHook() throws IOException {
        Map<String, Integer> found = new LinkedHashMap<>();
        for (Path file : javaFiles()) {
            String code = stripCommentsAndStrings(Files.readString(file, StandardCharsets.UTF_8));
            int count = 0;
            Matcher m = RECORD_CALL.matcher(code);
            while (m.find()) {
                count++;
            }
            if (count > 0) {
                found.put(MAIN_JAVA.relativize(file).toString().replace('\\', '/'), count);
            }
        }

        assertThat(found)
                .as("훅 지점이 바뀌었다 — 계측이 사라졌거나 새 훅이 계약 없이 들어왔다")
                .containsExactlyInAnyOrderEntriesOf(EXPECTED_HOOKS);
        assertThat(new TreeSet<>(found.keySet()))
                .as("BusinessEventRecorder 자신은 훅이 아니다(자기 호출을 세면 개수가 거짓말한다)")
                .doesNotContain("online/hmb/events/BusinessEventRecorder.java");
    }

    // ── ③ 스캐너 자체가 살아 있는가(변이체 킬) ────────────────────────────

    /**
     * 스캐너를 믿을 수 있는지 스캐너로 확인한다. 위 ①이 "위반 0"을 말하는데 <b>스캐너가 위반을
     * 못 찾는 종류</b>라면 그 0 은 아무 의미가 없다 — 실제로 텍스트 블록({@code """})과 주석 때문에
     * 순진한 괄호 세기는 쉽게 어긋난다(이 리포의 tx 람다는 거의 전부 텍스트 블록 SQL 을 담고 있다).
     */
    @Test
    void theScannerActuallyDetectsAHookPlacedInsideATransaction() {
        String bad = """
                class X {
                  void f() {
                    txRunner.run(() -> {
                      jdbcClient.sql(""\"
                              INSERT INTO t(a) VALUES (?)   -- ) ) ) 괄호 미끼
                              ""\").param("x").update();
                      // events.record( 주석 미끼 )
                      events.record("e", u, java.util.Map.of());
                      return true;
                    });
                  }
                }
                """;
        String code = stripCommentsAndStrings(bad);
        List<int[]> ranges = transactionRanges(code);
        Matcher m = RECORD_CALL.matcher(code);
        assertThat(m.find()).as("주석 안의 미끼가 아니라 실제 호출을 찾아야 한다").isTrue();
        assertThat(ranges).hasSize(1);
        assertThat(m.start()).isStrictlyBetween(ranges.get(0)[0], ranges.get(0)[1]);

        // 그리고 tx 밖에 두면 잡히지 않아야 한다(과탐이면 이 계약은 항상 red 라 무용지물이 된다).
        String good = """
                class X {
                  void f() {
                    txRunner.run(() -> jdbcClient.sql("UPDATE t SET a = 1").update());
                    events.record("e", u, java.util.Map.of());
                  }
                }
                """;
        String okCode = stripCommentsAndStrings(good);
        List<int[]> okRanges = transactionRanges(okCode);
        Matcher ok = RECORD_CALL.matcher(okCode);
        assertThat(ok.find()).isTrue();
        assertThat(okRanges).hasSize(1);
        assertThat(ok.start()).isGreaterThan(okRanges.get(0)[1]);
    }

    // ── 스캐너 ───────────────────────────────────────────────────────────

    private static List<Path> javaFiles() throws IOException {
        try (Stream<Path> paths = Files.walk(MAIN_JAVA)) {
            return paths.filter(p -> p.toString().endsWith(".java")).sorted().toList();
        }
    }

    /** {@code txRunner.run(} 의 여는 괄호부터 짝이 맞는 닫는 괄호까지 [start, end). */
    private static List<int[]> transactionRanges(String code) {
        List<int[]> ranges = new ArrayList<>();
        Matcher m = TX_RUN.matcher(code);
        while (m.find()) {
            int open = m.end() - 1;   // '(' 위치
            int depth = 0;
            for (int i = open; i < code.length(); i++) {
                char c = code.charAt(i);
                if (c == '(') {
                    depth++;
                } else if (c == ')') {
                    depth--;
                    if (depth == 0) {
                        ranges.add(new int[]{open, i});
                        break;
                    }
                }
            }
        }
        return ranges;
    }

    /**
     * 주석·문자열·텍스트블록을 <b>같은 길이의 공백</b>으로 지운다(인덱스가 보존돼야 줄 번호와
     * 괄호 짝이 원본과 일치한다). 괄호 세기가 SQL 안의 괄호에 속지 않게 하는 것이 목적이다.
     */
    private static String stripCommentsAndStrings(String src) {
        char[] out = src.toCharArray();
        int i = 0;
        int n = src.length();
        while (i < n) {
            char c = src.charAt(i);
            if (c == '/' && i + 1 < n && src.charAt(i + 1) == '/') {
                while (i < n && src.charAt(i) != '\n') {
                    out[i++] = ' ';
                }
            } else if (c == '/' && i + 1 < n && src.charAt(i + 1) == '*') {
                int end = src.indexOf("*/", i + 2);
                end = end < 0 ? n : end + 2;
                i = blank(out, src, i, end);
            } else if (c == '"' && src.startsWith("\"\"\"", i)) {
                int end = src.indexOf("\"\"\"", i + 3);
                end = end < 0 ? n : end + 3;
                i = blank(out, src, i, end);
            } else if (c == '"' || c == '\'') {
                int j = i + 1;
                while (j < n) {
                    char d = src.charAt(j);
                    if (d == '\\') {
                        j += 2;
                        continue;
                    }
                    if (d == c || d == '\n') {
                        j++;
                        break;
                    }
                    j++;
                }
                i = blank(out, src, i, Math.min(j, n));
            } else {
                i++;
            }
        }
        return new String(out);
    }

    /** [from, to) 를 공백으로(개행은 보존 — 줄 번호가 어긋나면 위반 위치를 못 짚는다). */
    private static int blank(char[] out, String src, int from, int to) {
        for (int k = from; k < to; k++) {
            out[k] = src.charAt(k) == '\n' ? '\n' : ' ';
        }
        return to;
    }

    private static int lineOf(String code, int index) {
        int line = 1;
        for (int i = 0; i < index; i++) {
            if (code.charAt(i) == '\n') {
                line++;
            }
        }
        return line;
    }
}
