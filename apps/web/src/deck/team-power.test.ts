import { describe, expect, it } from "vitest";
import { GRADE_OVERALL, opponentPowerFromGrades, playerOverall, powerShare, teamPower } from "./team-power";
import type { components } from "../api/schema";

type PlayerAttributes = components["schemas"]["PlayerAttributes"];

function attrs(v: number): PlayerAttributes {
  return {
    technical: v,
    mental: v,
    physical: v,
    passing: v,
    shooting: v,
    tackling: v,
    pace: v,
    stamina: v,
    positioning: v,
  };
}

describe("playerOverall", () => {
  it("is the mean of the 9 attributes", () => {
    expect(playerOverall(attrs(70))).toBe(70);
  });
});

describe("teamPower", () => {
  it("sums starter overalls", () => {
    expect(teamPower([attrs(70), attrs(80)])).toBe(150);
  });

  it("rounds to an integer", () => {
    expect(teamPower([attrs(70.4), attrs(70.4)])).toBe(141);
  });
});

describe("opponentPowerFromGrades", () => {
  it("approximates from per-grade mean overalls", () => {
    expect(opponentPowerFromGrades(["LEGEND", "BRONZE"])).toBe(
      GRADE_OVERALL.LEGEND + GRADE_OVERALL.BRONZE,
    );
  });
});

describe("powerShare", () => {
  it("returns 0.5 when even", () => {
    expect(powerShare(100, 100)).toBe(0.5);
  });

  it("favors the stronger side but stays clamped in [0.05, 0.95]", () => {
    expect(powerShare(900, 100)).toBeCloseTo(0.9, 5);
    expect(powerShare(1000, 0)).toBe(0.95);
    expect(powerShare(0, 1000)).toBe(0.05);
  });

  it("handles zero totals gracefully", () => {
    expect(powerShare(0, 0)).toBe(0.5);
  });
});
