import { conditionColor, conditionHandTip, conditionLabel } from "./condition-clock";

interface ConditionClockProps {
  /** 0.0..1.0 seed-deterministic condition (AC-C1). */
  value: number;
  size?: number;
  showLabel?: boolean;
  testId?: string;
}

/**
 * Condition clock (AC-C1 / LLD §3): 12 o'clock = best, 6 o'clock = worst. A colored hand
 * points along the sweep and the dial fills traffic-light color by tier. Pure SVG, no deps.
 */
export function ConditionClock({ value, size = 28, showLabel = false, testId }: ConditionClockProps) {
  const cx = 50;
  const cy = 50;
  const r = 38;
  const tip = conditionHandTip(value, cx, cy, r - 6);
  const color = conditionColor(value);
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      data-testid={testId}
      data-condition={value.toFixed(2)}
      title={`컨디션 ${pct}% (${conditionLabel(value)})`}
    >
      <svg width={size} height={size} viewBox="0 0 100 100" role="img" aria-label={`컨디션 ${pct}%`}>
        <circle cx={cx} cy={cy} r={r} fill="#11141a" stroke={color} strokeWidth={4} />
        {/* 12 o'clock tick (best marker) */}
        <line x1={cx} y1={cy - r + 2} x2={cx} y2={cy - r + 9} stroke="#5f6a7a" strokeWidth={3} />
        {/* 6 o'clock tick (worst marker) */}
        <line x1={cx} y1={cy + r - 9} x2={cx} y2={cy + r - 2} stroke="#5f6a7a" strokeWidth={3} />
        <line x1={cx} y1={cy} x2={tip.x} y2={tip.y} stroke={color} strokeWidth={5} strokeLinecap="round" />
        <circle cx={cx} cy={cy} r={5} fill={color} />
      </svg>
      {showLabel && (
        <span style={{ fontSize: 12, color }}>
          {pct}% · {conditionLabel(value)}
        </span>
      )}
    </span>
  );
}
