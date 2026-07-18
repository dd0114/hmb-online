/**
 * Condition clock geometry (AC-C1 / LLD §3): a player's seed-deterministic condition
 * (0.0..1.0) rendered as a clock hand. 12 o'clock (up) = best (1.0), 6 o'clock (down) =
 * worst (0.0). The hand sweeps monotonically down the right side as condition drops.
 */

/**
 * Needle rotation in degrees, where 0° points up (12 o'clock) and rotation is clockwise.
 *   value 1.0 → 0°   (12 o'clock, best)
 *   value 0.5 → 90°  (3 o'clock)
 *   value 0.0 → 180° (6 o'clock, worst)
 */
export function conditionAngle(value: number): number {
  const v = Math.max(0, Math.min(1, value));
  return (1 - v) * 180;
}

/** Tip coordinate on a unit circle (cx,cy center, r radius) for the given condition. */
export function conditionHandTip(
  value: number,
  cx: number,
  cy: number,
  r: number,
): { x: number; y: number } {
  const angleDeg = conditionAngle(value);
  const rad = (angleDeg * Math.PI) / 180;
  // 0° = up (negative y in SVG), clockwise positive
  return { x: cx + r * Math.sin(rad), y: cy - r * Math.cos(rad) };
}

export type ConditionTier = "high" | "mid" | "low";

export function conditionTier(value: number): ConditionTier {
  if (value >= 0.66) return "high";
  if (value >= 0.33) return "mid";
  return "low";
}

/** Traffic-light color by tier (green best → red worst). */
export function conditionColor(value: number): string {
  switch (conditionTier(value)) {
    case "high":
      return "#3ec46d";
    case "mid":
      return "#f2c744";
    default:
      return "#e5533c";
  }
}

/** Short label for accessibility / tooltip. */
export function conditionLabel(value: number): string {
  switch (conditionTier(value)) {
    case "high":
      return "최상";
    case "mid":
      return "보통";
    default:
      return "저조";
  }
}
