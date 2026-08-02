import { useSkipHalf } from "./useSkipHalf";
import { reportHalfOf, skipButtonView } from "./skip-mode";
import type { MatchDetail } from "../api/hooks";
import styles from "./SkipButton.module.css";

export interface SkipButtonProps {
  match: MatchDetail;
  /** 스킵이 **성공했을 때만** 부른다 — 리포트를 열 하프를 넘긴다(전반 스킵 → 1). */
  onSkipped: (half: 1 | 2) => void;
}

/**
 * 경기 스킵 버튼 (#421 W2).
 *
 * **자립 컴포넌트로 둔 이유**(#249 `AutoModeToggle` 선례를 그대로 따른다): 같은 경기 화면을
 * #406(matchux)·#403(pstat)이 동시에 만지는 중이다. 로직·상태·스타일을 여기 모아 두고 호출부에는
 * **한 줄만** 꽂아, 어느 쪽이 먼저 머지되든 충돌이 한 줄로 끝나게 한다.
 *
 * 노출·비활성 규칙은 순수 모듈(`skip-mode.skipButtonView`)이 소유한다 — 화면에 조건을 다시 적으면
 * 규칙이 두 벌이 된다. 409(이미 넘어갔다)는 `useSkipHalf` 가 매치 재조회로 흡수하고 **리포트를 열지
 * 않는다**: 이 요청이 그 하프를 끝낸 게 아니기 때문이다.
 */
export function SkipButton({ match, onSkipped }: SkipButtonProps) {
  const skip = useSkipHalf(match.id);
  const view = skipButtonView({ state: match.state, pending: skip.isPending });

  if (!view.visible || !view.phase) return null;
  const phase = view.phase;

  return (
    <button
      type="button"
      className={styles.skip}
      data-testid="match-skip"
      data-phase={phase}
      title={view.hint}
      aria-label={view.hint}
      disabled={view.disabled}
      onClick={() =>
        skip.mutate(phase, {
          // 응답이 SoT 다 — 성공한 뒤에만 리포트를 연다(낙관적 갱신 금지, useSkipHalf 주석).
          onSuccess: () => onSkipped(reportHalfOf(phase)),
        })
      }
    >
      {view.label}
    </button>
  );
}
