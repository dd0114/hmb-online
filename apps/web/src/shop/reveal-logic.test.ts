import { describe, expect, it } from "vitest";
import {
  initialReveal,
  isAllRevealed,
  isCardRevealed,
  revealAll,
  revealNext,
} from "./reveal-logic";

describe("gacha reveal state machine", () => {
  it("starts with all cards face-down", () => {
    const s = initialReveal(11);
    expect(s.revealed).toBe(0);
    expect(isCardRevealed(s, 0)).toBe(false);
    expect(isAllRevealed(s)).toBe(false);
  });

  it("reveals cards one at a time, left to right", () => {
    let s = initialReveal(3);
    s = revealNext(s);
    expect(isCardRevealed(s, 0)).toBe(true);
    expect(isCardRevealed(s, 1)).toBe(false);
    s = revealNext(s);
    expect(isCardRevealed(s, 1)).toBe(true);
    expect(isAllRevealed(s)).toBe(false);
    s = revealNext(s);
    expect(isAllRevealed(s)).toBe(true);
  });

  it("revealNext is a no-op once everything is revealed", () => {
    let s = initialReveal(1);
    s = revealNext(s);
    const after = revealNext(s);
    expect(after.revealed).toBe(1);
  });

  it("revealAll flips everything at once", () => {
    const s = revealAll(initialReveal(11));
    expect(isAllRevealed(s)).toBe(true);
    expect(isCardRevealed(s, 10)).toBe(true);
  });

  it("handles a single-pull (total=1)", () => {
    let s = initialReveal(1);
    expect(isAllRevealed(s)).toBe(false);
    s = revealNext(s);
    expect(isAllRevealed(s)).toBe(true);
  });
});
