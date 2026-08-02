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
 * <p>밴드의 출처는 취향이 아니라 실측이다 — 하이라이트 연출로 리얼 config 하프를 재생한 길이의
 * <b>min~max</b> 다. 재현: {@code node tools/measure-playback-pace.mjs}
 * (모델 = viewer-core {@code autoPaceDurationMs}, 렌더 루프와 같은 상수를 읽는다).
 *
 * <p>⚠️ <b>#365 이후 이 값은 운영 창이 아니라 폴백이다.</b> 하프 창은 러너가 준 그 하프의 실제
 * 재생 길이({@code playbackMs})로 잡히고, 이 config 는 러너가 값을 안 줄 때만 쓰인다(구 러너·
 * 계산 실패). 그래도 밴드를 계속 지키는 이유는 <b>폴백이 실제 재생과 동떨어지면 그 경로에서
 * 재생이 잘리거나 빈 시간이 생기기 때문</b>이다 — 폴백은 "아무 값"이어도 되는 자리가 아니다.
 *
 * <h2>⚠️ 폴백 경로에는 배율 보정이 <b>없다</b> (#416)</h2>
 *
 * <p>이 밴드를 <b>배율 컨트롤러의 흡수 범위</b>(실측 × {@code [PACE_MIN, PACE_MAX]})로 넓히려던
 * 시도가 있었다. 그 전제는 거짓이다 — {@code apps/web/src/match/live-pace.ts} 의 {@code paceRate}
 * 는 <b>프로덕션 호출부가 0건</b>이고({@code apps/web/src/**} 전수), {@code VisualPlayback.tsx} 의
 * 재생 루프는 <i>"배율은 건드리지 않는다(고정 배속만)"</i> 라고 명시한다. {@code live-pace.ts} 자신도
 * 함수를 남겨 둔 이유가 폴백 경로라면서 <b>"되살릴 조건은 그 하나다"</b> 라고 적는다 —
 * 폴백이 발동하면 자동으로 되살아나는 게 아니라 <b>다시 배선해야 하는 휴면 함수</b>다.
 *
 * <p>그래서 잘림이 시작되는 지점은 배율 상한 1.6 이 아니라 <b>1.0</b>, 즉 창이 재생보다 짧아지는
 * 순간 그대로다. 흡수 범위로 넓힌 밴드는 [154s, 335s] 라는 헐거운 창이 되어 <b>300000·335000 이
 * 통과했다</b> = "낡음"을 더는 못 잡는 상태였다. 밴드는 애초에 틀린 형태가 아니었고 <b>낡았을
 * 뿐</b>이라, 정책을 되돌리고 실측만 갱신한다.
 *
 * <h2>대가 — 정직하게 적는다</h2>
 *
 * <p>배포값 <b>220000 은 "안전해서"가 아니라 "평균에 맞춘 값"</b>이다({@code
 * measure-playback-pace} 의 권장값 = mean 반올림 = 220000). 창 하나로 산포를 덮을 수 없으므로
 * 폴백 경로에서는 양쪽 끝이 그대로 대가가 된다:
 * <ul>
 *   <li>가장 긴 하프(246.1s)는 <b>끝 약 26s(11%)가 안 보인 채</b> 하프타임으로 넘어간다.
 *   <li>가장 빠른 하프(196.4s)는 재생이 먼저 끝나 <b>약 24s 빈 시간</b>이 생긴다.
 * </ul>
 * 220000 은 그 둘을 가운데서 맞바꾼 값이다. 잘림을 0 으로 만들려면 창을 max(246.1s) 이상으로
 * 올려야 하고 그러면 빈 시간이 커진다 — 배율 보정이 없는 이상 둘 다 없앨 수는 없다.
 *
 * <p><b>밴드가 곧 정책이다</b>: 실측 min~max 밖으로 나가려면 이 상수도 같이 고쳐야 한다 =
 * "재생과 창을 어긋나게 두겠다"는 의도적 결정이 된다. 실수로 되돌리는 경로는 여기서 막힌다.
 *
 * <p>이 테스트는 <b>사람이 옮겨 적은 숫자</b>를 지킨다. 밴드 자체가 낡는 것(뷰어 페이싱 상수나 엔진
 * 하프 틱 수가 바뀌어 실제 재생 길이가 이동)은 여기서 못 잡는다 — 그건 {@code tools/pace-config.test.ts}
 * 가 엔진으로 하프를 돌려 직접 재서 대조한다. 둘은 같은 AC 를 다른 층에서 지킨다.
 */
class MatchClockShippedDefaultsTest {

    /**
     * 실측 재생 길이의 <b>min~max</b> — engine@<b>0.41.0</b> 트리(#405·#407 머지 후)에서
     * {@code node tools/measure-playback-pace.mjs} 8시드 × 2하프 = 16하프:
     * <b>min 196.4 / p50 225.7 / mean 224.0 / max 246.1 s</b>.
     *
     * <p>이력 — <b>두 세대 낡은 값이 이 테스트를 구조적 red 로 만들었다</b>:
     * #365 engine@0.30.0 = 156.1/183.1/206.8 (밴드 156_000~207_000) →
     * #377 engine@0.34.0 = 205.5/221.8/246.2 (yml 만 220000 으로 갱신, 밴드는 안 옮김) →
     * 지금 engine@0.41.0 = 196.4/225.7/246.1. <b>엔진이 바뀌면 여기도 다시 재라</b> —
     * 창을 옮길 때 밴드를 같이 안 옮기면 그 다음 사람이 red 를 "원래 하나 실패한다"로 읽는다.
     */
    private static final long MEASURED_MIN_MS = 196_400;

    private static final long MEASURED_MAX_MS = 246_100;

    @Test
    void shippedHalfRealMsMatchesMeasuredPlaybackLength() throws Exception {
        long yml = longFromApplicationYml("half-real-ms");
        long javaDefault = new online.hmb.match.MatchClockProperties().getHalfRealMs();

        assertThat(yml)
                .as("half-real-ms 는 켬 모드 실측 재생 길이(196.4~246.1s, engine@0.41.0) 안이어야 한다 — "
                        + "짧으면 재생이 끝나기 전에 하프타임이 열리고(폴백 경로엔 배율 보정이 없어 "
                        + "그만큼이 안 보인 채 넘어간다), 길면 재생이 먼저 끝나 빈 시간이 생긴다")
                .isBetween(MEASURED_MIN_MS, MEASURED_MAX_MS);
        assertThat(javaDefault)
                .as("Java 기본값과 yml 이 갈라지면 프로필이 하나 빠졌을 때 조용히 다른 값이 뜬다")
                .isEqualTo(yml);
    }

    @Test
    void shippedHalftimeMsIsThreeMinutes() throws Exception {
        // #216 hero 지시. 값 자체가 요구사항이라 그대로 박는다(파생·측정 대상이 아니다).
        // #365 에서 hero 재확인 — 하프가 3분이 되어 감독시간과 같아져도 **180초 유지**다.
        // 근거: 감독시간은 하프 길이의 비율이 아니라 *글 쓰는 시간*이고, 하프타임 지시 생성이
        // 실측 57.7s(effort low)~121s(full) 라 120초 아래로 내리면 지시 반영 전에 후반이 시작된다.
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
