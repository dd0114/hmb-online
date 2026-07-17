import { useEffect, useState } from "react";
import { useRetry, type MatchDetail } from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import styles from "./GenWaitPanel.module.css";

interface GenWaitPanelProps {
  match: MatchDetail;
}

/** GEN1/GEN2 대기 (스피너+단계 문구+경과 시간, AC-W4) + FAILED(사유+재시도, AC-M7). */
export function GenWaitPanel({ match }: GenWaitPanelProps) {
  const retry = useRetry(match.id);
  const [elapsed, setElapsed] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const failed = match.state === "FAILED";

  // 경과 시간 — 패널 마운트(상태 진입) 기준. 상태가 바뀌면 리셋.
  useEffect(() => {
    setElapsed(0);
    if (failed) return;
    const t = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(t);
  }, [match.state, failed]);

  if (failed) {
    return (
      <div className={styles.panel} data-testid="failed-panel">
        <p className={styles.failIcon} aria-hidden="true">
          ⚠
        </p>
        <h3 className={styles.failTitle}>작전 생성에 실패했습니다</h3>
        <p className={styles.failReason} data-testid="fail-reason">
          {match.failReason ?? "알 수 없는 오류"}
        </p>
        <ErrorToast message={error} onDismiss={() => setError(null)} />
        <button
          type="button"
          className={styles.retry}
          data-testid="retry-button"
          disabled={retry.isPending}
          onClick={() =>
            retry.mutate(undefined, {
              onError: (err) =>
                setError(err instanceof Error ? err.message : "재시도에 실패했습니다"),
            })
          }
        >
          {retry.isPending ? "재시도 중…" : "재시도"}
        </button>
      </div>
    );
  }

  const phase = match.state === "GEN1" ? "전반" : "후반";
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className={styles.panel} data-testid="genwait-panel">
      <div className={styles.spinner} aria-hidden="true" />
      <h3 className={styles.title}>AI 감독이 {phase} 작전 반영 중…</h3>
      <p className={styles.elapsed} data-testid="genwait-elapsed">
        경과 {mm}:{ss}
      </p>
      <p className={styles.note}>라이브 모드에서는 팀당 약 70초 × 양팀이 걸릴 수 있습니다</p>
    </div>
  );
}
