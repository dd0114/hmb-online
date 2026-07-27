import { useEffect, useRef, type RefObject } from "react";
import type { ViewerController } from "@hmb/viewer-core";
import type { ControlMode } from "./playback-controls";
import type { TimelinePin } from "./timeline-pins";
import {
  clampTick,
  parseClockInput,
  pctFromIndex,
  qaKeyAction,
  stepSeconds,
} from "./qa-time-controls";
import styles from "./PlaybackControls.module.css";

interface PlaybackControlsProps {
  half: 1 | 2;
  mode: ControlMode;
  /** admin/QA 자격 — 모드 전환 토글 노출 여부. */
  canSwitch: boolean;
  onMode: (m: ControlMode) => void;
  /** 직접 마운트한 코어 컨트롤러(#169 S3) — full 모드 풀컨트롤이 이걸 조작한다. */
  viewer: ViewerController | null;
  /** QA 시계(`12'34" / 24'00"`) 표시 슬롯 — 호스트가 코어 onClock 으로 직접 갱신한다(#177). */
  clockRef?: RefObject<HTMLSpanElement>;
  /** 스크럽 핸들 — 호스트가 코어 onScrub 으로 위치를 따라가게 한다(#177). */
  scrubRef?: RefObject<HTMLInputElement>;
  /** 타임라인 키 장면 핀(골/PK/선방/유효슛/코너) — 클릭하면 그 틱으로 점프(#177). */
  pins?: TimelinePin[];
  /** 로그 스냅샷 수 — 스크럽 눈금(1칸 = 1스냅샷)과 프레임 스텝 기준(#180). */
  snapCount?: number;
  /** 마지막 재생 가능 틱 — 초 스텝이 경기 밖으로 나가지 않게(#180). */
  lastTick?: number;
}

// 연출 페이스에 곱하는 **배율**(#216) — 1x = 자연 페이스(크루즈 4x / 키장면 1x).
// 0.1x 는 "한 초 안에서 무슨 일이 일어났나"를 눈으로 따라가는 속도(#180).
const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4] as const;

/**
 * 경기 재생 컨트롤 바 (#148, #169 S3 직접 마운트).
 *  - 플레이 모드(일반 유저): **컨트롤 없음**. 경기는 하이라이트 연출로 자동 진행된다.
 *    (#216 에서 하이라이트 토글을 지웠다 — 끔 모드는 렌더가 깨진 채였고, 라이브 재생이 그 경로를
 *     강제로 타고 있었다. 켬이 유일 모드가 되면서 끌 수단 자체가 사라졌다.)
 *  - full 모드(admin/QA): 코어 풀컨트롤(재생·배속·스크럽·프레임점프·뷰모드) — 디버그/검수용.
 *    (S2 이전엔 iframe 안 dev-viewer 컨트롤을 썼으나, S3 에서 iframe 이 사라져 web 이 직접 그린다.)
 */
export function PlaybackControls({
  half,
  mode,
  canSwitch,
  onMode,
  viewer,
  clockRef,
  scrubRef,
  pins,
  snapCount,
  lastTick,
}: PlaybackControlsProps) {
  return (
    <div className={styles.bar} data-testid={`viewer-controls-half${half}`} data-mode={mode}>
      {mode === "full" && (
        <AdminControls
          half={half}
          viewer={viewer}
          clockRef={clockRef}
          scrubRef={scrubRef}
          pins={pins}
          snapCount={snapCount ?? 0}
          lastTick={lastTick ?? 0}
        />
      )}

      {canSwitch && (
        <div className={styles.modes} role="group" aria-label="컨트롤 모드" data-testid={`viewer-mode-toggle-half${half}`}>
          <button
            type="button"
            className={[styles.mode, mode === "play" ? styles.modeOn : ""].join(" ")}
            data-testid={`viewer-mode-play-half${half}`}
            aria-pressed={mode === "play"}
            onClick={() => onMode("play")}
          >
            🎮 플레이
          </button>
          <button
            type="button"
            className={[styles.mode, mode === "full" ? styles.modeOn : ""].join(" ")}
            data-testid={`viewer-mode-full-half${half}`}
            aria-pressed={mode === "full"}
            onClick={() => onMode("full")}
          >
            🛠 풀컨트롤
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * admin/QA 풀컨트롤 — 코어 컨트롤러 직접 조작(#169 S3). 뷰어 준비 전이면 비활성.
 * #177: 구 QA 뷰어 셸이 갖고 있던 **시계(분:초)·재생위치 추종 스크럽·타임라인 이벤트 핀**을
 * 여기로 되살렸다. hero 의 눈 QA 절차("몇 분 몇 초 장면을 지목하고 되돌려 본다")가 이것에 걸려 있다.
 */
function AdminControls({
  half,
  viewer,
  clockRef,
  scrubRef,
  pins,
  snapCount,
  lastTick,
}: {
  half: 1 | 2;
  viewer: ViewerController | null;
  clockRef?: RefObject<HTMLSpanElement>;
  scrubRef?: RefObject<HTMLInputElement>;
  pins?: TimelinePin[];
  snapCount: number;
  lastTick: number;
}) {
  const v = viewer;
  const disabled = !v;
  const gotoRef = useRef<HTMLInputElement>(null);

  // --- 초단위 이동(#180) ---
  // 정밀 이동은 **hooks.seek** 로만 한다: 컨트롤러의 jumpToTick 은 맥락용으로 3 스냅샷 되감기 때문에
  // (viewer.impl.mjs) "그 초에 정확히 선다"를 만족하지 못한다. 핀 클릭(장면 점프)만 jumpToTick 유지.
  const hooks = () => v?.hooks as unknown as {
    cur?: () => { tick?: number; tickPosIdx?: number };
    seek?: (tick: number) => void;
  } | undefined;
  const curTick = () => Number(hooks()?.cur?.()?.tick ?? 0);
  const curIndex = () => {
    const c = hooks()?.cur?.();
    return Number(c?.tickPosIdx ?? c?.tick ?? 0);
  };
  const seekTick = (tick: number) => hooks()?.seek?.(clampTick(tick, lastTick));
  const stepSec = (delta: number) => seekTick(stepSeconds(curTick(), delta, lastTick));
  const stepFrame = (delta: number) => {
    if (snapCount <= 1) return;
    v?.scrubTo(pctFromIndex(curIndex() + delta, snapCount));
  };
  const gotoClock = () => {
    const tick = parseClockInput(gotoRef.current?.value);
    if (tick == null) return;
    seekTick(tick);
  };

  // 키보드: ←/→ ∓1초, Shift+←/→ ∓5초, `,`/`.` ∓1프레임, Space 재생/정지.
  // 입력창 타이핑 중에는 무시한다(qa-key-action 이 판단).
  useEffect(() => {
    if (!v) return;
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      const action = qaKeyAction({ key: e.key, shiftKey: e.shiftKey, typing });
      if (!action) return;
      e.preventDefault(); // 스페이스/화살표의 페이지 스크롤 방지
      if (action.kind === "second") stepSec(action.delta);
      else if (action.kind === "frame") stepFrame(action.delta);
      else v.togglePlay();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // 콜백들은 매 렌더 새로 만들어지지만 참조는 v·범위값만 쓴다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [v, lastTick, snapCount]);
  return (
    <div className={styles.admin} data-testid={`viewer-admin-half${half}`}>
      <button
        type="button"
        className={styles.mode}
        data-testid={`viewer-play-toggle-half${half}`}
        disabled={disabled}
        onClick={() => v?.togglePlay()}
      >
        ⏯ 재생/정지
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-restart-half${half}`} disabled={disabled} onClick={() => v?.restart()}>
        ⟲ 처음
      </button>
      <span className={styles.speeds} role="group" aria-label="배속">
        {SPEEDS.map((s) => (
          <button
            key={s}
            type="button"
            className={styles.mode}
            data-testid={`viewer-speed-${s}-half${half}`}
            disabled={disabled}
            title={`연출 페이스의 ${s}배로 재생 (1x = 자연 페이스, 하이라이트 슬로우 유지)`}
            onClick={() => v?.setSpeed(s)}
          >
            {s}x
          </button>
        ))}
      </span>
      <button type="button" className={styles.mode} data-testid={`viewer-prev-goal-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("goal", -1)}>
        ◀골
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-next-goal-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("goal", 1)}>
        골▶
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-prev-shot-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("shot", -1)}>
        ◀슛
      </button>
      <button type="button" className={styles.mode} data-testid={`viewer-next-shot-half${half}`} disabled={disabled} onClick={() => v?.jumpEvent("shot", 1)}>
        슛▶
      </button>
      {/* 초단위 시간 컨트롤(#180) — 정확한 초에 세워 "mm:ss 에 X 발생" 이라 말할 수 있게. */}
      <span className={styles.timeGroup} role="group" aria-label="초단위 시간 이동">
        <button type="button" className={styles.mode} data-testid={`viewer-step-minus5s-half${half}`} disabled={disabled} title="5초 뒤로 (Shift+←)" onClick={() => stepSec(-5)}>
          ⏪5s
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-minus1s-half${half}`} disabled={disabled} title="1초 뒤로 (←)" onClick={() => stepSec(-1)}>
          ◀1s
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-minus1f-half${half}`} disabled={disabled} title="1프레임(스냅샷) 뒤로 (,)" onClick={() => stepFrame(-1)}>
          ◂f
        </button>
        {/* 경기 시계 — 코어 onClock 이 `12'34" / 24'00"` 로 매 프레임 갱신(호스트 ref 직접 조작). */}
        <span className={styles.clock} data-testid={`viewer-clock-half${half}`} ref={clockRef} aria-label="경기 시계" />
        <button type="button" className={styles.mode} data-testid={`viewer-step-plus1f-half${half}`} disabled={disabled} title="1프레임(스냅샷) 앞으로 (.)" onClick={() => stepFrame(1)}>
          f▸
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-plus1s-half${half}`} disabled={disabled} title="1초 앞으로 (→)" onClick={() => stepSec(1)}>
          1s▶
        </button>
        <button type="button" className={styles.mode} data-testid={`viewer-step-plus5s-half${half}`} disabled={disabled} title="5초 앞으로 (Shift+→)" onClick={() => stepSec(5)}>
          5s⏩
        </button>
        <input
          ref={gotoRef}
          type="text"
          inputMode="numeric"
          className={styles.goto}
          data-testid={`viewer-goto-half${half}`}
          placeholder="mm:ss"
          aria-label="mm:ss 로 이동"
          title="예: 12:34 · 입력 후 Enter"
          disabled={disabled}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              gotoClock();
            }
          }}
        />
      </span>
      <span className={styles.timeline} data-testid={`viewer-timeline-half${half}`}>
        {/* 눈금 = 스냅샷 인덱스(1칸 = 1스냅샷 = 리얼 로그에서 1초). % 눈금이면 한 칸이 5초를
            넘어가 "그 초"를 집을 수 없다(#180). 값 동기화는 호스트가 onScrub 으로 한다. */}
        <input
          ref={scrubRef}
          type="range"
          min={0}
          max={Math.max(1, snapCount - 1)}
          step={1}
          defaultValue={0}
          className={styles.scrub}
          data-testid={`viewer-scrub-half${half}`}
          disabled={disabled || snapCount <= 1}
          onInput={(e) => v?.scrubTo(pctFromIndex(Number((e.target as HTMLInputElement).value), snapCount))}
          aria-label="스크럽(1칸 = 1초)"
        />
        {/* 키 장면 핀 — 클릭하면 그 틱으로 점프(구 QA 뷰어와 동일한 색·높이 규칙). */}
        {(pins ?? []).map((p) => (
          <button
            key={`${p.kind}-${p.tick}`}
            type="button"
            className={`${styles.pin} ${p.major ? styles.pinMajor : styles.pinMinor}`}
            data-testid={`viewer-pin-${p.tick}`}
            title={p.label}
            aria-label={p.label}
            disabled={disabled}
            style={{
              left: `${p.pct}%`,
              width: p.width,
              height: p.height,
              background: p.color,
              zIndex: p.z,
            }}
            onClick={() => v?.jumpToTick(p.tick)}
          />
        ))}
      </span>
    </div>
  );
}
