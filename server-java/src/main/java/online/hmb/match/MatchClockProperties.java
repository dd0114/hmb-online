package online.hmb.match;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.stereotype.Component;

/**
 * 서버 권위 시계 설정 — {@code hmb.match.clock.*} (P4-D1/D2, LLD-e2-flow-clock §5).
 *
 * <p>AC-W3-2 "압축비·전반 실시간 길이·감독시간·seek 정책 전부 config": 이 클래스가 그 값들의 유일한
 * 접근 지점이다(코드에 시간 상수를 쓰지 않는다). 압축비는 <b>노브가 아니라 파생값</b>이다 —
 * 노브는 {@code half-real-ms}(하프를 실시간 몇 ms 에 보여줄까)이고, 압축비는 클라가
 * {@code tickCount * msPerTick / halfRealMs} 로 계산한다(로그 길이가 바뀌어도 창에 정확히 맞는다).
 *
 * <p>{@code enabled=false} = 롤백 스위치: 시계 이전 동작(전반 시뮬 직후 감독시간 대기, 후반 시뮬 직후
 * 즉시 종료·정산)으로 돌아간다(§7.7).
 */
@Component
@ConfigurationProperties(prefix = "hmb.match.clock")
public class MatchClockProperties {

    /** 시계 적용 여부. false = 레거시 즉시 전개(롤백). */
    private boolean enabled = true;

    /**
     * 하프당 실시간 재생 길이(ms). 전·후반 동일.
     *
     * <p>#216: 값의 기준은 <b>하이라이트 켬(연출) 모드의 실측 재생 길이</b>다 — 화면이 그 페이싱으로
     * 돌기 때문에, 창이 그보다 짧으면 재생이 끝나기 전에 하프타임이 열린다(구 240s = 실측의 57%).
     *
     * <p>#365(하프 절대 3분): 엔진 45분(하프 1350틱) + 코어 배속 1.2. engine@0.30.0 실측 16하프 =
     * min 156.1s · p50 183.1s · max 206.8s → 180_000. 창 대비 필요 배율 0.87~1.15 로 배율
     * 컨트롤러 [0.6, 1.6] 안이다. (구 값 420_000 = 90분 경기·배속 1.0 시절.)
     */
    private long halfRealMs = 180_000;

    /** 감독시간 길이(ms) — #216 hero 지시 = 3분(구 P4-D2 60초). */
    private long halftimeMs = 180_000;

    /** 감독시간 만료 시 후반 자동 시작(=전반 프롬프트 승계). false 면 HALFTIME 에서 수동 대기. */
    private boolean autoResumeOnExpiry = true;

    /** 시계 스위퍼 주기(ms). 잡 스위퍼(10s)와 별도 — 초 단위 경계라 촘촘히 돈다. */
    private long sweepIntervalMs = 1_000;

    /**
     * 만료 스윕 동시 실행 매치 수. 후반 시작은 동기 엔진 RPC 를 물고 있어, 순차로 돌면 한 매치의
     * 시뮬이 도는 동안 다른 모든 매치의 시계가 멈춘다(독립검증 major).
     */
    private int sweepParallelism = 4;

    private Seek seek = new Seek();

    public boolean isEnabled() {
        return enabled;
    }

    public void setEnabled(boolean enabled) {
        this.enabled = enabled;
    }

    public long getHalfRealMs() {
        return halfRealMs;
    }

    public void setHalfRealMs(long halfRealMs) {
        this.halfRealMs = halfRealMs;
    }

    public long getHalftimeMs() {
        return halftimeMs;
    }

    public void setHalftimeMs(long halftimeMs) {
        this.halftimeMs = halftimeMs;
    }

    public boolean isAutoResumeOnExpiry() {
        return autoResumeOnExpiry;
    }

    public void setAutoResumeOnExpiry(boolean autoResumeOnExpiry) {
        this.autoResumeOnExpiry = autoResumeOnExpiry;
    }

    public long getSweepIntervalMs() {
        return sweepIntervalMs;
    }

    public void setSweepIntervalMs(long sweepIntervalMs) {
        this.sweepIntervalMs = sweepIntervalMs;
    }

    public int getSweepParallelism() {
        return sweepParallelism;
    }

    public void setSweepParallelism(int sweepParallelism) {
        this.sweepParallelism = sweepParallelism;
    }

    public Seek getSeek() {
        return seek;
    }

    public void setSeek(Seek seek) {
        this.seek = seek;
    }

    /** seek 정책 — 클라가 강제한다(서버 로그 절단은 PvP 백로그, LLD §11 R3). */
    public static class Seek {

        /** 라이브 앞서가기 금지. 뒤로 스크럽은 항상 자유. */
        private boolean forwardBlocked = true;

        /** 네트워크 지연·클럭 스큐 허용 오차(ms). */
        private long graceMs = 1_500;

        public boolean isForwardBlocked() {
            return forwardBlocked;
        }

        public void setForwardBlocked(boolean forwardBlocked) {
            this.forwardBlocked = forwardBlocked;
        }

        public long getGraceMs() {
            return graceMs;
        }

        public void setGraceMs(long graceMs) {
            this.graceMs = graceMs;
        }
    }
}
