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

/**
 * ── 색각 대응: 등급을 **색 말고도** 읽을 수 있게 (#106 R3b B) ──────────────────────────────
 *
 * 컨디션 3단계는 신호등 색(초/노/빨)으로만 갈렸다 — 적록색약이면 최상/저조가 같은 톤으로 보인다.
 * 색과 **독립**인 축을 두 개 더 얹는다(하나만 두면 축소 렌더에서 사라진다):
 *   ① 바늘 각도 — 12시(최상) → 3시(보통) → 6시(저조). 이미 있던 축(conditionAngle).
 *   ② 링 파선 패턴 — 최상=실선 / 보통=파선 / 저조=점선. 14px 토큰에서도 형태로 구분된다.
 *   ③ (공간이 있는 곳) 텍스트 — `conditionLabel` + 퍼센트. 리스트 행·레일 헤드가 쓴다.
 * 색은 넷째 축으로 남긴다(정상 색각에는 여전히 가장 빠른 단서).
 */
export function conditionRingDash(value: number): string | undefined {
  switch (conditionTier(value)) {
    case "high":
      return undefined; // 실선
    case "mid":
      return "14 7"; // 파선
    default:
      return "3 6"; // 점선
  }
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
