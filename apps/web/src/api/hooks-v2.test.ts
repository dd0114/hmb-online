import { describe, expect, it, vi } from "vitest";
import { duplicateRequest, invalidateAfterTrade, TRADE_INVALIDATE_KEYS } from "./hooks-v2";
import type { TeamPresetSlot } from "./v2";

const filled: TeamPresetSlot = {
  slot: 1,
  name: "우리 팀",
  snapshot: {
    formation: "4-3-3",
    starters: [{ playerId: "GK1", slotIndex: 0, promptText: null }],
    bench: [],
    teamTactics: { line: 0.6, press: 0.7, tempo: 0.5, width: 0.4 },
    teamPrompt: "high press",
  },
  updatedAt: "2026-07-19T00:00:00Z",
};

describe("duplicateRequest", () => {
  it("copies a filled slot's snapshot with a '복사' suffixed name", () => {
    const req = duplicateRequest(filled)!;
    expect(req.name).toBe("우리 팀 복사");
    expect(req.formation).toBe("4-3-3");
    expect(req.starters).toEqual(filled.snapshot!.starters);
    expect(req.teamTactics).toEqual(filled.snapshot!.teamTactics);
    expect(req.teamPrompt).toBe("high press");
  });

  it("honors an explicit copy name", () => {
    expect(duplicateRequest(filled, "백업")!.name).toBe("백업");
  });

  it("returns null for an empty slot", () => {
    const empty: TeamPresetSlot = { slot: 2, name: null, snapshot: null, updatedAt: null };
    expect(duplicateRequest(empty)).toBeNull();
  });
});

describe("invalidateAfterTrade", () => {
  it("invalidates trade + wallet(me) + owned/codex(players) caches (W3)", () => {
    const invalidateQueries = vi.fn();
    invalidateAfterTrade({ invalidateQueries });
    const calledKeys = invalidateQueries.mock.calls.map((c) => c[0].queryKey);
    expect(calledKeys).toEqual([["trade"], ["me"], ["players"]]);
    expect(invalidateQueries).toHaveBeenCalledTimes(TRADE_INVALIDATE_KEYS.length);
  });
});
