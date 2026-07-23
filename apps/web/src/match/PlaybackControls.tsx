import { useRef } from "react";
import type { ViewerController } from "@hmb/viewer-core";
import type { ControlMode } from "./playback-controls";
import styles from "./PlaybackControls.module.css";

interface PlaybackControlsProps {
  half: 1 | 2;
  mode: ControlMode;
  /** admin/QA 자격 — 모드 전환 토글 노출 여부. */
  canSwitch: boolean;
  /** 하이라이트 연출(주요장면 슬로우·접촉 줌)이 켜져 있는지 — 뷰어 상태(autoPace). */
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  onMode: (m: ControlMode) => void;
  /** 직접 마운트한 코어 컨트롤러(#169 S3) — full 모드 풀컨트롤이 이걸 조작한다. */
  viewer: ViewerController | null;
}

const SPEEDS = [0.25, 0.5, 1, 2, 4] as const;

/**
 * 경기 재생 컨트롤 바 (#148, #169 S3 직접 마운트).
 *  - 플레이 모드(일반 유저): **하이라이트 토글 하나뿐**. 경기는 자동 진행(재생/일시정지·배속·되감기·
 *    프레임점프·스크럽 없음). 토글은 실제로 뷰어 연출(autoPace)을 끄고 켠다.
 *  - full 모드(admin/QA): 코어 풀컨트롤(재생·배속·스크럽·프레임점프·뷰모드) — 디버그/검수용.
 *    (S2 이전엔 iframe 안 dev-viewer 컨트롤을 썼으나, S3 에서 iframe 이 사라져 web 이 직접 그린다.)
 */
export function PlaybackControls({
  half,
  mode,
  canSwitch,
  highlight,
  onHighlight,
  onMode,
  viewer,
}: PlaybackControlsProps) {
  return (
    <div className={styles.bar} data-testid={`viewer-controls-half${half}`} data-mode={mode}>
      {mode === "play" ? (
        <button
          type="button"
          className={[styles.highlight, highlight ? styles.highlightOn : ""].join(" ")}
          data-testid={`viewer-highlight-toggle-half${half}`}
          aria-pressed={highlight}
          title="골·파울 등 주요장면을 슬로우와 확대로 보여줍니다. 끄면 일정 속도로 쭉 진행합니다."
          onClick={() => onHighlight(!highlight)}
        >
          🎬 하이라이트 {highlight ? "켜짐" : "꺼짐"}
        </button>
      ) : (
        <AdminControls half={half} viewer={viewer} />
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

/** admin/QA 풀컨트롤 — 코어 컨트롤러 직접 조작(#169 S3). 뷰어 준비 전이면 비활성. */
function AdminControls({ half, viewer }: { half: 1 | 2; viewer: ViewerController | null }) {
  const scrubRef = useRef<HTMLInputElement>(null);
  const v = viewer;
  const disabled = !v;
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
      <input
        ref={scrubRef}
        type="range"
        min={0}
        max={100}
        step={0.1}
        defaultValue={0}
        className={styles.scrub}
        data-testid={`viewer-scrub-half${half}`}
        disabled={disabled}
        onInput={(e) => v?.scrubTo((e.target as HTMLInputElement).value)}
        aria-label="스크럽"
      />
    </div>
  );
}
