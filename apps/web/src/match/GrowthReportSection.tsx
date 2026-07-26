import { useMatchGrowthReport } from "../api/growth-hooks";
import { STAT_LABEL_MAP } from "../growth/growth-config";
import styles from "./ResultPage.module.css";

interface GrowthReportSectionProps {
  matchId: string;
}

/**
 * 매치 후 성장 리포트(§V2-6 S1) — ResultPage 하단. 기용 선수별 스탯 XP 막대 + 레벨업 뱃지 +
 * OVR before→after. entries 가 비었거나 리포트가 없으면(404→null) 섹션 자체를 숨긴다.
 */
export function GrowthReportSection({ matchId }: GrowthReportSectionProps) {
  const { data: report } = useMatchGrowthReport(matchId);
  const entries = report?.entries ?? [];
  if (entries.length === 0) return null;

  return (
    <section className={styles.growthCard} data-testid="growth-report">
      <h3 className={styles.growthTitle}>성장 리포트</h3>
      <ul className={styles.growthList}>
        {entries.map((e) => {
          const statEntries = Object.entries(e.statXp).filter(([, xp]) => xp > 0);
          const totalXp = statEntries.reduce((sum, [, xp]) => sum + xp, 0);
          const maxXp = Math.max(1, ...statEntries.map(([, xp]) => xp));
          return (
            <li key={e.playerId} className={styles.growthRow} data-testid={`growth-entry-${e.playerId}`}>
              <div className={styles.growthMain}>
                <span className={styles.growthName}>{e.name}</span>
                <span className={styles.growthXp} data-testid={`growth-xp-total-${e.playerId}`}>
                  +{totalXp} XP
                </span>
              </div>
              <div className={styles.growthMeta}>
                <span className={styles.growthOvr} data-testid={`growth-ovr-${e.playerId}`}>
                  OVR {Math.round(e.ovrBefore)} → {Math.round(e.ovrAfter)}
                </span>
              </div>
              {statEntries.length > 0 && (
                <div className={styles.growthStatBars} data-testid={`growth-statxp-${e.playerId}`}>
                  {statEntries.map(([stat, xp]) => (
                    <div key={stat} className={styles.growthStatBarRow} data-testid={`growth-statxp-${e.playerId}-${stat}`}>
                      <span className={styles.growthStatLabel}>{STAT_LABEL_MAP[stat] ?? stat}</span>
                      <span className={styles.growthStatBarTrack}>
                        <i className={styles.growthStatBarFill} style={{ width: `${Math.round((xp / maxXp) * 100)}%` }} />
                      </span>
                      <span className={styles.growthStatBarXp}>+{xp}</span>
                    </div>
                  ))}
                </div>
              )}
              {e.levelUps.length > 0 && (
                <div className={styles.growthAttrs} data-testid={`growth-levelup-${e.playerId}`}>
                  {e.levelUps.map((stat) => (
                    <span
                      key={stat}
                      className={styles.growthLevel}
                      data-testid={`growth-levelup-${e.playerId}-${stat}`}
                    >
                      {STAT_LABEL_MAP[stat] ?? stat} Lv up!
                    </span>
                  ))}
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
