import { useEffect, useMemo, useRef, useState } from "react";
import { useHalfLog } from "../api/hooks";
import {
  eventDisplay,
  formatClock,
  keyEvents,
  revealInterval,
  runningScore,
  type MatchEventLike,
} from "./match-logic";
import styles from "./MatchViewer.module.css";

interface MatchViewerProps {
  matchId: string;
  half: 1 | 2;
  homeName: string;
  awayName: string;
}

/**
 * R1 전 임시 뷰어 (LLD-web §3) — 텍스트 타임라인만. 캔버스 재생 자체 구현 금지(#57);
 * 시각 피치 재생은 W3에서 QA 뷰어 번들 소비로 대체된다.
 * '재생' = 키 이벤트를 ~30초로 압축해 순차 공개(스코어보드 동기), 스킵 버튼 제공.
 */
export function MatchViewer({ matchId, half, homeName, awayName }: MatchViewerProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);

  const events = useMemo(
    () => keyEvents(((log?.events ?? []) as unknown as MatchEventLike[]) ?? []),
    [log],
  );
  const [revealed, setRevealed] = useState(0);
  const [playing, setPlaying] = useState(true);
  const listRef = useRef<HTMLOListElement>(null);

  const done = revealed >= events.length;

  useEffect(() => {
    if (!playing || done || events.length === 0) return;
    const timer = window.setInterval(
      () => setRevealed((n) => Math.min(events.length, n + 1)),
      revealInterval(events.length),
    );
    return () => window.clearInterval(timer);
  }, [playing, done, events.length]);

  // auto-scroll to the newest revealed event
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [revealed]);

  if (isLoading) {
    return <p className={styles.note}>경기 기록 불러오는 중…</p>;
  }
  if (isError || !log) {
    return <p className={styles.note}>경기 기록을 불러오지 못했습니다</p>;
  }

  const score = done
    ? ((log.finalScore ?? runningScore(events, revealed)) as { home?: number; away?: number })
    : runningScore(events, revealed);

  return (
    <section className={styles.viewer} data-testid={`match-viewer-half${half}`}>
      <div className={styles.scoreboard}>
        <span className={styles.team}>{homeName}</span>
        <span className={styles.score} data-testid={`viewer-score-half${half}`}>
          {score.home ?? 0} : {score.away ?? 0}
        </span>
        <span className={styles.team}>{awayName}</span>
      </div>
      <p className={styles.halfLabel}>{half === 1 ? "전반" : "후반"} 텍스트 하이라이트</p>

      <ol className={styles.timeline} ref={listRef} data-testid={`viewer-timeline-half${half}`}>
        {events.slice(0, revealed).map((e, i) => {
          const d = eventDisplay(e);
          return (
            <li key={`${e.tick}-${i}`} className={e.type === "goal" ? styles.goalRow : styles.row}>
              <span className={styles.clock}>{formatClock(e.tick, half)}</span>
              <span className={styles.icon} aria-hidden="true">
                {d.icon}
              </span>
              <span className={styles.label}>
                {d.label}
                {e.team && <span className={styles.side}>{e.team === "home" ? homeName : awayName}</span>}
              </span>
            </li>
          );
        })}
        {revealed === 0 && <li className={styles.note}>재생 대기 중…</li>}
      </ol>

      <div className={styles.controls}>
        {!done ? (
          <>
            <button
              type="button"
              className={styles.control}
              data-testid={`viewer-playpause-half${half}`}
              onClick={() => setPlaying((p) => !p)}
            >
              {playing ? "일시정지" : "재생"}
            </button>
            <button
              type="button"
              className={styles.control}
              data-testid={`viewer-skip-half${half}`}
              onClick={() => {
                setRevealed(events.length);
                setPlaying(false);
              }}
            >
              끝까지 보기
            </button>
          </>
        ) : (
          <span className={styles.doneNote} data-testid={`viewer-done-half${half}`}>
            {half === 1 ? "전반 종료" : "경기 종료"} — 이벤트 {events.length}건
          </span>
        )}
      </div>
    </section>
  );
}
