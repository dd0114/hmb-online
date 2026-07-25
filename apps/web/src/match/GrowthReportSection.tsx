import { useMatchGrowthReport } from "../api/growth-hooks";
import styles from "./ResultPage.module.css";

interface GrowthReportSectionProps {
  matchId: string;
}

/**
 * 매치 후 성장 리포트(S1) — ResultPage 하단. 기용 선수별 +xp·OVR before→after·레벨업 뱃지·topAttrs.
 * entries 가 비었거나 리포트가 없으면(404→null) 섹션 자체를 숨긴다.
 */
export function GrowthReportSection({ matchId }: GrowthReportSectionProps) {
  const { data: report } = useMatchGrowthReport(matchId);
  const entries = report?.entries ?? [];
  if (entries.length === 0) return null;

  return (
    <section className={styles.growthCard} data-testid="growth-report">
      <h3 className={styles.growthTitle}>성장 리포트</h3>
      <ul className={styles.growthList}>
        {entries.map((e) => (
          <li key={e.playerId} className={styles.growthRow} data-testid={`growth-entry-${e.playerId}`}>
            <div className={styles.growthMain}>
              <span className={styles.growthName}>{e.name}</span>
              {e.leveledUp && (
                <span className={styles.growthLevel} data-testid={`growth-levelup-${e.playerId}`}>
                  LEVEL UP
                </span>
              )}
            </div>
            <div className={styles.growthMeta}>
              <span className={styles.growthXp} data-testid={`growth-xp-${e.playerId}`}>
                +{e.xpDelta} XP
              </span>
              <span className={styles.growthOvr} data-testid={`growth-ovr-${e.playerId}`}>
                OVR {Math.round(e.ovrBefore)} → {Math.round(e.ovrAfter)}
              </span>
            </div>
            {e.topAttrs.length > 0 && (
              <div className={styles.growthAttrs}>
                {e.topAttrs.map((a) => (
                  <span key={a} className={styles.growthAttrTag}>
                    {a}
                  </span>
                ))}
              </div>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
