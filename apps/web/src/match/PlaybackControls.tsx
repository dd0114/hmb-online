import type { ControlMode } from "./playback-controls";
import styles from "./PlaybackControls.module.css";

interface PlaybackControlsProps {
  half: 1 | 2;
  mode: ControlMode;
  /** admin/QA 자격 — 모드 전환 토글 노출 여부. */
  canSwitch: boolean;
  /** 하이라이트 연출(주요장면 슬로우·접촉 줌)이 켜져 있는지 — 뷰어가 미러링한 실제 상태. */
  highlight: boolean;
  onHighlight: (on: boolean) => void;
  onMode: (m: ControlMode) => void;
}

/**
 * 경기 재생 컨트롤 바 (#148). 플레이 모드에는 **하이라이트 토글 하나뿐**이다 —
 * 경기는 자동 진행하고 재생/일시정지·배속·되감기·프레임점프·스크럽·배율은 노출하지 않는다
 * (hero 재지시 2026-07-21: "유일한 컨트롤은 하이라이트 껐다 켜기 하나").
 *
 * 하이라이트 = 골·파울 등 주요장면 연출(슬로우 + 접촉 줌). 끄면 연출 없이 일정 속도로 쭉 진행한다.
 * admin/QA(풀컨트롤)에선 뷰어 iframe 내부의 원래 컨트롤을 그대로 쓰므로 web 바는 중복 노출하지 않는다.
 */
export function PlaybackControls({
  half,
  mode,
  canSwitch,
  highlight,
  onHighlight,
  onMode,
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
        <span className={styles.fullNote} data-testid={`viewer-full-note-half${half}`}>
          🛠 풀컨트롤(admin/QA) — 되감기·배속·타임라인은 화면 안 뷰어 컨트롤을 사용하세요
        </span>
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
