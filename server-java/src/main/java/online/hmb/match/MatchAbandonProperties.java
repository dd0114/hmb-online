package online.hmb.match;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 매치 회수(포기·방치) 설정 — {@code hmb.match.abandon.*} (#217 AC3).
 *
 * <p>잠금(진행 중 매치 1개 제한)의 대가는 <b>고아 매치가 곧 계정 잠금</b>이라는 것이다. 그래서
 * 회수 경로가 둘 있고, 둘 다 여기 있는 값으로만 움직인다(시간 상수 하드코딩 금지 — 루트 §2-4).
 *
 * <ul>
 *   <li><b>수동 포기</b>: 유저가 누른다. 정상 재생 중에는 막는다(시계가 반드시 FINISHED 까지 민다) —
 *       열어두면 지고 있는 경기를 버리고 다시 뽑는 리롤이 된다. 대신 <b>명백히 멈춘</b> 라이브 단계
 *       ({@code phase_ends_at} 가 {@link #stuckGraceMs} 넘게 지났다)는 열어준다.</li>
 *   <li><b>자동 백스톱</b>: {@link #staleAfterMin} 넘게 안 끝난 비터미널 매치를 스위퍼가 회수한다.
 *       정상 매치는 10분 안에 끝나므로 정상 플레이를 건드릴 여지가 없다.</li>
 * </ul>
 */
@Component
@ConfigurationProperties(prefix = "hmb.match.abandon")
public class MatchAbandonProperties {

    /**
     * 라이브 단계가 "멈췄다"고 보는 유예(ms). 단계 종료 예정 시각(phase_ends_at)에서 이만큼 더 지나도
     * 상태가 그대로면 시계·스위퍼가 죽은 것이므로 유저에게 포기 버튼을 연다. 스위퍼 주기(1s)와
     * 후반 시뮬 시간을 넉넉히 덮는 값이어야 한다 — 짧으면 정상적인 후반 시작 대기 중에 포기가 열린다.
     */
    private long stuckGraceMs = 300_000;

    /**
     * 비터미널 매치를 자동 회수하는 나이(분, created_at 기준). 정상 매치는 브리핑 포함 수십 분 안에
     * 끝나므로 넉넉히 잡는다 — 이건 "정리"가 아니라 <b>락아웃 백스톱</b>이다.
     */
    private long staleAfterMin = 720;

    /** 방치 스윕 주기(ms). 시계(1s)·잡(10s) 스위퍼와 달리 급할 게 없다. */
    private long sweepIntervalMs = 600_000;

    public long getStuckGraceMs() {
        return stuckGraceMs;
    }

    public void setStuckGraceMs(long stuckGraceMs) {
        this.stuckGraceMs = stuckGraceMs;
    }

    public long getStaleAfterMin() {
        return staleAfterMin;
    }

    public void setStaleAfterMin(long staleAfterMin) {
        this.staleAfterMin = staleAfterMin;
    }

    public long getSweepIntervalMs() {
        return sweepIntervalMs;
    }

    public void setSweepIntervalMs(long sweepIntervalMs) {
        this.sweepIntervalMs = sweepIntervalMs;
    }
}
