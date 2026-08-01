import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { useAbandonMatch, useActiveMatch, useRetry, type MatchDetail } from "../api/hooks";
import { ErrorToast } from "../common/ErrorToast";
import { genWaitCopy } from "./match-logic";
import { waitingSceneAt } from "./waiting-scenes";
import styles from "./GenWaitPanel.module.css";

interface GenWaitPanelProps {
  match: MatchDetail;
}

/** GEN1/GEN2 대기 (스피너+단계 문구+경과 시간, AC-W4) + FAILED(사유+재시도, AC-M7). */
export function GenWaitPanel({ match }: GenWaitPanelProps) {
  const retry = useRetry(match.id);
  // #217 AC3: 재시도해도 안 되는 매치는 포기할 수 있어야 한다 — 그렇지 않으면 이 화면이 곧
  // 계정 잠금이다(새 매치 생성이 409 로 막힌 채 나갈 길이 없다).
  const abandon = useAbandonMatch(match.id);
  const navigate = useNavigate();
  // 생성이 오래 멈추면(잡은 done 인데 전이가 커밋 안 된 사고 — 독립검증 MAJOR-1) 서버가
  // abandonable 을 연다. 그때는 스피너 화면에서도 바로 빠져나갈 수 있어야 한다 —
  // 로비까지 가야만 탈출할 수 있으면 "멈춘 화면에 갇혔다"는 체감은 그대로다.
  const { data: active } = useActiveMatch();
  const canAbandon = Boolean(active?.abandonable) && active?.match?.id === match.id;
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
        <button
          type="button"
          className={styles.abandon}
          data-testid="abandon-button"
          disabled={abandon.isPending}
          onClick={() =>
            abandon.mutate(undefined, {
              onSuccess: () => navigate("/home"),
              onError: (err) =>
                setError(err instanceof Error ? err.message : "포기하지 못했습니다"),
            })
          }
        >
          {abandon.isPending ? "포기하는 중…" : "경기 포기"}
        </button>
      </div>
    );
  }

  // 문구는 순수 로직이 SoT — 제목은 match-logic.genWaitCopy, 서술은 waiting-scenes 정경 풀(#382).
  const copy = genWaitCopy(match.state);
  // 경과 초에서 파생한다 — 별도 타이머를 두면 화면의 시계와 문구가 어긋난다.
  const scene = waitingSceneAt(elapsed);
  const mm = Math.floor(elapsed / 60);
  const ss = String(elapsed % 60).padStart(2, "0");

  return (
    <div className={styles.panel} data-testid="genwait-panel">
      <div className={styles.spinner} aria-hidden="true" />
      <h3 className={styles.title}>{copy.title}</h3>
      <p className={styles.elapsed} data-testid="genwait-elapsed">
        경과 {mm}:{ss}
      </p>
      {/*
        key={scene} 로 문장이 갈릴 때마다 페이드가 다시 돈다 — 글자만 순간 교체되면 "바뀐 줄"
        모르고 지나간다. 읽는 중 갈리는 감각을 줄이려는 것이지 장식이 아니다.
        ⚠️ aria-live 는 걸지 않는다 — 4초마다 스크린리더가 정경을 낭독하면 소음이다(경과 시계와
        [경기 포기]가 이 화면의 기능 정보다).
      */}
      <p key={scene} className={styles.scene} data-testid="genwait-scene">
        {scene}
      </p>
      {canAbandon && (
        <button
          type="button"
          className={styles.abandon}
          data-testid="genwait-abandon"
          disabled={abandon.isPending}
          onClick={() =>
            abandon.mutate(undefined, {
              onSuccess: () => navigate("/home"),
              onError: (err) =>
                setError(err instanceof Error ? err.message : "포기하지 못했습니다"),
            })
          }
        >
          {abandon.isPending ? "포기하는 중…" : "경기 포기"}
        </button>
      )}
      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </div>
  );
}
