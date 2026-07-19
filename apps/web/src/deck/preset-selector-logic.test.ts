import { describe, expect, it } from "vitest";
import type { CatalogPlayer } from "../api/hooks";
import type { TeamPresetSlot, TeamSnapshot } from "../api/v2";
import { assignPlayer, emptyDraft, setPrompt, type DeckDraft } from "./deck-logic";
import { DEFAULT_TEAM_TACTICS, snapshotToEditor, type EditorState } from "./tactics-logic";
import {
  allSlotsEmpty,
  editorFingerprint,
  isDirty,
  makeBaseline,
  nextEmptySlot,
  slotByNumber,
  snapshotPower,
  snapshotSummary,
} from "./preset-selector-logic";

function fullEditor(): EditorState {
  let draft: DeckDraft = emptyDraft("4-4-2");
  draft = assignPlayer(draft, "starter", 0, "GK1");
  for (let i = 1; i <= 10; i++) draft = assignPlayer(draft, "starter", i, `P${i}`);
  return { draft, tactics: { ...DEFAULT_TEAM_TACTICS }, teamPrompt: "" };
}

const emptySlots: TeamPresetSlot[] = [
  { slot: 1, name: null, snapshot: null },
  { slot: 2, name: null, snapshot: null },
  { slot: 3, name: null, snapshot: null },
];

const snap: TeamSnapshot = {
  formation: "4-3-3",
  starters: [
    { playerId: "GK1", slotIndex: 0, promptText: null },
    { playerId: "P5", slotIndex: 5, promptText: "press" },
  ],
  bench: [],
  teamTactics: { line: 0.6, press: 0.7, tempo: 0.5, width: 0.4 },
  teamPrompt: "counter",
};

describe("editorFingerprint / isDirty", () => {
  it("is stable regardless of internal slot array order", () => {
    const a = fullEditor();
    const b: EditorState = { ...a, draft: { ...a.draft, slots: [...a.draft.slots].reverse() } };
    expect(editorFingerprint(a)).toBe(editorFingerprint(b));
  });

  it("not dirty against its own baseline", () => {
    const ed = fullEditor();
    const base = makeBaseline(ed, "My Team", 1);
    expect(isDirty(ed, "My Team", base)).toBe(false);
  });

  it("dirty when a player prompt changes", () => {
    const ed = fullEditor();
    const base = makeBaseline(ed, "T", 1);
    const edited: EditorState = { ...ed, draft: setPrompt(ed.draft, "P5", "high press") };
    expect(isDirty(edited, "T", base)).toBe(true);
  });

  it("dirty when the team prompt changes", () => {
    const ed = fullEditor();
    const base = makeBaseline(ed, "T", 1);
    expect(isDirty({ ...ed, teamPrompt: "gegenpress" }, "T", base)).toBe(true);
  });

  it("dirty when formation changes", () => {
    const ed = fullEditor();
    const base = makeBaseline(ed, "T", 1);
    expect(isDirty({ ...ed, draft: { ...ed.draft, formation: "4-3-3" } }, "T", base)).toBe(true);
  });

  it("dirty when team tactics change", () => {
    const ed = fullEditor();
    const base = makeBaseline(ed, "T", 1);
    expect(isDirty({ ...ed, tactics: { ...ed.tactics, press: 0.9 } }, "T", base)).toBe(true);
  });

  it("dirty when only the name changes (요구 5 이름)", () => {
    const ed = fullEditor();
    const base = makeBaseline(ed, "Old", 1);
    expect(isDirty(ed, "New", base)).toBe(true);
  });

  it("loading a snapshot then reserializing round-trips clean", () => {
    const ed = snapshotToEditor(snap);
    const base = makeBaseline(ed, "loaded", 2);
    expect(isDirty(snapshotToEditor(snap), "loaded", base)).toBe(false);
  });
});

describe("nextEmptySlot / allSlotsEmpty", () => {
  it("returns 1 for all-empty and detects the all-empty first entry", () => {
    expect(nextEmptySlot(emptySlots)).toBe(1);
    expect(allSlotsEmpty(emptySlots)).toBe(true);
  });

  it("returns the lowest empty slot when some are filled", () => {
    const slots: TeamPresetSlot[] = [
      { slot: 1, name: "A", snapshot: snap },
      { slot: 2, name: null, snapshot: null },
      { slot: 3, name: "C", snapshot: snap },
    ];
    expect(nextEmptySlot(slots)).toBe(2);
    expect(allSlotsEmpty(slots)).toBe(false);
  });

  it("returns null when all three are filled", () => {
    const slots: TeamPresetSlot[] = [1, 2, 3].map((slot) => ({ slot: slot as 1 | 2 | 3, name: "x", snapshot: snap }));
    expect(nextEmptySlot(slots)).toBeNull();
    expect(allSlotsEmpty(slots)).toBe(false);
  });
});

describe("slotByNumber", () => {
  it("finds a slot regardless of array order, null-safe", () => {
    const slots: TeamPresetSlot[] = [
      { slot: 3, name: "c", snapshot: snap },
      { slot: 1, name: "a", snapshot: snap },
    ];
    expect(slotByNumber(slots, 1)?.name).toBe("a");
    expect(slotByNumber(slots, null)).toBeUndefined();
    expect(slotByNumber(slots, 2)).toBeUndefined();
  });
});

describe("snapshotPower / snapshotSummary", () => {
  const mkPlayer = (id: string, ovr: number): CatalogPlayer =>
    ({
      id,
      name: id,
      position: "MF",
      grade: "GOLD",
      owned: true,
      ownedCount: 1,
      attributes: {
        technical: ovr, mental: ovr, physical: ovr, passing: ovr, shooting: ovr,
        tackling: ovr, pace: ovr, stamina: ovr, positioning: ovr,
      },
    }) as unknown as CatalogPlayer;

  it("sums owned starters' overalls and skips missing players", () => {
    const byId = new Map<string, CatalogPlayer>([
      ["GK1", mkPlayer("GK1", 80)],
      // P5 intentionally absent from pool → skipped
    ]);
    expect(snapshotPower(snap, byId)).toBe(80);
  });

  it("summary carries formation / starterCount / tactics / prompt", () => {
    const byId = new Map<string, CatalogPlayer>([["GK1", mkPlayer("GK1", 70)]]);
    const s = snapshotSummary(snap, byId);
    expect(s.formation).toBe("4-3-3");
    expect(s.starterCount).toBe(2);
    expect(s.tactics?.press).toBe(0.7);
    expect(s.teamPrompt).toBe("counter");
    expect(s.power).toBe(70);
  });
});
