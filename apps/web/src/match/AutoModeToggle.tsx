import { autoCopy, canToggleAuto } from "./auto-mode";
import { useSetAuto, type MatchDetail } from "../api/hooks";
import styles from "./AutoModeToggle.module.css";

interface AutoModeToggleProps {
  match: MatchDetail;
  /** "row" = 브리핑의 설명 있는 토글 행 / "pill" = 관전 스코어바의 한 탭 알약. */
  variant?: "row" | "pill";
}

/**
 * 오토 모드 토글 (#249) — 켜 두면 전반이 끝날 때 감독시간(3분) 없이 후반이 바로 시작된다.
 *
 * <p>**자립 컴포넌트로 둔 이유**: #244(프롬프트 1급 UI 개편)가 브리핑·하프타임 레이아웃을 갈아엎는
 * 중이다. 여기에 로직을 모아 두고 호출부에는 한 줄만 꽂아, 어느 쪽이 먼저 머지되든 충돌이 한 줄로
 * 끝나게 한다(#249 ↔ #244 파일 조율).
 *
 * <p>낙관적 갱신을 하지 않는다 — 이 토글은 서버 흐름을 바꾸는 스위치라, 요청이 실패했는데 화면만
 * 켜져 있으면 유저는 감독시간이 없을 줄 알고 자리를 뜬다. 서버 응답이 온 뒤에만 상태가 바뀐다.
 */
export function AutoModeToggle({ match, variant = "row" }: AutoModeToggleProps) {
  const setAuto = useSetAuto(match.id);
  const copy = autoCopy(match.auto);

  if (!canToggleAuto(match.state)) {
    return null;
  }

  const toggle = () => setAuto.mutate(!match.auto);

  if (variant === "pill") {
    return (
      <button
        type="button"
        className={`${styles.pill} ${copy.pressed ? styles.on : ""}`}
        onClick={toggle}
        disabled={setAuto.isPending}
        aria-pressed={copy.pressed}
        title={copy.hint}
        data-testid="auto-mode-pill"
        data-auto={copy.pressed ? "on" : "off"}
      >
        ⚡ AUTO
      </button>
    );
  }

  return (
    <div className={styles.row} data-testid="auto-mode-row">
      <div className={styles.text}>
        <span className={styles.label}>⚡ 오토 모드</span>
        <span className={styles.hint} data-testid="auto-mode-hint">
          {copy.hint}
        </span>
      </div>
      <button
        type="button"
        className={`${styles.switch} ${copy.pressed ? styles.on : ""}`}
        onClick={toggle}
        disabled={setAuto.isPending}
        aria-pressed={copy.pressed}
        aria-label="오토 모드"
        data-testid="auto-mode-switch"
        data-auto={copy.pressed ? "on" : "off"}
      >
        {copy.label}
      </button>
    </div>
  );
}
