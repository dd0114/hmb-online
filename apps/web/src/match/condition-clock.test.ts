import { describe, expect, it } from "vitest";
import {
  conditionAngle,
  conditionColor,
  conditionHandTip,
  conditionLabel,
  conditionTier,
} from "./condition-clock";

describe("conditionAngle", () => {
  it("maps best (1.0) to 12 o'clock (0°) and worst (0.0) to 6 o'clock (180°)", () => {
    expect(conditionAngle(1)).toBe(0);
    expect(conditionAngle(0)).toBe(180);
    expect(conditionAngle(0.5)).toBe(90);
  });

  it("is monotonic decreasing in condition value", () => {
    expect(conditionAngle(0.9)).toBeLessThan(conditionAngle(0.4));
  });

  it("clamps out-of-range values", () => {
    expect(conditionAngle(2)).toBe(0);
    expect(conditionAngle(-1)).toBe(180);
  });
});

describe("conditionHandTip", () => {
  it("points straight up for best condition", () => {
    const tip = conditionHandTip(1, 50, 50, 40);
    expect(tip.x).toBeCloseTo(50, 5);
    expect(tip.y).toBeCloseTo(10, 5);
  });

  it("points straight down for worst condition", () => {
    const tip = conditionHandTip(0, 50, 50, 40);
    expect(tip.x).toBeCloseTo(50, 5);
    expect(tip.y).toBeCloseTo(90, 5);
  });

  it("points right (3 o'clock) at midpoint", () => {
    const tip = conditionHandTip(0.5, 50, 50, 40);
    expect(tip.x).toBeCloseTo(90, 5);
    expect(tip.y).toBeCloseTo(50, 5);
  });
});

describe("conditionTier / color / label", () => {
  it("tiers by thresholds 0.66 / 0.33", () => {
    expect(conditionTier(0.8)).toBe("high");
    expect(conditionTier(0.5)).toBe("mid");
    expect(conditionTier(0.1)).toBe("low");
  });

  it("colors green/amber/red per tier", () => {
    expect(conditionColor(0.9)).toBe("#3ec46d");
    expect(conditionColor(0.5)).toBe("#f2c744");
    expect(conditionColor(0.1)).toBe("#e5533c");
  });

  it("labels each tier", () => {
    expect(conditionLabel(0.9)).toBe("최상");
    expect(conditionLabel(0.5)).toBe("보통");
    expect(conditionLabel(0.1)).toBe("저조");
  });
});
