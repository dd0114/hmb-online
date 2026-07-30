package online.hmb.match;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 오토 모드 설정 — {@code hmb.match.auto.*} (#249).
 *
 * <p>{@code enabled=false} = 롤백 스위치. 끄면 전반 종료 경계가 {@code matches.auto_mode} 를
 * <b>보지 않는다</b> — 이미 켜 둔 매치까지 전부 정상 감독시간으로 돌아온다. 토글 엔드포인트는 계속
 * 200 이라(플래그 저장만 하고 흐름에 영향이 없다) 스위치를 내려도 클라에 에러가 뜨지 않는다.
 * "끄면 조용히 현행 동작"이 롤백 스위치의 조건이다(LLD-e2-flow-clock 불변조건 I5).
 */
@Component
@ConfigurationProperties(prefix = "hmb.match.auto")
public class MatchAutoProperties {

    /** 오토 모드 적용 여부. false = 플래그 무시(전부 정상 감독시간). */
    private boolean enabled = true;

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }
}
