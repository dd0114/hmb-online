import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { useHalfLog, useMatchResult, type MatchDetail } from "../../api/hooks";
import { deriveTeamStats, TEAM_STAT_LABELS, type MatchEventLike } from "../match-logic";
import { GrowthReportSection } from "../GrowthReportSection";
import { Amount } from "../../common/Amount";
import { CURRENCY_POINT } from "../../common/currency";
import type { MatchDailyReward } from "../../api/p3";
import styles from "../ResultPage.module.css";

const RESULT_LABELS: Record<string, string> = {
  WIN: "승리",
  DRAW: "무승부",
  LOSS: "패배",
};

interface ResultPanelProps {
  match: MatchDetail;
  homeName: string;
  awayName: string;
}

/**
 * [D] 결과 패널 — 종료(FINISHED) 상태가 소유하는 시트 탭.
 *
 * 기존 `ResultPage`(무대 아래로 세로로 쌓이던 페이지)를 흡수한 것이다(#169, layout §2.6):
 * 무대는 계속 살아있는 채로 결과를 본다(리서치 R2). 스코어·승패·보상·팀스탯·[로비로]의
 * **testid 는 전부 보존**한다 — 기존 e2e(match-flow·league-season·w3-viewer-smoke)가 참조한다.
 */
export function ResultPanel({ match, homeName, awayName }: ResultPanelProps) {
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
    <div data-testid="result-page">
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
            경기 보상 +<Amount code={CURRENCY_POINT} value={result.pointsAwarded} />
          </p>
        )}
        <DailyRewardLine reward={(result as { dailyReward?: MatchDailyReward | null })?.dailyReward} />
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
        onClick={() => navigate("/home")}
      >
        로비로
      </button>
    </div>
  );
}

/**
 * 그 판이 소비한 **오늘의 보상 칸** (#368). 리그 매치가 아니면 서버가 안 주므로 아무것도 안 그린다.
 *
 * <p>⚠️ **소멸도 보여준다.** 안 보여주면 유저는 칸이 소비된 줄 모르고, 다음 판에서 트랙이 한 칸
 * 앞서 있는 이유를 알 방법이 없다 — 대량 칸을 날린 경우가 특히 그렇다(얼마짜리였는지 말해 주는 것이
 * 규칙을 가르치는 유일한 순간이다).
 *
 * <p>⚠️ `pointsAwarded` 로 대신할 수 없다 — 그건 `reason LIKE 'reward_%'` 합계라 다이아 칸에서는 항상
 * 0이고 재화를 말하지 못한다. 금액과 재화는 항상 같이 온다(#232).
 */
function DailyRewardLine({ reward }: { reward?: MatchDailyReward | null }) {
  if (!reward || typeof reward !== "object" || !Number.isFinite(reward.slotNo)) return null;
  // 트랙을 다 쓴 뒤의 경기 — 칸은 세어지지만 값이 0이다. 줄을 지우면 "보상이 왜 안 들어왔지"가 된다.
  if (!reward.amount) {
    return (
      <p className={styles.reward} data-testid="reward-daily-none">
        오늘의 보상 <span data-testid="reward-daily-exhausted">오늘 칸을 모두 썼습니다</span>
      </p>
    );
  }
  return (
    <p
      className={styles.reward}
      data-testid="reward-daily"
      data-awarded={reward.awarded ? "1" : "0"}
      data-slot={reward.slotNo}
    >
      오늘의 보상 <span className={styles.rewardSlotHint}>{reward.slotNo}번째 칸</span>{" "}
      {reward.awarded ? (
        <>
          +<Amount code={reward.currency} value={reward.amount} />
        </>
      ) : (
        <span className={styles.rewardVanished} data-testid="reward-daily-vanished">
          <Amount code={reward.currency} value={reward.amount} /> 소멸
        </span>
      )}
    </p>
  );
}
