package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/**
 * 배포되는 시계 기본값이 **화면의 실제 재생 속도와 정합**인지 지킨다 (#216 AC2).
 *
 * <p>왜 필요한가: 다른 시계 테스트들은 전부 {@code @DynamicPropertySource} 로 값을 갈아끼운다
 * (짧은 창으로 눌러야 테스트가 빨리 돈다). 그래서 <b>프로덕션 기본값을 되돌려도 CI 는 전부 green</b>
 * 이고, AC2 의 "정합"이 수동 측정에만 매달리게 된다(독립검증 minor-2). 여기서 그 구멍을 막는다.
 *
 * <p>밴드의 출처는 취향이 아니라 실측이다 — 하이라이트 연출로 리얼 config 하프(2700틱)를 재생하면
 * min 392s · p50 422s · max 463s 다. 재현: {@code node tools/measure-playback-pace.mjs}
 * (모델 = viewer-core {@code autoPaceDurationMs}, 렌더 루프와 같은 상수를 읽는다).
 *
 * <p>하한이 실측 min 보다 더 아래(370s)인 이유: web 이 배율({@code paceRate}, 상한 1.6)로 재생을
 * 당겨 흡수할 수 있는 폭까지는 허용한다. 그보다 짧으면 배율이 상한에 물려 <b>하프 끝이 잘린다</b>.
 */
class MatchClockShippedDefaultsTest {

    private static final long MEASURED_MIN_MS = 392_000; // 실측 최속 하프
    private static final long MEASURED_MAX_MS = 463_000; // 실측 최장 하프

    @Test
    void shippedHalfRealMsMatchesMeasuredPlaybackLength() throws Exception {
        long yml = longFromApplicationYml("half-real-ms");
        long javaDefault = new online.hmb.match.MatchClockProperties().getHalfRealMs();

        assertThat(yml)
                .as("half-real-ms 는 켬 모드 실측 재생 길이(392~463s) 안이어야 한다 — 짧으면 재생이 끝나기 전에 "
                        + "하프타임이 열리고, 길면 재생이 먼저 끝나 빈 시간이 생긴다")
                .isBetween(370_000L, MEASURED_MAX_MS + 40_000L);
        assertThat(yml)
                .as("실측 밴드의 중앙 근처(p50 422s)에 있어야 배율 보정이 양쪽으로 여유를 갖는다")
                .isBetween(MEASURED_MIN_MS, MEASURED_MAX_MS);
        assertThat(javaDefault)
                .as("Java 기본값과 yml 이 갈라지면 프로필이 하나 빠졌을 때 조용히 다른 값이 뜬다")
                .isEqualTo(yml);
    }

    @Test
    void shippedHalftimeMsIsThreeMinutes() throws Exception {
        // #216 hero 지시. 값 자체가 요구사항이라 그대로 박는다(파생·측정 대상이 아니다).
        assertThat(longFromApplicationYml("halftime-ms")).isEqualTo(180_000);
        assertThat(new online.hmb.match.MatchClockProperties().getHalftimeMs()).isEqualTo(180_000);
    }

    /** application.yml 에서 {@code hmb.match.clock.<key>} 값을 읽는다(주석·들여쓰기 무관). */
    private static long longFromApplicationYml(String key) throws Exception {
        try (InputStream in = MatchClockShippedDefaultsTest.class.getResourceAsStream("/application.yml")) {
            assertThat(in).as("application.yml 이 클래스패스에 있어야 한다").isNotNull();
            String yml = new String(in.readAllBytes(), StandardCharsets.UTF_8);
            Matcher m = Pattern.compile("^\\s*" + Pattern.quote(key) + ":\\s*(\\d+)", Pattern.MULTILINE).matcher(yml);
            assertThat(m.find()).as("application.yml 에 %s 키가 있어야 한다", key).isTrue();
            return Long.parseLong(m.group(1));
        }
    }
}
