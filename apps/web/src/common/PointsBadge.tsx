import styles from "./PointsBadge.module.css";

interface PointsBadgeProps {
  points: number;
}

export function PointsBadge({ points }: PointsBadgeProps) {
  return (
    <span className={styles.badge}>
      <span className={styles.icon} aria-hidden="true">
        ●
      </span>
      {points.toLocaleString("ko-KR")} P
    </span>
  );
}
