import styles from "./PointsBadge.module.css";

interface PointsBadgeProps {
  points: number;
}

export function PointsBadge({ points }: PointsBadgeProps) {
  return (
    <span className={styles.badge} data-testid="points-badge" data-points={points}>
      <span className={styles.icon} aria-hidden="true">
        ●
      </span>
      {points.toLocaleString("ko-KR")} P
    </span>
  );
}
