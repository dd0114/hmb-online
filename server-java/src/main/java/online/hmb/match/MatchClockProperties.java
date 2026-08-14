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
     * min 156.1s · p50 183.1s · max 206.8s → 180_000. (구 값 420_000 = 90분 경기·배속 1.0 시절.)
     *
     * <p>#416: <b>220_000</b> — {@code application.yml} 과 갈라져 있던 것을 맞춘다(튜닝이 아니라
     * <b>드리프트 수정</b>). #370/#377 발차가 yml 만 220000 으로 올려서 이 기본값이 #365 값에
     * 남아 있었고, 그 상태는 이 필드의 짝 계약이 스스로 금지한 형태다 —
     * <i>"Java 기본값과 yml 이 갈라지면 프로필이 하나 빠졌을 때 조용히 다른 값이 뜬다"</i>.
     * 런타임은 무변화다(패키징된 yml 이 항상 키를 준다). 이 필드는 폴백
     * ({@code SimulateResponse.playbackMs} 부재 시)의 <b>폴백</b>이라 거기까지 값을 맞춘다.
     *
     * <p>실측(engine@0.41.0, 16하프) = min 196.4 / p50 225.7 / mean 224.0 / max 246.1 s.
     * 220_000 = <b>평균에 맞춘 값</b>이다({@code measure-playback-pace} 권장값). ⚠️ "배율
     * 컨트롤러가 나머지를 흡수한다"고 적지 마라 — <b>폴백 경로엔 배율 보정이 없다</b>
     * ({@code live-pace.paceRate} 는 프로덕션 호출부 0건인 휴면 함수). 그래서 최장 하프는 끝
     * 약 26s 가 안 보이고 최속 하프는 약 24s 빈 시간이 생긴다.
     * 근거·계약 = {@code MatchClockShippedDefaultsTest}.
     */
    private long halfRealMs = 220_000;

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

    /**
     * 한 번의 스윕이 작업 완료를 기다리는 <b>총</b> 상한(ms) — 초과하면 기다리지 않고 다음 스윕으로
     * 넘어간다 (#512, {@link MatchClockService#awaitAll}).
     *
     * <p>⚠️ 이 값은 <b>정상적으로 느린 전이보다 넉넉해야 한다</b>. 후반 시작은 엔진 RPC 를 동기로
     * 물고 있고 그 호출의 최대치는 {@code hmb.servant.simulate-timeout-sec}(30s) × 2(교환 마감) ×
     * (1 + {@code simulate-retries}) = <b>120s</b> 다. 180s 는 그 위의 여유이고, 이 상한에 걸리는
     * 것은 "느린 매치"가 아니라 <b>영원히 안 끝나는 무언가</b>라는 신호로 읽어야 한다.
     */
    private long sweepTaskTimeoutMs = 180_000;

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

    public long getSweepTaskTimeoutMs() {
        return sweepTaskTimeoutMs;
    }

    public void setSweepTaskTimeoutMs(long sweepTaskTimeoutMs) {
        this.sweepTaskTimeoutMs = sweepTaskTimeoutMs;
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
