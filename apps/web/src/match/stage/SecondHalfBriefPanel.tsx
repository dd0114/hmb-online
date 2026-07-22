import styles from "./panels.module.css";

export interface SecondHalfBriefPanelProps {
  /**
   * 감독시간 마감 시각(ISO). **W2(#170)가 채운다** — 그전엔 null 이라 카운트다운이 비활성.
   * 서버가 시각의 SoT(P4-D1/AC-W3-3)이므로 이 컴포넌트는 소비만 한다.
   */
  deadlineAt?: string | null;
  /** 작성 중인 후반 팀 지시. W2 에서 상위가 소유(임시저장 → 하프타임 제출). */
  draft?: string;
  onDraft?: (value: string) => void;
}

/**
 * [D] 후반 사전입력창 — **W2 계약 자리(비활성 스텁)**.
 *
 * S1(#169)의 범위는 "레이아웃 안에서 이 패널이 차지할 자리와 계약을 확정"하는 것까지다.
 * 실제 제출·카운트다운·프리셋 로드는 P4-E2(#170, 감독시간 60초 + 서버 권위 시계)가 배선한다
 * (PRD-v5 AC-W2-1/2, docs/plan-v5/layout-game-screen.md §2.4).
 *
 * 지금 눌러도 아무 일이 없다는 걸 화면에서 분명히 말한다 — 되는 척하는 UI 를 두지 않는다.
 */
export function SecondHalfBriefPanel({ deadlineAt = null, draft = "", onDraft }: SecondHalfBriefPanelProps) {
  const enabled = Boolean(deadlineAt);

  return (
    <div data-testid="stage-panel-brief">
      <div className={styles.briefHead}>
        <p className={styles.briefTitle}>후반 지시 (미리 작성)</p>
        <span className={styles.countdown} data-testid="brief-countdown">
          ⏱ {deadlineAt ? "--:--" : "준비 중"}
        </span>
      </div>

      <textarea
        className={styles.briefInput}
        data-testid="brief-team-prompt"
        placeholder="예) 후반은 라인을 내리고 역습 위주로"
        value={draft}
        disabled={!enabled}
        readOnly={!onDraft}
        onChange={(e) => onDraft?.(e.target.value)}
      />

      <p className={styles.pending}>
        경기를 보면서 후반 지시를 미리 적어두는 자리입니다. 저장·제출은 <b>감독시간(하프타임 60초)</b>{" "}
        기능과 함께 열립니다 — 지금은 자리만 잡아둔 상태입니다.
        <br />
        하프타임에는 아래 <b>감독</b> 탭에서 교체와 프롬프트를 제출할 수 있습니다.
      </p>
    </div>
  );
}
