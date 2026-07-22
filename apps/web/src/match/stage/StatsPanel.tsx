import { useMemo } from "react";
import {
  computeCumulativePossession,
  liveEventStats,
  possessionPct,
  snapshotIndexOfTick,
  type LogEvent,
} from "@hmb/viewer-core";
import { useHalfLog } from "../../api/hooks";
import { share, statRows } from "./stats-rows";
import styles from "./panels.module.css";

interface StatsPanelProps {
  matchId: string;
  half: 1 | 2;
  /** 재생 플레이헤드. null 이면 아직 뷰어가 준비 전 → 0 틱 기준(빈 스탯). */
  tick: number | null;
}

/**
 * [D] 실시간 통계 — 표가 아니라 **좌/우 대칭 막대**(리서치 R5, research §2.3).
 * 계산은 `@hmb/viewer-core`(= dev-viewer 의 검증된 순수 stats 모듈)에 위임한다 — 재구현 0.
 */
export function StatsPanel({ matchId, half, tick }: StatsPanelProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);

  const view = useMemo(() => {
    if (!log) return null;
    const events = ((log.events ?? []) as unknown as LogEvent[]) ?? [];
    const snaps = ((log.tickSnapshots ?? []) as unknown as { tick: number; ballOwner?: string | null }[]) ?? [];
    const upto = tick ?? 0;
    const stats = liveEventStats(events, upto);
    const { cumHome, cumAway } = computeCumulativePossession(snaps);
    const poss = possessionPct(cumHome, cumAway, snapshotIndexOfTick(snaps, upto));
    return { stats, poss };
  }, [log, tick]);

  if (isLoading) return <p className={styles.note}>통계 불러오는 중…</p>;
  if (isError || !view) return <p className={styles.note}>통계를 불러오지 못했습니다</p>;

  const { stats, poss } = view;

  return (
    <div data-testid="stage-panel-stats">
      <div className={styles.possRow}>
        <span className={`${styles.possVal} ${styles.home}`} data-testid="stat-possession-home">
          {poss}%
        </span>
        <div className={styles.bar}>
          <i className={styles.barHome} style={{ width: `${poss}%` }} />
          <b className={styles.barAway} style={{ width: `${100 - poss}%` }} />
        </div>
        <span className={`${styles.possVal} ${styles.away}`}>{100 - poss}%</span>
      </div>
      <p className={styles.possCaption}>점유율</p>

      {statRows(stats.home, stats.away).map((r) => {
        const hp = share(r.hv, r.av);
        return (
          <div className={styles.statRow} key={r.key}>
            <span className={`${styles.statVal} ${styles.home}`} data-testid={`stage-stat-home-${r.key}`}>
              {r.home}
            </span>
            <span className={styles.statLabel}>{r.label}</span>
            <span className={`${styles.statVal} ${styles.away}`} data-testid={`stage-stat-away-${r.key}`}>
              {r.away}
            </span>
            <div className={styles.bar}>
              <i className={styles.barHome} style={{ width: `${hp}%` }} />
              <b className={styles.barAway} style={{ width: `${100 - hp}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
