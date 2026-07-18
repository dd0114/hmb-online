/**
 * Team power (AC-B5): sum of the 11 starters' overall ratings (condition-agnostic base).
 * Player overall = mean of the 9 shared PlayerAttributes (each 0..100). The opponent roster
 * from the match briefing only exposes {grade} (no attributes), so opponent power is a
 * grade-based approximation using empirical per-grade mean overalls (data/players.v2.1.json).
 */
import type { components } from "../api/schema";

type PlayerAttributes = components["schemas"]["PlayerAttributes"];
type Grade = components["schemas"]["Grade"];

/** Mean overall per grade — measured over the 172-player pool (data v2.1). Approximation. */
export const GRADE_OVERALL: Record<Grade, number> = {
  BRONZE: 50,
  SILVER: 60,
  GOLD: 69,
  DIA: 80,
  LEGEND: 90,
};

export function playerOverall(attrs: PlayerAttributes): number {
  const vals = Object.values(attrs);
  if (vals.length === 0) return 0;
  const sum = vals.reduce((a, b) => a + b, 0);
  return sum / vals.length;
}

/** Sum of overalls for the given starter attribute list (round to int for display). */
export function teamPower(starterAttrs: PlayerAttributes[]): number {
  return Math.round(starterAttrs.reduce((acc, a) => acc + playerOverall(a), 0));
}

/** Grade-based approximation of an opponent starting XI's power (11 grades in). */
export function opponentPowerFromGrades(grades: Grade[]): number {
  return Math.round(grades.reduce((acc, g) => acc + GRADE_OVERALL[g], 0));
}

/**
 * Comparison gauge fill for the home team (0..1) given both powers. 0.5 = even.
 * Clamped so a blowout still renders a visible sliver on each side.
 */
export function powerShare(home: number, away: number): number {
  const total = home + away;
  if (total <= 0) return 0.5;
  return Math.max(0.05, Math.min(0.95, home / total));
}
