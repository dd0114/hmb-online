package online.hmb;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import online.hmb.events.BusinessEvent;
import org.junit.jupiter.api.Test;

/**
 * <b>#504 D2 — 클라가 부르는 이름과 서버가 여는 이름이 같은가.</b>
 *
 * <p>온레일 계측은 이 리포에서 <b>유일하게 클라가 사실을 보고하는 경로</b>이고, 입구는
 * {@link BusinessEvent#CLIENT_REPORTABLE} 화이트리스트로 좁혀져 있다(위조 방지). 그래서 두 목록이
 * 갈라지면 <b>실패 방향이 조용하다</b> — 클라가 보낸 이름이 목록에 없으면 400 이고, fire-and-forget
 * 이라 화면에는 아무 신호도 없고, DB 에는 행이 안 생긴다. 즉 <b>"관측이 없다"가 "유저가 그 단계를
 * 안 밟았다"로 읽힌다</b> — 이 웨이브가 없애려던 상태 그 자체가 이름 오타 하나로 되살아난다.
 *
 * <p>왜 소스 스캔인가: 언어 경계라 타입으로 묶을 수 없다. web 쪽 유닛 테스트는 <b>자기 리터럴</b>
 * 을 자기 상수와 대조할 뿐이라(두 값이 같이 틀리면 통과) 경계를 건너는 검사는 한쪽이 상대의 소스를
 * 읽는 형태밖에 없다. 훅 위치를 소스로 검사하는 {@code BusinessEventHookPlacementTest} 와 같은 규율.
 *
 * <p>⚠️ 방향은 <b>양방향</b>이다. 클라에만 있으면 그 이벤트는 영영 400 이고, 서버에만 있으면
 * 아무도 보내지 않는 죽은 화이트리스트 항목이 남아 "기록되고 있다"는 착각을 만든다.
 */
class OnRailClientEventParityTest {

    /** 서버 테스트의 작업 디렉토리는 {@code server-java/} 다. */
    private static final Path WEB_TELEMETRY =
            Path.of("../apps/web/src/onrail/onrail-telemetry.ts");

    /** {@code offerShown: "onrail_offer_shown",} 형태의 값만 뽑는다(키 이름은 자유롭게 바뀔 수 있다). */
    private static final Pattern ONRAIL_LITERAL = Pattern.compile("\"(onrail_[a-z_]+)\"");

    @Test
    void theClientAndTheServerAgreeOnEveryOnRailEventName() throws IOException {
        assertThat(WEB_TELEMETRY)
                .as("web 계측 SoT 가 이 자리에 있어야 한다 — 옮겼으면 이 경로도 옮겨라")
                .exists();

        String source = Files.readString(WEB_TELEMETRY, StandardCharsets.UTF_8);
        Set<String> declaredByClient = new LinkedHashSet<>();
        Matcher m = ONRAIL_LITERAL.matcher(source);
        while (m.find()) {
            declaredByClient.add(m.group(1));
        }

        // ⚠️ 공허함 방지: 정규식이 아무것도 못 찾아도 "차집합 0"은 참이다.
        assertThat(declaredByClient)
                .as("클라 소스에서 온레일 이벤트 이름을 하나도 못 찾았다 = 스캐너가 죽은 것이다")
                .hasSize(BusinessEvent.CLIENT_REPORTABLE.size());

        assertThat(declaredByClient)
                .as("클라가 부르는데 서버가 안 여는 이름 = 그 계측은 영영 400 이고 화면엔 신호가 없다")
                .containsExactlyInAnyOrderElementsOf(BusinessEvent.CLIENT_REPORTABLE);
    }

    @Test
    void theClientOnlySpeaksNamesThatAreAlsoQueryable() throws IOException {
        // 조회 필터가 미지 event 를 400 으로 거절하므로(#492), 기록만 되고 못 읽는 이름이 있으면 안 된다.
        String source = Files.readString(WEB_TELEMETRY, StandardCharsets.UTF_8);
        Matcher m = ONRAIL_LITERAL.matcher(source);
        while (m.find()) {
            assertThat(BusinessEvent.KNOWN)
                    .as("%s 가 KNOWN 에 없다 — 기록해 놓고 admin 조회에서 400 이 난다", m.group(1))
                    .contains(m.group(1));
        }
    }
}
