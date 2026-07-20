import {
  conditionColor,
  conditionHandTip,
  conditionLabel,
  conditionRingDash,
  conditionTier,
} from "./condition-clock";

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
 *
 * 색각 대응(#106 R3b B): 등급이 **색으로만** 갈리지 않게 색과 독립인 축을 함께 그린다 —
 * 바늘 각도(12시/3시/6시) + 링 파선 패턴(실선/파선/점선). `data-condition-tier` 로 노출해
 * E2E 가 "축이 실제로 다르다"를 검증한다. 텍스트 축은 공간이 있는 소비처(리스트 행·레일 헤드)가
 * 자기 자리에서 덧붙인다.
 */
export function ConditionClock({ value, size = 28, showLabel = false, testId }: ConditionClockProps) {
  const cx = 50;
  const cy = 50;
  const r = 38;
  const tip = conditionHandTip(value, cx, cy, r - 6);
  const color = conditionColor(value);
  const dash = conditionRingDash(value);
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);

  return (
    <span
      style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
      data-testid={testId}
      data-condition={value.toFixed(2)}
      data-condition-tier={conditionTier(value)}
      title={`컨디션 ${pct}% (${conditionLabel(value)})`}
    >
      <svg
        width={size}
        height={size}
        viewBox="0 0 100 100"
        role="img"
        aria-label={`컨디션 ${pct}% ${conditionLabel(value)}`}
      >
        {/* 링 파선 = 색과 독립인 등급 축(실선 최상 / 파선 보통 / 점선 저조). */}
        <circle
          cx={cx}
          cy={cy}
          r={r}
          fill="#11141a"
          stroke={color}
          strokeWidth={4}
          strokeDasharray={dash}
        />
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
