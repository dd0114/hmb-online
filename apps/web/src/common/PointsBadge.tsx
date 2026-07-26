import styles from "./PointsBadge.module.css";

interface PointsBadgeProps {
  points: number;
  /**
   * V2.2 재화 이원화(에픽 #179 hero 확정) — 지갑 P·젬 병기. 넘기지 않으면 기존 단독 P 배지와
   * 동일(트레이드 슬롯 단축비용 등 "비용 표기" 호출부는 gems 를 넘기지 않는다).
   */
  gems?: number;
}

export function PointsBadge({ points, gems }: PointsBadgeProps) {
  return (
    <span className={styles.wrap}>
      <span className={styles.badge} data-testid="points-badge" data-points={points}>
        <span className={styles.icon} aria-hidden="true">
          ●
        </span>
        {points.toLocaleString("ko-KR")} P
      </span>
      {gems !== undefined && (
        <span className={styles.badge} data-testid="wallet-gems" data-gems={gems}>
          <span className={styles.gemIcon} aria-hidden="true">
            💎
          </span>
          {gems.toLocaleString("ko-KR")}
        </span>
      )}
    </span>
  );
}
