import { powerShare } from "./team-power";
import styles from "./TeamPowerBar.module.css";

interface TeamPowerBarProps {
  /** my starting XI power (sum of overalls, AC-B5). */
  power: number;
  /** how many starters are counted (context: 11 = full). */
  starterCount: number;
  /** opponent power for the comparison gauge (briefing only). */
  opponentPower?: number;
  opponentName?: string;
  /** note on how opponent power was derived (grade approximation). */
  opponentApprox?: boolean;
}

/**
 * Team power bar (AC-B5). Always shows my starters' summed overall. In briefing, an opponent
 * power is supplied → renders a two-sided comparison gauge (my share vs opponent).
 */
export function TeamPowerBar({ power, starterCount, opponentPower, opponentName, opponentApprox }: TeamPowerBarProps) {
  const hasCompare = opponentPower != null;
  const share = hasCompare ? powerShare(power, opponentPower!) : 1;

  return (
    <section className={styles.bar} data-testid="team-power-bar">
      <div className={styles.headerRow}>
        <span className={styles.label}>팀 파워</span>
        <span className={styles.value} data-testid="team-power-value">
          {power}
        </span>
        <span className={styles.sub}>선발 {starterCount}명 합산</span>
      </div>

      {hasCompare && (
        <div className={styles.compare} data-testid="power-compare">
          <div className={styles.gauge}>
            <div className={styles.mine} style={{ width: `${share * 100}%` }} />
            <div className={styles.theirs} style={{ width: `${(1 - share) * 100}%` }} />
          </div>
          <div className={styles.compareLabels}>
            <span className={styles.mineLabel}>
              나 {power}
            </span>
            <span className={styles.theirsLabel} data-testid="opponent-power-value">
              {opponentName ?? "상대"} {opponentPower}
            </span>
          </div>
          {opponentApprox && (
            <p className={styles.approxNote}>* 상대 파워는 보유 선수 등급 기반 근사값</p>
          )}
        </div>
      )}
    </section>
  );
}
