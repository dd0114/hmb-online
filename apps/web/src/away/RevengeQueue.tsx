import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { revengeError, useAwayRevenge, useStartRevengeMatch } from "../api/hooks-p286";
import { ErrorToast } from "../common/ErrorToast";
import { matchInProgressIdOf } from "../common/match-lock";
import { revengeAction, revengeSummary, revengeView } from "./revenge-logic";
import styles from "./RevengeQueue.module.css";

/**
 * 복수 큐 (#286 W5, 설계 §4) — **나를 친 상대에게만, 리포트당 2회.**
 *
 * ⚠️ 이 화면이 여는 것은 V22 가 어뷰징 경로로 지목해 **일부러 닫아 둔 문**이다(§4.1).
 * 그래서 버튼 하나하나가 규칙을 말한다 — 잠긴 이유를 안 보여주면 유저는 "왜 안 되지"에서
 * 멈추고, 규칙이 보이지 않으면 다음 사람이 "편의상" 그 규칙을 지운다.
 *
 * ⚠️ **API 는 아직 서버에 없다**(#319 = W4). 없으면 이 구역은 **통째로 안 그린다** —
 * 스켈레톤이나 에러를 띄우면 유저는 앱이 고장 났다고 읽는다.
 */
export function RevengeQueue() {
  const navigate = useNavigate();
  const { data } = useAwayRevenge();
  const start = useStartRevengeMatch();
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const view = revengeView(data);
  if (!view.usable) return null;

  function press(reportId: string) {
    setError(null);
    setPendingId(reportId);
    start.mutate(reportId, {
      onSuccess: (match) => navigate(`/match/${match.id}`),
      onError: (err) => {
        // #217 규약 — 409 는 실패가 아니라 이어가라는 안내다.
        const resumeId = matchInProgressIdOf(err);
        if (resumeId) {
          navigate(`/match/${resumeId}`);
          return;
        }
        setError(revengeError(err));
      },
      onSettled: () => setPendingId(null),
    });
  }

  return (
    <section className={styles.card} data-testid="revenge-queue">
      <div className={styles.head}>
        <h2 className={styles.title}>⚔️ 복수 목록</h2>
        {/* 남은 횟수는 **원정과 공유**다 — 여기 따로 세면 "복수로 무한 재도전"이 열린다. */}
        {view.remainingToday !== null && (
          <span className={styles.remaining} data-testid="revenge-remaining">
            오늘 {view.remainingToday}회 남음
          </span>
        )}
      </div>
      <p className={styles.hint}>나를 침공한 상대에게만, 상대당 2회까지 되갚을 수 있습니다.</p>

      <ul className={styles.list}>
        {view.entries.map((e) => {
          const act = revengeAction(e, view.remainingToday);
          return (
            <li key={e.reportId} className={styles.row} data-testid="revenge-row">
              <div className={styles.info}>
                <b className={styles.name}>{e.opponent.nickname}</b>
                <span className={styles.summary} data-testid="revenge-summary">
                  {revengeSummary(e)}
                </span>
              </div>
              <div className={styles.actionCol}>
                <button
                  type="button"
                  className={styles.action}
                  data-testid="revenge-start"
                  disabled={!act.can || pendingId === e.reportId}
                  onClick={() => press(e.reportId)}
                >
                  {pendingId === e.reportId ? "준비 중…" : act.label}
                </button>
                {/* 잠긴 이유를 말한다 — 비활성 버튼만 두면 유저는 이유를 못 찾는다. */}
                {act.reason && (
                  <span className={styles.reason} data-testid="revenge-reason">
                    {act.reason}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>

      <ErrorToast message={error} onDismiss={() => setError(null)} />
    </section>
  );
}
