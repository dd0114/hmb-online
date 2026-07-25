import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useHalfLog, useMatchResult, type MatchDetail } from "../api/hooks";
import { deriveTeamStats, TEAM_STAT_LABELS, type MatchEventLike } from "./match-logic";
import { MatchViewer } from "./MatchViewer";
import { GrowthReportSection } from "./GrowthReportSection";
import styles from "./ResultPage.module.css";

const RESULT_LABELS: Record<string, string> = {
  WIN: "승리",
  DRAW: "무승부",
  LOSS: "패배",
};

interface ResultPageProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
}

/**
 * FINISHED — 후반 텍스트 재생 + 최종 결과(스코어·승패·보상) + 팀 스탯(양 하프 이벤트 합산,
 * 이벤트만 사용 — tick 계산 없음) + [로비로]. 전적 갱신은 MatchPage가 useMe invalidate.
 */
export function ResultPage({ match, homeName, awayName }: ResultPageProps) {
  const navigate = useNavigate();
  const { data: result } = useMatchResult(match.id);
  const { data: log1 } = useHalfLog(match.id, 1);
  const { data: log2 } = useHalfLog(match.id, 2);

  const stats = useMemo(() => {
    const events = [
      ...(((log1?.events ?? []) as unknown as MatchEventLike[]) ?? []),
      ...(((log2?.events ?? []) as unknown as MatchEventLike[]) ?? []),
    ];
    return deriveTeamStats(events);
  }, [log1, log2]);

  const resultKey = result?.result ?? match.result ?? undefined;
  const scoreHome = result?.scoreHome ?? match.scoreHome;
  const scoreAway = result?.scoreAway ?? match.scoreAway;

  return (
    <div className={styles.page} data-testid="result-page">
      <MatchViewer matchId={match.id} half={2} homeName={homeName} awayName={awayName} />

      <section className={styles.resultCard}>
        {resultKey && (
          <span
            className={[styles.badge, styles[`badge${resultKey}` as keyof typeof styles] ?? ""].join(" ")}
            data-testid="result-badge"
          >
            {RESULT_LABELS[resultKey] ?? resultKey}
          </span>
        )}
        <p className={styles.finalScore} data-testid="final-score">
          {homeName} {scoreHome ?? "-"} : {scoreAway ?? "-"} {awayName}
        </p>
        {result?.pointsAwarded != null && (
          <p className={styles.reward} data-testid="reward-points">
            보상 +{result.pointsAwarded.toLocaleString("ko-KR")} P
          </p>
        )}
      </section>

      <section className={styles.statsCard} data-testid="team-stats">
        <h3 className={styles.statsTitle}>팀 스탯</h3>
        <table className={styles.statsTable}>
          <thead>
            <tr>
              <th className={styles.homeCol}>{homeName}</th>
              <th />
              <th className={styles.awayCol}>{awayName}</th>
            </tr>
          </thead>
          <tbody>
            {TEAM_STAT_LABELS.map(([key, label]) => (
              <tr key={key}>
                <td className={styles.homeCol} data-testid={`stat-home-${key}`}>
                  {stats.home[key]}
                </td>
                <td className={styles.statLabel}>{label}</td>
                <td className={styles.awayCol} data-testid={`stat-away-${key}`}>
                  {stats.away[key]}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <GrowthReportSection matchId={match.id} />

      <button
        type="button"
        className={styles.toLobby}
        data-testid="to-lobby"
        onClick={() => navigate("/lobby")}
      >
        로비로
      </button>
    </div>
  );
}
