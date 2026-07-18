import { describe, expect, it } from "vitest";
import { assignPlayer, emptyDraft, getSlot, findPlayerSlot, type DeckDraft } from "./deck-logic";
import {
  DEFAULT_TEAM_TACTICS,
  editorToSaveRequest,
  firstEmptyBench,
  movePlayerToSlot,
  snapshotSaveable,
  snapshotToEditor,
  starterCoords,
} from "./tactics-logic";
import type { TeamSnapshot } from "../api/v2";

function fullStarters(): DeckDraft {
  let draft = emptyDraft("4-4-2");
  draft = assignPlayer(draft, "starter", 0, "GK1");
  for (let i = 1; i <= 10; i++) draft = assignPlayer(draft, "starter", i, `P${i}`);
  return draft;
}

describe("starterCoords", () => {
  it("returns one coord per starter slot (11) for 4-4-2 and 4-3-3", () => {
    expect(starterCoords("4-4-2")).toHaveLength(11);
    expect(starterCoords("4-3-3")).toHaveLength(11);
  });

  it("GK row sits lower (higher y) than the FW row", () => {
    const coords = starterCoords("4-4-2");
    const gk = coords.find((c) => c.slotIndex === 0)!;
    const fw = coords.find((c) => c.label === "FW")!;
    expect(gk.y).toBeGreaterThan(fw.y);
  });

  it("keeps all coords within the pitch box (0..1)", () => {
    for (const c of starterCoords("4-3-3")) {
      expect(c.x).toBeGreaterThanOrEqual(0);
      expect(c.x).toBeLessThanOrEqual(1);
      expect(c.y).toBeGreaterThanOrEqual(0);
      expect(c.y).toBeLessThanOrEqual(1);
    }
  });

  it("falls back to the default formation for an unknown key", () => {
    expect(starterCoords("weird-9-9")).toHaveLength(11);
  });
});

describe("movePlayerToSlot", () => {
  it("moves a player to an empty target slot, freeing the source", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "P001");
    draft = movePlayerToSlot(draft, "P001", "bench", 0);
    expect(getSlot(draft, "starter", 5)).toBeUndefined();
    expect(getSlot(draft, "bench", 0)?.playerId).toBe("P001");
  });

  it("swaps two on-board players (bench↔starter)", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "STARTER");
    draft = assignPlayer(draft, "bench", 0, "BENCHIE");
    draft = movePlayerToSlot(draft, "BENCHIE", "starter", 5);
    expect(getSlot(draft, "starter", 5)?.playerId).toBe("BENCHIE");
    expect(getSlot(draft, "bench", 0)?.playerId).toBe("STARTER");
  });

  it("carries prompt text with the swapped players", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "A");
    draft = assignPlayer(draft, "bench", 0, "B");
    draft = { ...draft, slots: draft.slots.map((s) => (s.playerId === "A" ? { ...s, promptText: "keep me" } : s)) };
    draft = movePlayerToSlot(draft, "B", "starter", 5);
    expect(findPlayerSlot(draft, "A")?.promptText).toBe("keep me");
    expect(findPlayerSlot(draft, "A")?.role).toBe("bench");
  });

  it("drops the occupant when placing a pool player onto an occupied slot (no duplicate)", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "OLD");
    draft = movePlayerToSlot(draft, "NEW_FROM_POOL", "starter", 5);
    expect(getSlot(draft, "starter", 5)?.playerId).toBe("NEW_FROM_POOL");
    expect(findPlayerSlot(draft, "OLD")).toBeUndefined();
    expect(draft.slots.filter((s) => s.playerId === "NEW_FROM_POOL")).toHaveLength(1);
  });

  it("is a no-op when dropped on its own slot", () => {
    const draft = assignPlayer(emptyDraft(), "starter", 5, "P001");
    expect(movePlayerToSlot(draft, "P001", "starter", 5)).toBe(draft);
  });
});

describe("firstEmptyBench", () => {
  it("returns 0 for an empty bench and null when full", () => {
    let draft = emptyDraft();
    expect(firstEmptyBench(draft)).toBe(0);
    for (let i = 0; i < 7; i++) draft = assignPlayer(draft, "bench", i, `B${i}`);
    expect(firstEmptyBench(draft)).toBeNull();
  });
});

describe("snapshot serialization round-trip", () => {
  const snap: TeamSnapshot = {
    formation: "4-3-3",
    starters: [
      { playerId: "GK1", slotIndex: 0, promptText: null },
      { playerId: "P5", slotIndex: 5, promptText: "press high" },
    ],
    bench: [{ playerId: "B1", slotIndex: 0, promptText: null }],
    teamTactics: { line: 0.7, press: 0.8, tempo: 0.4, width: 0.6 },
    teamPrompt: "counter-attack",
  };

  it("snapshotToEditor maps starters/bench into draft slots + tactics + teamPrompt", () => {
    const editor = snapshotToEditor(snap);
    expect(editor.draft.formation).toBe("4-3-3");
    expect(getSlot(editor.draft, "starter", 5)?.promptText).toBe("press high");
    expect(getSlot(editor.draft, "bench", 0)?.playerId).toBe("B1");
    expect(editor.tactics.press).toBe(0.8);
    expect(editor.teamPrompt).toBe("counter-attack");
  });

  it("editorToSaveRequest reproduces the snapshot body (sorted by slotIndex)", () => {
    const editor = snapshotToEditor(snap);
    const req = editorToSaveRequest(editor, "my-team");
    expect(req.name).toBe("my-team");
    expect(req.formation).toBe("4-3-3");
    expect(req.starters.map((s) => s.slotIndex)).toEqual([0, 5]);
    expect(req.starters.find((s) => s.slotIndex === 5)?.promptText).toBe("press high");
    expect(req.bench).toHaveLength(1);
    expect(req.teamTactics).toEqual(snap.teamTactics);
    expect(req.teamPrompt).toBe("counter-attack");
  });

  it("defaults tactics/prompt when the snapshot omits them", () => {
    const editor = snapshotToEditor({ formation: "4-4-2", starters: [], bench: [] });
    expect(editor.tactics).toEqual(DEFAULT_TEAM_TACTICS);
    expect(editor.teamPrompt).toBe("");
  });

  it("editorToSaveRequest sends teamPrompt=null when empty", () => {
    const editor = snapshotToEditor({ formation: "4-4-2", starters: [], bench: [] });
    expect(editorToSaveRequest(editor, "x").teamPrompt).toBeNull();
  });
});

describe("snapshotSaveable", () => {
  it("is true only with exactly 11 starters", () => {
    expect(snapshotSaveable(fullStarters())).toBe(true);
    expect(snapshotSaveable(emptyDraft())).toBe(false);
  });
});
