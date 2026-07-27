import { useState } from "react";
import { useSubmitMatchPrompt, type MatchDetail } from "../../api/hooks";
import { countdownLabel, halftimeLengthLabel } from "../live-clock";
import { useCountdown } from "../useCountdown";
import { isHalftimeState } from "./stage-state";
import styles from "./panels.module.css";

export interface SecondHalfBriefPanelProps {
  match: MatchDetail;
  /** 폴링 때 잡아둔 서버-클라 시각차(live-clock.captureOffsetMs). */
  clockOffsetMs?: number;
}

/**
 * 후반 지시를 미리 넣어둘 수 있는 상태 — 서버 허용표 미러(FIRST_HALF 부터, 감독시간까지).
 * 감독시간 판정은 `isHalftimeState` 한 곳에서만 한다(#226 — 상태명이 둘이라 인라인으로 다시 쓰면
 * 한쪽이 빠진 채 조용히 굳는다).
 */
function canSubmitIn(state: string): boolean {
  return state === "FIRST_HALF" || isHalftimeState(state);
}

/**
 * [D] 후반 사전입력창 — **전반을 보면서 후반 팀 지시를 미리 적어 저장**한다(P4-E2 #170 W2 / AC-W2-2).
 *
 * S1(#169)이 잡아둔 자리에 배선만 했다. 저장은 `POST /prompts {phase:"halftime", scope:"team"}` 이고
 * 서버가 UPSERT 하므로 **몇 번을 고쳐 써도 마지막 것 하나**가 후반에 반영된다. 감독시간이 열리면
 * 같은 값이 감독 탭에 이어지고, 아무것도 안 낸 채 감독시간(`clock.halftimeMs`)이 지나면 전반 지시가
 * 그대로 승계된다.
 *
 * 선수별 지시·교체는 감독 탭(HalftimePanel)에서 — 이 패널은 관전 중 한 손으로 쓰는 자리라 팀 지시만 둔다.
 */
export function SecondHalfBriefPanel({ match, clockOffsetMs = 0 }: SecondHalfBriefPanelProps) {
  const submitPrompt = useSubmitMatchPrompt(match.id);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const clock = match.clock ?? null;
  const remaining = useCountdown(clock, clockOffsetMs);
  // 카운트다운은 감독시간에만 의미가 있다(전반 중에는 아직 마감이 정해지지 않았다).
  const deadlineLabel = clock?.phase === "HALFTIME" ? countdownLabel(remaining) : null;
  // 감독시간 길이는 서버 값 파생(웹에 상수 복제 금지 — AC-W3-2).
  const halftimeLabel = halftimeLengthLabel(clock?.halftimeMs);
  const enabled = canSubmitIn(match.state) && !submitPrompt.isPending;

  async function save() {
    const text = draft.trim();
    if (!text) return;
    setError(null);
    try {
      await submitPrompt.mutateAsync({ phase: "halftime", scope: "team", text });
      setSaved(true);
    } catch (err) {
      setSaved(false);
      setError(err instanceof Error ? err.message : "저장하지 못했습니다");
    }
  }

  return (
    <div data-testid="stage-panel-brief">
      <div className={styles.briefHead}>
        <p className={styles.briefTitle}>후반 지시 (미리 작성)</p>
        <span className={styles.countdown} data-testid="brief-countdown">
          ⏱ {deadlineLabel ?? (canSubmitIn(match.state) ? "전반 진행 중" : "—")}
        </span>
      </div>

      <textarea
        className={styles.briefInput}
        data-testid="brief-team-prompt"
        placeholder="예) 후반은 라인을 내리고 역습 위주로"
        value={draft}
        disabled={!canSubmitIn(match.state)}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
      />

      <div className={styles.briefActions}>
        <button
          type="button"
          className={styles.briefSave}
          data-testid="brief-save"
          disabled={!enabled || !draft.trim()}
          onClick={save}
        >
          {submitPrompt.isPending ? "저장 중…" : "저장"}
        </button>
        {saved && (
          <span className={styles.savedNote} data-testid="brief-saved">
            저장됨 — 후반에 반영됩니다 (다시 저장하면 덮어씁니다)
          </span>
        )}
        {error && (
          <span className={styles.issue} data-testid="brief-error">
            {error}
          </span>
        )}
      </div>

      <p className={styles.pending}>
        경기를 보면서 후반 팀 지시를 미리 적어두는 자리입니다. 선수별 지시와 교체는 <b>감독</b> 탭에서
        하프타임에 확정합니다. 감독시간{halftimeLabel && `(${halftimeLabel})`} 안에 아무것도 내지 않으면{" "}
        <b>전반 지시가 그대로</b> 이어집니다.
      </p>
    </div>
  );
}
