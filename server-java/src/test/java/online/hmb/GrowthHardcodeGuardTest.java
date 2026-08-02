package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * <b>성장 경로에 숫자 리터럴을 다시 심지 못하게 한다</b>(#405 설계 §2.8.2-3, 엔진 hygiene 게이트 방식).
 *
 * <p>AC-G0 은 "지금 하드코딩이 없다"가 아니라 <b>"앞으로도 안 생긴다"</b>여야 의미가 있다. 등급 밴드는
 * 실제로 {@code GrowthService.GRADE_BAND} 에 3년치 하드코딩으로 살아 있었고, 그래서 밴드 한 칸을
 * 바꾸는 데 <b>배포</b>가 필요했다(설계 §1.3). 같은 일이 반복되는 것을 사람 주석이 아니라 grep 이 막는다.
 *
 * <p><b>화이트리스트 방식</b>이다 — "이 값들만 허용"이라 새 리터럴은 <b>기본적으로 실패</b>한다.
 * 통과시키려면 여기 한 줄을 근거와 함께 추가해야 하고, 그 한 줄이 "이건 계수가 아니다"라는 판단의
 * 기록이 된다. 반대로 하면(금지 목록) 빠뜨린 값이 곧 구멍이다.
 */
class GrowthHardcodeGuardTest {

    /** 성장 계수가 흐르는 소스 — 계수는 이 파일들에서 {@code GrowthTuning} 으로만 들어와야 한다. */
    private static final List<Path> SCANNED = List.of(
            Path.of("src/main/java/online/hmb/growth/GrowthService.java"),
            Path.of("src/main/java/online/hmb/growth/GrowthMath.java"));

    /**
     * 계수가 아닌 리터럴만. <b>항목마다 근거가 있다</b> — 근거를 못 쓰면 그건 계수다.
     * <ul>
     *   <li>{@code 0 · 1 · 0.0 · 1.0} — 항등원·초기값·인덱스(값이 아니라 문법에 가깝다)</li>
     *   <li>{@code 2} — 잠재 해금 성(★2, economy.potential 소관) · 하프 수 · 잠재 줄 중복 상한</li>
     *   <li>{@code 8} — seed 파생 시 digest 바이트 수(SHA-256 → long)</li>
     *   <li>{@code 9} — {@code 1e-9} 엡실론의 지수(0 나눗셈 가드)</li>
     *   <li>{@code 1.5} — economy.potential 부재 시 폴백 레코드의 {@code ceilingMult}(성장 계수 아님)</li>
     *   <li>{@code 100.0 · 10000.0} — 소수 반올림 자릿수, 백분율 변환</li>
     *   <li>{@code 999999} — {@code ceilingAt} 무한 표시용 센티널(화면 값)</li>
     * </ul>
     */
    private static final Set<String> ALLOWED = new LinkedHashSet<>(List.of(
            "0", "1", "2", "8", "9", "0.0", "1.0", "1.5", "100.0", "10000.0", "999999"));

    private static final Pattern NUMBER = Pattern.compile("(?<![\\w.])(\\d+\\.\\d+|\\d+)(?![\\w.])");

    @Test
    void growthSourcesCarryNoTuningLiterals() {
        List<String> offenders = new ArrayList<>();
        for (Path path : SCANNED) {
            String code = stripCommentsAndStrings(read(path));
            String[] lines = code.split("\n", -1);
            for (int i = 0; i < lines.length; i++) {
                Matcher m = NUMBER.matcher(lines[i]);
                while (m.find()) {
                    if (!ALLOWED.contains(m.group(1))) {
                        offenders.add(path.getFileName() + ":" + (i + 1) + " → " + m.group(1)
                                + "   |" + lines[i].strip());
                    }
                }
            }
        }
        assertThat(offenders).as("""
                        성장 경로에 화이트리스트 밖 숫자 리터럴이 있다. 계수라면 GrowthTuning 으로 옮기고
                        KNOBS 에 등록해라(그래야 무배포로 바뀐다 — AC-G0). 계수가 아니라면 이 테스트의
                        ALLOWED 에 **근거와 함께** 추가해라.
                        """)
                .isEmpty();
    }

    /** 옛 하드코딩 표가 되살아나지 않았는지 — 이름으로도 한 번 더 막는다. */
    @Test
    void theOldGradeBandTableIsGone() {
        for (Path path : SCANNED) {
            String code = read(path);
            assertThat(code)
                    .as("%s 에 GRADE_BAND 하드코딩이 되살아났다 — 밴드의 SoT 는 GrowthTuning.bands 다", path)
                    .doesNotContain("GRADE_BAND");
        }
    }

    /**
     * <b>이 가드가 실제로 무엇을 잡는지</b>를 스스로 증명한다 — 옛 밴드값을 흉내낸 문자열을 넣으면
     * 스캐너가 잡아야 한다. 안 그러면 "통과했다"가 "검사했다"를 뜻하지 않는다.
     */
    @Test
    void theScannerActuallyCatchesABandLiteral() {
        String sample = """
                class X {
                    static final Map<String, int[]> GRADE_BAND = Map.of("BRONZE", new int[]{40, 55});
                }
                """;
        List<String> found = new ArrayList<>();
        Matcher m = NUMBER.matcher(stripCommentsAndStrings(sample));
        while (m.find()) {
            if (!ALLOWED.contains(m.group(1))) {
                found.add(m.group(1));
            }
        }
        assertThat(found).contains("40", "55");
    }

    private static String read(Path path) {
        try {
            return Files.readString(path);
        } catch (IOException e) {
            throw new IllegalStateException("소스를 읽지 못했다: " + path.toAbsolutePath(), e);
        }
    }

    /** 주석·문자열 안의 숫자는 코드가 아니다(설명에 40-55 를 적는 것은 금지가 아니다). */
    private static String stripCommentsAndStrings(String src) {
        String out = src.replaceAll("(?s)/\\*.*?\\*/", "");
        out = out.replaceAll("//[^\n]*", "");
        out = out.replaceAll("(?s)\"\"\".*?\"\"\"", "\"\"");
        out = out.replaceAll("\"(\\\\.|[^\"\\\\])*\"", "\"\"");
        return out;
    }
}
