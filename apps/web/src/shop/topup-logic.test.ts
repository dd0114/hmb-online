import { describe, expect, it } from "vitest";
import {
  TOPUP_PACKAGES,
  bestValuePackageId,
  bonusPercent,
  findPackage,
  formatKrw,
  formatPoints,
  pointsPerKrw,
  totalPoints,
  type TopupPackage,
} from "./topup-logic";

const pkg = (over: Partial<TopupPackage> = {}): TopupPackage => ({
  id: "x",
  productId: "mock.x",
  label: "X",
  basePoints: 1_000,
  bonusPoints: 0,
  priceKrw: 1_000,
  ...over,
});

describe("topup catalog", () => {
  it("exposes the four mock packages totalling 1,000 / 5,500 / 12,000 / 30,000 P", () => {
    expect(TOPUP_PACKAGES.map(totalPoints)).toEqual([1_000, 5_500, 12_000, 30_000]);
  });

  it("keeps package ids unique and non-empty (testid stability)", () => {
    const ids = TOPUP_PACKAGES.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.every((id) => id.length > 0)).toBe(true);
  });

  it("prices every package with a positive mock price", () => {
    expect(TOPUP_PACKAGES.every((p) => p.priceKrw > 0)).toBe(true);
  });
});

describe("totalPoints / bonusPercent", () => {
  it("adds the bonus onto the base", () => {
    expect(totalPoints(pkg({ basePoints: 25_000, bonusPoints: 5_000 }))).toBe(30_000);
  });

  it("computes the bonus rate against the base points", () => {
    expect(bonusPercent(pkg({ basePoints: 10_000, bonusPoints: 2_000 }))).toBe(20);
    expect(bonusPercent(pkg({ basePoints: 5_000, bonusPoints: 500 }))).toBe(10);
  });

  it("reports 0% for a package with no bonus", () => {
    expect(bonusPercent(pkg({ bonusPoints: 0 }))).toBe(0);
  });

  it("rounds fractional bonus rates", () => {
    expect(bonusPercent(pkg({ basePoints: 3_000, bonusPoints: 100 }))).toBe(3); // 3.33% → 3
  });

  it("guards against a zero base instead of dividing by zero", () => {
    expect(bonusPercent(pkg({ basePoints: 0, bonusPoints: 500 }))).toBe(0);
  });
});

describe("pointsPerKrw / bestValuePackageId", () => {
  it("measures value as points per won", () => {
    expect(pointsPerKrw(pkg({ basePoints: 1_000, bonusPoints: 0, priceKrw: 1_000 }))).toBe(1);
    expect(pointsPerKrw(pkg({ basePoints: 5_000, bonusPoints: 500, priceKrw: 5_500 }))).toBe(1);
  });

  it("returns 0 rather than Infinity for a zero price", () => {
    expect(pointsPerKrw(pkg({ priceKrw: 0 }))).toBe(0);
  });

  it("picks the highest points-per-won package that actually carries a bonus", () => {
    expect(
      bestValuePackageId([
        pkg({ id: "a", basePoints: 1_000, bonusPoints: 0, priceKrw: 100 }), // best ratio but no bonus
        pkg({ id: "b", basePoints: 1_000, bonusPoints: 100, priceKrw: 1_000 }),
        pkg({ id: "c", basePoints: 1_000, bonusPoints: 500, priceKrw: 1_000 }),
      ]),
    ).toBe("c");
  });

  it("keeps the earlier package on a tie", () => {
    expect(
      bestValuePackageId([
        pkg({ id: "b", basePoints: 1_000, bonusPoints: 200, priceKrw: 1_000 }),
        pkg({ id: "c", basePoints: 1_000, bonusPoints: 200, priceKrw: 1_000 }),
      ]),
    ).toBe("b");
  });

  it("returns null when no package has a bonus", () => {
    expect(bestValuePackageId([pkg({ id: "a" }), pkg({ id: "b" })])).toBeNull();
  });

  it("marks a real catalog package as best value", () => {
    const id = bestValuePackageId();
    expect(id).not.toBeNull();
    expect(TOPUP_PACKAGES.some((p) => p.id === id)).toBe(true);
  });
});

describe("formatting / lookup", () => {
  it("formats prices and points for display", () => {
    expect(formatKrw(30_000)).toBe("₩30,000");
    expect(formatPoints(12_000)).toBe("12,000 P");
  });

  it("finds a package by id and returns null for an unknown id", () => {
    expect(findPackage("mega")?.priceKrw).toBe(30_000);
    expect(findPackage("nope")).toBeNull();
  });
});
