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
  /**
   * 열 이름 — **사이드 순서**(왼쪽 = home). #322 후속.
   *
   * 이 표는 `[왼쪽 값] [항목] [오른쪽 값]` 좌우 대칭이라 원래 이름이 없었다. 홈이 **항상** 유저였던
   * 시절엔 "왼쪽 = 나"가 학습된 위치라 읽혔지만, #322 로 표시가 픽스처 사이드를 따르게 되면서
   * **어웨이 라운드에는 왼쪽이 봇**이다 — 그 전제가 깨졌다. 같은 화면의 결과 탭은 이미 팀명 헤더를
   * 갖고 있었으니 비대칭이 그 자체로 신호였다.
   */
  homeName: string;
  awayName: string;
  /** 내 팀 사이드(#322 안 C). 모르면 null — 거짓 표식을 달지 않는다. */
  myTeamSide?: "home" | "away" | null;
}

/**
 * 통계 열의 내 팀 표식(#322 후속). 스코어바 칩과 **같은 모양·같은 문구·같은 자리 규칙** —
 * 두 줄이 다르게 생기거나 다른 규칙으로 놓이면 유저가 둘을 다른 뜻으로 읽는다.
 *
 * ⚠️ **규칙 = 항상 자기 이름 바로 뒤**(양쪽 다). 처음엔 어웨이 쪽만 이름 앞에 뒀는데(안쪽 정렬이
 * 대칭이라 생각해서), 실화면을 보니 칩이 두 이름 **가운데**에 떨어져 어느 팀 것인지 모호했다.
 * "자기 이름 뒤"는 한 문장으로 설명되고 스코어바가 이미 그렇게 가르치고 있다.
 *
 * ⚠️ 이름 슬롯의 줄임표에 태우지 마라 — 스코어바에서 정확히 그 사고가 났다(칩이 잘렸는데 DOM 엔
 * 있어 `toBeVisible()` 이 통과). 여기도 슬롯이 플렉스고 **이름만** 줄어든다.
 */
function StatsMyTeamTag({ side }: { side: "home" | "away" }) {
  return (
    <span className={styles.myTeamTag} data-testid="stats-my-team" data-side={side} aria-label="내 팀">
      내 팀
    </span>
  );
}

/**
 * [D] 실시간 통계 — 표가 아니라 **좌/우 대칭 막대**(리서치 R5, research §2.3).
 * 계산은 `@hmb/viewer-core`(= dev-viewer 의 검증된 순수 stats 모듈)에 위임한다 — 재구현 0.
 */
export function StatsPanel({
  matchId,
  half,
  tick,
  homeName,
  awayName,
  myTeamSide = null,
}: StatsPanelProps) {
  const { data: log, isLoading, isError } = useHalfLog(matchId, half);

  const view = useMemo(() => {
    if (!log) return null;
    const events = ((log.events ?? []) as unknown as LogEvent[]) ?? [];
    const snaps =
      ((log.tickSnapshots ?? []) as unknown as {
        tick: number;
        ballOwner?: string | null;
      }[]) ?? [];
    const upto = tick ?? 0;
    const stats = liveEventStats(events, upto);
    const { cumHome, cumAway } = computeCumulativePossession(snaps);
    const poss = possessionPct(
      cumHome,
      cumAway,
      snapshotIndexOfTick(snaps, upto),
    );
    return { stats, poss };
  }, [log, tick]);

  if (isLoading) return <p className={styles.note}>통계 불러오는 중…</p>;
  if (isError || !view)
    return <p className={styles.note}>통계를 불러오지 못했습니다</p>;

  const { stats, poss } = view;

  return (
    <div className={styles.statsBody} data-testid="stage-panel-stats">
      {/*
        열이 누구인지 말하는 한 줄(#322 후속). 순서·색은 **스코어바와 같다** — 두 줄이 서로 다른 팀을
        왼쪽이라 하면 없는 것만 못하다. 표식은 스코어바에서 배운 것을 여기서 다시 찾지 않게 한다.
      */}
      <div className={styles.teamRow}>
        <span className={`${styles.teamSlot} ${styles.home}`}>
          <span className={styles.teamName} data-testid="stats-team-home">
            {homeName}
          </span>
          {myTeamSide === "home" && <StatsMyTeamTag side="home" />}
        </span>
        <span className={`${styles.teamSlot} ${styles.away}`}>
          <span className={styles.teamName} data-testid="stats-team-away">
            {awayName}
          </span>
          {myTeamSide === "away" && <StatsMyTeamTag side="away" />}
        </span>
      </div>

      <div className={styles.possRow}>
        <span
          className={`${styles.possVal} ${styles.home}`}
          data-testid="stat-possession-home"
        >
          {poss}%
        </span>
        <div className={styles.bar}>
          <i className={styles.barHome} style={{ width: `${poss}%` }} />
          <b className={styles.barAway} style={{ width: `${100 - poss}%` }} />
        </div>
        <span className={`${styles.possVal} ${styles.away}`}>
          {100 - poss}%
        </span>
      </div>
      <p className={styles.possCaption}>점유율</p>

      <div className={styles.statsGrid}>
        {statRows(stats.home, stats.away).map((r) => {
          const hp = share(r.hv, r.av);
          return (
            <div className={styles.statRow} key={r.key}>
              <span
                className={`${styles.statVal} ${styles.home}`}
                data-testid={`stage-stat-home-${r.key}`}
              >
                {r.home}
              </span>
              <span className={styles.statLabel}>{r.label}</span>
              <span
                className={`${styles.statVal} ${styles.away}`}
                data-testid={`stage-stat-away-${r.key}`}
              >
                {r.away}
              </span>
              <div className={styles.bar}>
                <i className={styles.barHome} style={{ width: `${hp}%` }} />
                <b
                  className={styles.barAway}
                  style={{ width: `${100 - hp}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
