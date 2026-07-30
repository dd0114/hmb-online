import type { RankingBoardResponse } from "../api/hooks-p286";
import { myRankLine, rankingView, rankMetric } from "./ranking-logic";
import styles from "./RankingBoard.module.css";

/**
 * 랭킹보드 (#286 W5) — **원정·리그가 같은 컴포넌트를 쓴다**.
 *
 * 두 랭킹의 지표가 다르지만(레이팅+연승 / 승점+경기수) 화면은 하나다. 갈라 두면 한쪽에만
 * 붙은 개선이 다른 쪽에서 조용히 빠진다 — `rankMetric` 이 지표 선택을 소유한다.
 *
 * ⚠️ **데이터가 없으면 아무것도 그리지 않는다.** 이 API 는 아직 서버에 없다(#319 = W4).
 * 그동안 스켈레톤이나 "불러오는 중"을 띄우면 유저는 **앱이 고장 났다**고 읽는다 —
 * 아직 없는 기능은 조용히 없는 편이 정직하다.
 */
export function RankingBoard({
  kind,
  data,
  title,
}: {
  kind: "away" | "league";
  data: RankingBoardResponse | undefined | null;
  title: string;
}) {
  const view = rankingView(data);
  if (!view.usable) return null;

  const meLine = myRankLine(view.me, kind);

  return (
    <section className={styles.card} data-testid={`ranking-${kind}`}>
      <div className={styles.head}>
        <h2 className={styles.title}>{title}</h2>
        {view.seasonNo !== null && (
          <span className={styles.season}>시즌 {view.seasonNo}</span>
        )}
      </div>

      {meLine && (
        <p className={styles.me} data-testid={`ranking-${kind}-me`}>
          내 순위 · {meLine}
        </p>
      )}

      {view.entries.length > 0 && (
        <ol className={styles.list}>
          {view.entries.map((r) => (
            <li
              key={r.userId || `rank-${r.rank}`}
              className={r.isMe ? `${styles.row} ${styles.rowMe}` : styles.row}
              data-testid={r.isMe ? `ranking-${kind}-row-me` : undefined}
            >
              <span className={styles.rank}>{r.rank}</span>
              <span className={styles.name}>{r.nickname}</span>
              {/* 리그는 어느 디비전 사람인지가 승점만큼 중요하다 — 서버가 줄 때만 그린다. */}
              {kind === "league" && r.divisionName && (
                <span className={styles.division}>{r.divisionName}</span>
              )}
              <span className={styles.metric}>{rankMetric(r, kind)}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
