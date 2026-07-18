import { describe, expect, it } from "vitest";
import type { TradeSlot } from "../api/v2";
import {
  countdownSec,
  formatCountdown,
  formatProbability,
  slotView,
  speedupButtonState,
} from "./trade-logic";

const baseSlot = (over: Partial<TradeSlot>): TradeSlot => ({
  slot: 1,
  state: "WAITING",
  ...over,
});

describe("slotView", () => {
  it("classifies WAITING / RESOLVING by state", () => {
    expect(slotView(baseSlot({ state: "WAITING" }))).toBe("WAITING");
    expect(slotView(baseSlot({ state: "RESOLVING" }))).toBe("RESOLVING");
  });
  it("splits OPEN by offerKind", () => {
    expect(slotView(baseSlot({ state: "OPEN", offerKind: "FA" }))).toBe("OPEN_FA");
    expect(slotView(baseSlot({ state: "OPEN", offerKind: "TRADE" }))).toBe("OPEN_TRADE");
  });
});

describe("countdownSec", () => {
  it("subtracts local elapsed from the server anchor (drift-immune)", () => {
    expect(countdownSec(120, 0)).toBe(120);
    expect(countdownSec(120, 5_000)).toBe(115);
    expect(countdownSec(120, 5_999)).toBe(115); // floors sub-second elapsed
  });
  it("never goes negative", () => {
    expect(countdownSec(3, 10_000)).toBe(0);
  });
  it("ignores negative elapsed (clock jitter)", () => {
    expect(countdownSec(30, -2_000)).toBe(30);
  });
});

describe("formatCountdown", () => {
  it("formats M:SS", () => {
    expect(formatCountdown(0)).toBe("0:00");
    expect(formatCountdown(65)).toBe("1:05");
    expect(formatCountdown(600)).toBe("10:00");
  });
  it("formats H:MM:SS past an hour", () => {
    expect(formatCountdown(3661)).toBe("1:01:01");
  });
  it("clamps negatives", () => {
    expect(formatCountdown(-5)).toBe("0:00");
  });
});

describe("formatProbability", () => {
  it("renders a percent from 0..1", () => {
    expect(formatProbability(0.8)).toBe("80%");
    expect(formatProbability(0)).toBe("0%");
    expect(formatProbability(1)).toBe("100%");
  });
  it("returns null when absent (FA has no pre-probability)", () => {
    expect(formatProbability(null)).toBeNull();
    expect(formatProbability(undefined)).toBeNull();
  });
});

describe("speedupButtonState", () => {
  it("enables when loaded, affordable, has cost, not pending", () => {
    const s = speedupButtonState({ loaded: true, points: 500, cost: 200, pending: false });
    expect(s.disabled).toBe(false);
    expect(s.showShort).toBe(false);
  });
  it("shows short + disables when points < cost", () => {
    const s = speedupButtonState({ loaded: true, points: 100, cost: 200, pending: false });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(true);
  });
  it("never shows short before wallet loads (#73)", () => {
    const s = speedupButtonState({ loaded: false, points: 0, cost: 200, pending: false });
    expect(s.showShort).toBe(false);
    expect(s.disabled).toBe(true);
  });
  it("disables (no short) when there is no speedup cost", () => {
    const s = speedupButtonState({ loaded: true, points: 999, cost: null, pending: false });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(false);
  });
  it("disables while pending", () => {
    expect(speedupButtonState({ loaded: true, points: 999, cost: 10, pending: true }).disabled).toBe(true);
  });
});
