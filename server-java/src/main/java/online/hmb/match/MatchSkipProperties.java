package online.hmb.match;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 경기 스킵 설정 — {@code hmb.match.skip.*} (#421).
 *
 * <p>{@code enabled=false} = <b>롤백 스위치</b>. 이 기능은 P4-D1 "전반 재생 중 후반 앞당기기 금지"를
 * hero 지시로 뒤집는 것이라(근거 계약 = {@link MatchService#resumeCas} 주석 · openapi {@code /resume}
 * 409) 되돌릴 수 있어야 한다. 끄면 {@code POST /api/matches/{id}/skip} 은 409 이고 재생 창은
 * <b>한 밀리초도 움직이지 않는다</b> = 시계 소유권이 서버에만 있는 원 규칙으로 복귀한다.
 *
 * <p>왜 200 no-op 이 아니라 409 인가: 오토 토글(#249)은 "플래그 저장"이라 끈 상태에서도 200 이
 * 정직했지만, 스킵은 <b>요청이 곧 상태 변화</b>다. 끈 상태에서 200 을 주면 클라는 다음 단계가
 * 열렸다고 믿고 리포트를 띄운다 — 조용한 성공이 화면을 거짓말시킨다.
 */
@Component
@ConfigurationProperties(prefix = "hmb.match.skip")
public class MatchSkipProperties {

    /** 스킵 허용 여부. false = 롤백(스킵 요청은 409, 창 무접촉). */
    private boolean enabled = true;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }
}
