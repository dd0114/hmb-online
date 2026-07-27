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
 * <p><b>밴드가 곧 정책이다</b>: 실측 min~max(392~463s) 밖으로 나가려면 이 상수도 같이 고쳐야 한다 =
 * "재생과 창을 어긋나게 두겠다"는 의도적 결정이 된다. 실수로 되돌리는 경로는 여기서 막힌다.
 * (참고: 물리적 하한은 더 아래인 ≈270s — web 배율 상한 1.6 까지는 당겨 맞출 수 있다. 하지만 그
 * 구간은 하프 끝이 잘리기 시작하는 영역이라 기본값으로 둘 자리가 아니다. application.yml 주석 참조.)
 *
 * <p>이 테스트는 <b>사람이 옮겨 적은 숫자</b>를 지킨다. 밴드 자체가 낡는 것(뷰어 페이싱 상수나 엔진
 * 하프 틱 수가 바뀌어 실제 재생 길이가 이동)은 여기서 못 잡는다 — 그건 {@code tools/pace-config.test.ts}
 * 가 엔진으로 하프를 돌려 직접 재서 대조한다. 둘은 같은 AC 를 다른 층에서 지킨다.
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
