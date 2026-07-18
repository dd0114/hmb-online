import { describe, expect, it } from "vitest";
import {
  canPropose,
  initialProposal,
  resetProposal,
  setPoints,
  togglePlayer,
  toRequest,
} from "./propose-builder";

describe("togglePlayer", () => {
  it("adds then removes a player, preserving insertion order", () => {
    let s = initialProposal();
    s = togglePlayer(s, "A");
    s = togglePlayer(s, "B");
    expect(s.selected).toEqual(["A", "B"]);
    s = togglePlayer(s, "A");
    expect(s.selected).toEqual(["B"]);
  });
});

describe("setPoints", () => {
  it("clamps into [0, max] and floors", () => {
    const s = initialProposal();
    expect(setPoints(s, 250.7, 1000).points).toBe(250);
    expect(setPoints(s, -10, 1000).points).toBe(0);
    expect(setPoints(s, 5000, 1000).points).toBe(1000);
  });
  it("treats non-finite input as 0", () => {
    expect(setPoints(initialProposal(), NaN, 1000).points).toBe(0);
  });
});

describe("canPropose", () => {
  it("requires at least one selected player (다중선택)", () => {
    expect(canPropose(initialProposal())).toBe(false);
    expect(canPropose(togglePlayer(initialProposal(), "A"))).toBe(true);
  });
  it("points alone is not submittable", () => {
    const s = setPoints(initialProposal(), 500, 1000);
    expect(canPropose(s)).toBe(false);
  });
});

describe("toRequest / resetProposal", () => {
  it("serializes selected + points", () => {
    let s = togglePlayer(initialProposal(), "A");
    s = setPoints(s, 300, 1000);
    expect(toRequest(s)).toEqual({ playerIds: ["A"], points: 300 });
  });
  it("reset clears everything", () => {
    expect(resetProposal()).toEqual({ selected: [], points: 0 });
  });
});
