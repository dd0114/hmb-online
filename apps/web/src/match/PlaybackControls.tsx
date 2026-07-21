import type { ControlMode, PlaySpeed } from "./playback-controls";
import { PLAY_SPEEDS } from "./playback-controls";
import styles from "./PlaybackControls.module.css";

interface PlaybackControlsProps {
  half: 1 | 2;
  mode: ControlMode;
  /** admin/QA 자격 — 모드 전환 토글 노출 여부. */
  canSwitch: boolean;
  playing: boolean;
  ended: boolean;
  speed: number;
  /** 하이라이트 자동페이싱 중인지(뷰어 Highlights) — true 면 배속 칩은 비활성 표시. */
  auto: boolean;
  onToggle: () => void;
  onSpeed: (s: PlaySpeed) => void;
  onAuto: () => void;
  onMode: (m: ControlMode) => void;
}

/**
 * 경기 재생 컨트롤 바 (#148). 플레이 모드는 업계 표준(FM/FIFA)처럼 **진행 위주** —
 * 재생/일시정지 + 관람 페이스 몇 단계뿐이고, 되감기·프레임점프·타임라인 스크럽·배율은 노출하지 않는다.
 * admin/QA(풀컨트롤)에선 뷰어 iframe 내부의 원래 컨트롤을 그대로 쓰므로 web 바는 중복 노출하지 않는다.
 *
 * 페이스 단계 = [🎬 하이라이트] + [1x·2x·4x]. FM 의 "하이라이트 모드 + 경기 속도"와 같은 축이다:
 * 하이라이트는 뷰어의 자동페이싱(빌드업 빠르게, 찬스 근처 느리게), 배속은 일정 속도 관람.
 * 뷰어는 자동페이싱이 켜져 있으면 speed 를 무시하므로 배속 선택 시 브리지가 자동페이싱을 끈다.
 */
export function PlaybackControls({
  half,
  mode,
  canSwitch,
  playing,
  ended,
  speed,
  auto,
  onToggle,
  onSpeed,
  onAuto,
  onMode,
}: PlaybackControlsProps) {
  const toggleLabel = ended ? "↺ 다시 보기" : playing ? "⏸ 일시정지" : "▶ 재생";

  return (
    <div className={styles.bar} data-testid={`viewer-controls-half${half}`} data-mode={mode}>
      {mode === "play" ? (
        <>
          <button
            type="button"
            className={styles.transport}
            data-testid={`viewer-play-toggle-half${half}`}
            aria-label={ended ? "다시 보기" : playing ? "일시정지" : "재생"}
            onClick={onToggle}
          >
            {toggleLabel}
          </button>
          <div className={styles.speeds} role="group" aria-label="관람 페이스">
            <button
              type="button"
              className={[styles.speed, styles.autoChip, auto ? styles.speedOn : ""].join(" ")}
              data-testid={`viewer-pace-auto-half${half}`}
              aria-pressed={auto}
              title="빌드업은 빠르게, 찬스 근처는 느리게 — 자동 하이라이트 페이스"
              onClick={onAuto}
            >
              🎬 하이라이트
            </button>
            {PLAY_SPEEDS.map((s) => (
              <button
                key={s}
                type="button"
                className={[styles.speed, !auto && speed === s ? styles.speedOn : ""].join(" ")}
                data-testid={`viewer-speed-${s}-half${half}`}
                aria-pressed={!auto && speed === s}
                onClick={() => onSpeed(s)}
              >
                {s}x
              </button>
            ))}
          </div>
        </>
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
