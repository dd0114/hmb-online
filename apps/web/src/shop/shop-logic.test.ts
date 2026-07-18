import { describe, expect, it } from "vitest";
import { gachaButtonState } from "./shop-logic";

describe("gachaButtonState", () => {
  const COST = 300;

  it("disables without the short-note while the wallet is still loading", () => {
    const s = gachaButtonState({ loaded: false, points: 0, cost: COST, pending: false });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(false); // #73 P0: no '포인트 부족' flash before balance known
  });

  it("enables when loaded with enough points", () => {
    const s = gachaButtonState({ loaded: true, points: 3200, cost: COST, pending: false });
    expect(s.disabled).toBe(false);
    expect(s.showShort).toBe(false);
  });

  it("shows the short-note and disables only once loaded and truly short", () => {
    const s = gachaButtonState({ loaded: true, points: 100, cost: COST, pending: false });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(true);
  });

  it("disables while a pull is pending even with enough points", () => {
    const s = gachaButtonState({ loaded: true, points: 3200, cost: COST, pending: true });
    expect(s.disabled).toBe(true);
    expect(s.showShort).toBe(false);
  });

  it("treats exact balance as sufficient", () => {
    const s = gachaButtonState({ loaded: true, points: 300, cost: COST, pending: false });
    expect(s.disabled).toBe(false);
    expect(s.showShort).toBe(false);
  });
});
