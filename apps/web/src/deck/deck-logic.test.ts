import { describe, expect, it } from "vitest";
import {
  assignPlayer,
  bulkApplyPreset,
  emptyDraft,
  findPlayerSlot,
  firstEmptySlot,
  getSlot,
  removePlayer,
  setPrompt,
  validateDraft,
  type DeckDraft,
  type Position,
} from "./deck-logic";

function positions(map: Record<string, Position>) {
  return (id: string) => map[id];
}

function fullStarters(gkId = "GK1"): DeckDraft {
  let draft = emptyDraft("4-4-2");
  draft = assignPlayer(draft, "starter", 0, gkId);
  for (let i = 1; i <= 10; i++) {
    draft = assignPlayer(draft, "starter", i, `P${i}`);
  }
  return draft;
}

describe("assignPlayer", () => {
  it("assigns a player to an empty slot", () => {
    const draft = assignPlayer(emptyDraft(), "starter", 0, "P001");
    expect(getSlot(draft, "starter", 0)?.playerId).toBe("P001");
  });

  it("moves a player instead of duplicating when assigned to a second slot", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "P001");
    draft = assignPlayer(draft, "starter", 6, "P001");
    expect(draft.slots.filter((s) => s.playerId === "P001")).toHaveLength(1);
    expect(getSlot(draft, "starter", 5)).toBeUndefined();
    expect(getSlot(draft, "starter", 6)?.playerId).toBe("P001");
  });

  it("replaces the previous occupant of the target slot", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 3, "P001");
    draft = assignPlayer(draft, "starter", 3, "P002");
    expect(getSlot(draft, "starter", 3)?.playerId).toBe("P002");
    expect(findPlayerSlot(draft, "P001")).toBeUndefined();
  });

  it("keeps the player's prompt when moved between slots", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 5, "P001");
    draft = setPrompt(draft, "P001", "왼쪽 측면 돌파");
    draft = assignPlayer(draft, "bench", 0, "P001");
    expect(getSlot(draft, "bench", 0)?.promptText).toBe("왼쪽 측면 돌파");
  });
});

describe("removePlayer / setPrompt", () => {
  it("removes only the given player", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 0, "P001");
    draft = assignPlayer(draft, "starter", 1, "P002");
    draft = removePlayer(draft, "P001");
    expect(findPlayerSlot(draft, "P001")).toBeUndefined();
    expect(findPlayerSlot(draft, "P002")).toBeDefined();
  });

  it("sets prompt text on the target player only", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 0, "P001");
    draft = assignPlayer(draft, "starter", 1, "P002");
    draft = setPrompt(draft, "P001", "수비 집중");
    expect(findPlayerSlot(draft, "P001")?.promptText).toBe("수비 집중");
    expect(findPlayerSlot(draft, "P002")?.promptText).toBeNull();
  });
});

describe("bulkApplyPreset (AC-W2 copy semantics)", () => {
  it("copies the preset text into each selected player's prompt only", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 0, "P001");
    draft = assignPlayer(draft, "starter", 1, "P002");
    draft = assignPlayer(draft, "starter", 2, "P003");
    draft = setPrompt(draft, "P003", "기존 프롬프트");

    const applied = bulkApplyPreset(draft, ["P001", "P002"], "강하게 압박");

    expect(findPlayerSlot(applied, "P001")?.promptText).toBe("강하게 압박");
    expect(findPlayerSlot(applied, "P002")?.promptText).toBe("강하게 압박");
    // unselected player untouched
    expect(findPlayerSlot(applied, "P003")?.promptText).toBe("기존 프롬프트");
  });

  it("copies by value — later edits to one player do not affect the others", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 0, "P001");
    draft = assignPlayer(draft, "starter", 1, "P002");
    draft = bulkApplyPreset(draft, ["P001", "P002"], "프리셋 본문");
    draft = setPrompt(draft, "P001", "개별 수정");
    expect(findPlayerSlot(draft, "P002")?.promptText).toBe("프리셋 본문");
  });

  it("overwrites existing prompt text of selected players (apply = copy body)", () => {
    let draft = assignPlayer(emptyDraft(), "starter", 0, "P001");
    draft = setPrompt(draft, "P001", "이전 내용");
    draft = bulkApplyPreset(draft, ["P001"], "새 프리셋");
    expect(findPlayerSlot(draft, "P001")?.promptText).toBe("새 프리셋");
  });
});

describe("firstEmptySlot", () => {
  it("fills GK slot first on an empty 4-4-2 draft", () => {
    expect(firstEmptySlot(emptyDraft("4-4-2"))).toEqual({ role: "starter", slotIndex: 0 });
  });

  it("falls through to bench when all 11 starters are filled", () => {
    const draft = fullStarters();
    expect(firstEmptySlot(draft)).toEqual({ role: "bench", slotIndex: 0 });
  });

  it("returns null when starters and bench are all full", () => {
    let draft = fullStarters();
    for (let i = 0; i < 7; i++) {
      draft = assignPlayer(draft, "bench", i, `B${i}`);
    }
    expect(firstEmptySlot(draft)).toBeNull();
  });
});

describe("validateDraft (client pre-check — server is SoT)", () => {
  const gkPositions = positions({ GK1: "GK" });

  it("flags starter count below 11", () => {
    const draft = assignPlayer(emptyDraft(), "starter", 0, "GK1");
    const issues = validateDraft(draft, gkPositions);
    expect(issues.map((i) => i.rule)).toContain("STARTER_COUNT");
  });

  it("flags missing GK among starters", () => {
    const draft = fullStarters("P0"); // P0 has unknown position → no GK
    const issues = validateDraft(draft, positions({}));
    expect(issues.map((i) => i.rule)).toContain("GK_REQUIRED");
  });

  it("passes a valid 11-starter draft with a GK", () => {
    const draft = fullStarters();
    expect(validateDraft(draft, gkPositions)).toHaveLength(0);
  });

  it("flags prompt text over 500 chars with the offending player", () => {
    let draft = fullStarters();
    draft = setPrompt(draft, "P3", "가".repeat(501));
    const issues = validateDraft(draft, gkPositions);
    const issue = issues.find((i) => i.rule === "PROMPT_TOO_LONG");
    expect(issue?.playerId).toBe("P3");
  });

  it("accepts prompt text of exactly 500 chars", () => {
    let draft = fullStarters();
    draft = setPrompt(draft, "P3", "가".repeat(500));
    expect(validateDraft(draft, gkPositions)).toHaveLength(0);
  });
});
