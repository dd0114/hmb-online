import { useEffect, useRef, useState, type RefObject } from "react";
import type { ViewerController } from "@hmb/viewer-core";
import type { ControlMode } from "./playback-controls";
import { formatMatchClock, type TimelinePin } from "./timeline-pins";
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
  /**
   * **돌려보는 화면**(감독시간 경기장면 탭 등, #244). 같은 도구를 유저 언어로 다시 배치한다:
   * 트랜스포트 4개(이전 장면·재생·다음 장면·배속) + 한 축 타임라인 + 장면 리스트,
   * 그리고 QA 풀컨트롤(배속 6단·프레임 스텝·mm:ss)은 **"고급"으로 접는다**.
   * 끄면 예전 그대로(관전/QA 무대) — 이게 롤백 스위치다.
   */
  review?: boolean;
}

// 연출 페이스에 곱하는 **배율**(#216) — 1x = 자연 페이스(크루즈 4x / 키장면 1x).
// ⚠️ #216 이후 절대속도가 아니다: 0.1x 는 키장면 창에서 0.2 게임초/실초(구 #180 의 그 속도)지만
// 빌드업 구간에서는 그 4배(0.8)다. **정확한 초를 짚는 건 배속이 아니라 초/프레임 스텝**(hooks.seek,
// 아래 timeGroup)이 담당한다 — 그쪽은 이 변경과 무관하다.
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
  review,
}: PlaybackControlsProps) {
  return (
    <div
      className={review ? `${styles.bar} ${styles.barReview}` : styles.bar}
      data-testid={`viewer-controls-half${half}`}
      data-mode={mode}
      data-review={review ? "true" : undefined}
    >
      {review && (
        <ReviewControls
          half={half}
          viewer={viewer}
          clockRef={clockRef}
          scrubRef={scrubRef}
          pins={pins}
          snapCount={snapCount ?? 0}
        />
      )}

      {mode === "full" && review && (
        /* 고급 = QA 도구. 유저 화면에선 접혀 있고, 펴면 예전 풀컨트롤 그대로다(도구를 뺏지 않는다). */
        <details className={styles.advanced} data-testid={`viewer-advanced-half${half}`}>
          <summary>고급 컨트롤 — 배속·프레임 스텝·시간 점프</summary>
          <AdminControls
            half={half}
            viewer={viewer}
            pins={[]}
            snapCount={snapCount ?? 0}
            lastTick={lastTick ?? 0}
            /* 시계·시간바는 위 돌려보기 줄이 소유한다 — 여기서 또 그리면 같은 testid 가 둘이 된다. */
            nested
          />
        </details>
      )}

      {mode === "full" && !review && (
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
  nested = false,
}: {
  half: 1 | 2;
  viewer: ViewerController | null;
  clockRef?: RefObject<HTMLSpanElement>;
  scrubRef?: RefObject<HTMLInputElement>;
  pins?: TimelinePin[];
  snapCount: number;
  lastTick: number;
  /**
   * 돌려보기 화면의 "고급" 안에 들어갈 때 — 재생/처음·시계·시간바는 **바깥 줄이 소유**한다.
   * 여기서 또 그리면 같은 testid 가 화면에 둘이 되어 계약(그리고 사용자)이 어느 쪽인지 모른다.
   */
  nested?: boolean;
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
      {!nested && (
        <>
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
        </>
      )}
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
        {!nested && (
          <span className={styles.clock} data-testid={`viewer-clock-half${half}`} ref={clockRef} aria-label="경기 시계" />
        )}
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
      {!nested && (
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
      )}
    </div>
  );
}

/** 배속은 유저 화면에선 **한 버튼 순환**이다(6단 나열은 QA 도구다 — 고급으로 내렸다). */
const REVIEW_SPEEDS = [1, 2, 0.5] as const;

/**
 * 돌려보기 컨트롤 (#244) — "필요한 장면을 본다"를 유저 언어로.
 *
 *   [⏮ 이전 장면] ( ▶ ) [다음 장면 ⏭] [1x]
 *   12'34"                     ─ 한 축 타임라인(이벤트 마커 + 재생 핸들이 같은 트랙) ─
 *   8'12" 선방 · 12'34" 선제골 · 19'02" 유효슛 …   ← 이름으로 점프
 *
 * 그전에는 같은 정보가 버튼 21개 + 3층 타임라인으로 흩어져 있었다(재설계 진단).
 * ⚠️ 마커와 핸들이 **같은 트랙 위**에 있어야 "지금 어디"를 읽을 수 있다 — 레인을 나누지 말 것.
 */
function ReviewControls({
  half,
  viewer,
  clockRef,
  scrubRef,
  pins,
  snapCount,
}: {
  half: 1 | 2;
  viewer: ViewerController | null;
  clockRef?: RefObject<HTMLSpanElement>;
  scrubRef?: RefObject<HTMLInputElement>;
  pins?: TimelinePin[];
  snapCount: number;
}) {
  const v = viewer;
  const disabled = !v;
  const [speedIdx, setSpeedIdx] = useState(0);
  const scenes = [...(pins ?? [])].sort((a, b) => a.tick - b.tick);

  /** 지금 위치 기준 앞/뒤 장면. 없으면 처음/마지막으로 — 버튼이 죽은 것처럼 보이지 않게. */
  const jumpScene = (dir: 1 | -1) => {
    if (!v || scenes.length === 0) return;
    const cur = Number((v.hooks as unknown as { cur?: () => { tick?: number } })?.cur?.()?.tick ?? 0);
    const next =
      dir === 1
        ? (scenes.find((p) => p.tick > cur + 1) ?? scenes[scenes.length - 1])
        : ([...scenes].reverse().find((p) => p.tick < cur - 1) ?? scenes[0]);
    if (next) v.jumpToTick(next.tick);
  };

  return (
    <div className={styles.review} data-testid={`viewer-review-half${half}`}>
      <div className={styles.transport}>
        <button
          type="button"
          className={styles.tbtn}
          data-testid={`viewer-prev-scene-half${half}`}
          disabled={disabled || scenes.length === 0}
          onClick={() => jumpScene(-1)}
        >
          ⏮ 이전 장면
        </button>
        <button
          type="button"
          className={styles.play}
          data-testid={`viewer-play-toggle-half${half}`}
          aria-label="재생/정지"
          disabled={disabled}
          onClick={() => v?.togglePlay()}
        >
          ▶
        </button>
        <button
          type="button"
          className={styles.tbtn}
          data-testid={`viewer-next-scene-half${half}`}
          disabled={disabled || scenes.length === 0}
          onClick={() => jumpScene(1)}
        >
          다음 장면 ⏭
        </button>
        <button
          type="button"
          className={styles.speed}
          data-testid={`viewer-speed-cycle-half${half}`}
          disabled={disabled}
          title="재생 속도"
          onClick={() => {
            const next = (speedIdx + 1) % REVIEW_SPEEDS.length;
            setSpeedIdx(next);
            v?.setSpeed(REVIEW_SPEEDS[next]!);
          }}
        >
          {REVIEW_SPEEDS[speedIdx]}x
        </button>
      </div>

      <div className={styles.trackRow}>
        <span className={styles.reviewClock} data-testid={`viewer-clock-half${half}`} ref={clockRef} aria-label="경기 시계" />
        <span className={styles.track} data-testid={`viewer-timeline-half${half}`}>
          <input
            ref={scrubRef}
            type="range"
            min={0}
            max={Math.max(1, snapCount - 1)}
            step={1}
            defaultValue={0}
            className={styles.reviewScrub}
            data-testid={`viewer-scrub-half${half}`}
            disabled={disabled || snapCount <= 1}
            onInput={(e) => v?.scrubTo(pctFromIndex(Number((e.target as HTMLInputElement).value), snapCount))}
            aria-label="시간바 (드래그해서 장면 이동)"
          />
          {scenes.map((p) => (
            <button
              key={`${p.kind}-${p.tick}`}
              type="button"
              className={`${styles.marker} ${p.major ? styles.markerMajor : ""}`}
              data-testid={`viewer-pin-${p.tick}`}
              title={p.label}
              aria-label={p.label}
              disabled={disabled}
              style={{ left: `${p.pct}%`, background: p.color }}
              onClick={() => v?.jumpToTick(p.tick)}
            />
          ))}
        </span>
      </div>

      <ul className={styles.scenes} data-testid={`viewer-scenes-half${half}`}>
        {scenes.map((p) => (
          <li key={`s-${p.kind}-${p.tick}`}>
            <button
              type="button"
              className={p.major ? `${styles.scene} ${styles.sceneMajor}` : styles.scene}
              data-testid={`viewer-scene-${p.tick}`}
              disabled={disabled}
              onClick={() => v?.jumpToTick(p.tick)}
            >
              <span className={styles.sceneTime}>{formatMatchClock(p.tick)}</span>
              <span className={styles.sceneName}>{sceneLabel(p)}</span>
              <span className={styles.sceneDot} style={{ background: p.color }} aria-hidden="true" />
            </button>
          </li>
        ))}
        {scenes.length === 0 && <li className={styles.scenesEmpty}>기록된 장면이 없습니다</li>}
      </ul>
    </div>
  );
}

/** 핀 툴팁(`12'34" · GOAL`)은 QA 표기다 — 리스트에는 사람 말로 적는다. */
function sceneLabel(p: TimelinePin): string {
  switch (p.kind) {
    case "goal":
      return "골";
    case "penalty":
      return "페널티킥";
    case "save":
      return "선방";
    case "shot_on":
      return "유효슛";
    case "corner":
      return "코너킥";
    default:
      return p.label;
  }
}
