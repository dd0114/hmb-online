/**
 * Pure deck-draft logic (unit-tested). The server (DeckService, AC-S2) remains the
 * source of truth for validation — the pre-checks here only catch obvious cases
 * client-side (starters<11 → disable save, GK missing, bench overflow, prompt length)
 * so the user gets instant feedback without a round-trip.
 */
import type { components } from "../api/schema";

export type Position = components["schemas"]["Position"];

export type SlotRole = "starter" | "bench";

export interface DraftSlot {
  playerId: string;
  role: SlotRole;
  slotIndex: number;
  promptText?: string | null;
}

export interface DeckDraft {
  formation: string;
  slots: DraftSlot[];
}

export const STARTER_COUNT = 11;
export const BENCH_MAX = 7;
export const PROMPT_MAX_CHARS = 500;

/**
 * Slot-index layout per formation, grouped into pitch rows (display order:
 * FW row first / GK last). starter slotIndex space is always 0..10 (openapi DeckSlot).
 * NOTE: the engine currently only ships formations["4-3-3"] (packages/engine config) —
 * the server accepts any non-blank formation string, so both layouts are offered here.
 */
export interface FormationRow {
  label: Position;
  slotIndexes: number[];
}

export const FORMATION_LAYOUTS: Record<string, FormationRow[]> = {
  "4-4-2": [
    { label: "FW", slotIndexes: [9, 10] },
    { label: "MF", slotIndexes: [5, 6, 7, 8] },
    { label: "DF", slotIndexes: [1, 2, 3, 4] },
    { label: "GK", slotIndexes: [0] },
  ],
  "4-3-3": [
    { label: "FW", slotIndexes: [8, 9, 10] },
    { label: "MF", slotIndexes: [5, 6, 7] },
    { label: "DF", slotIndexes: [1, 2, 3, 4] },
    { label: "GK", slotIndexes: [0] },
  ],
};

export const DEFAULT_FORMATION = "4-4-2";

export function emptyDraft(formation: string = DEFAULT_FORMATION): DeckDraft {
  return { formation, slots: [] };
}

export function getSlot(draft: DeckDraft, role: SlotRole, slotIndex: number): DraftSlot | undefined {
  return draft.slots.find((s) => s.role === role && s.slotIndex === slotIndex);
}

export function findPlayerSlot(draft: DeckDraft, playerId: string): DraftSlot | undefined {
  return draft.slots.find((s) => s.playerId === playerId);
}

/**
 * Assign a player to a slot. The player is removed from any slot they already occupy
 * (no duplicates — server rule DUPLICATE_PLAYER), and an existing occupant of the
 * target slot is dropped from the deck. Prompt text moves with the player.
 */
export function assignPlayer(
  draft: DeckDraft,
  role: SlotRole,
  slotIndex: number,
  playerId: string,
): DeckDraft {
  const existing = findPlayerSlot(draft, playerId);
  const slots = draft.slots
    .filter((s) => s.playerId !== playerId)
    .filter((s) => !(s.role === role && s.slotIndex === slotIndex));
  slots.push({ playerId, role, slotIndex, promptText: existing?.promptText ?? null });
  return { ...draft, slots };
}

export function removePlayer(draft: DeckDraft, playerId: string): DeckDraft {
  return { ...draft, slots: draft.slots.filter((s) => s.playerId !== playerId) };
}

export function setPrompt(draft: DeckDraft, playerId: string, promptText: string): DeckDraft {
  return {
    ...draft,
    slots: draft.slots.map((s) => (s.playerId === playerId ? { ...s, promptText } : s)),
  };
}

/**
 * Bulk apply (AC-W2): copies the preset body into each selected player's prompt.
 * Copy semantics — the text is duplicated per player at apply time; deleting the
 * preset later must not affect already-applied prompts (server AC-S4 mirrors this).
 */
export function bulkApplyPreset(draft: DeckDraft, playerIds: string[], presetText: string): DeckDraft {
  const targets = new Set(playerIds);
  return {
    ...draft,
    slots: draft.slots.map((s) => (targets.has(s.playerId) ? { ...s, promptText: presetText } : s)),
  };
}

/** First empty slot, starters (in formation layout order) before bench. */
export function firstEmptySlot(draft: DeckDraft): { role: SlotRole; slotIndex: number } | null {
  const layout = FORMATION_LAYOUTS[draft.formation] ?? FORMATION_LAYOUTS[DEFAULT_FORMATION]!;
  for (const row of [...layout].reverse()) {
    // reverse → GK,DF,MF,FW: fill from the back line up
    for (const idx of row.slotIndexes) {
      if (!getSlot(draft, "starter", idx)) return { role: "starter", slotIndex: idx };
    }
  }
  for (let i = 0; i < BENCH_MAX; i++) {
    if (!getSlot(draft, "bench", i)) return { role: "bench", slotIndex: i };
  }
  return null;
}

export interface DraftIssue {
  rule: string;
  message: string;
  playerId?: string;
}

/** Client-side pre-check mirror of the server matrix (subset — server is SoT). */
export function validateDraft(
  draft: DeckDraft,
  positionOf: (playerId: string) => Position | undefined,
): DraftIssue[] {
  const issues: DraftIssue[] = [];
  const starters = draft.slots.filter((s) => s.role === "starter");
  const bench = draft.slots.filter((s) => s.role === "bench");

  if (starters.length !== STARTER_COUNT) {
    issues.push({
      rule: "STARTER_COUNT",
      message: `선발이 ${STARTER_COUNT}명이 아닙니다 (현재 ${starters.length}명)`,
    });
  }
  if (bench.length > BENCH_MAX) {
    issues.push({ rule: "BENCH_MAX", message: `벤치는 최대 ${BENCH_MAX}명입니다` });
  }
  if (starters.length > 0 && !starters.some((s) => positionOf(s.playerId) === "GK")) {
    issues.push({ rule: "GK_REQUIRED", message: "선발에 GK가 최소 1명 필요합니다" });
  }
  for (const s of draft.slots) {
    if (s.promptText && s.promptText.length > PROMPT_MAX_CHARS) {
      issues.push({
        rule: "PROMPT_TOO_LONG",
        message: `프롬프트가 최대 ${PROMPT_MAX_CHARS}자를 초과했습니다`,
        playerId: s.playerId,
      });
    }
  }
  return issues;
}

/**
 * Serialize the draft as the PUT /api/deck body (full replace).
 *
 * `teamPrompt` is a REQUIRED parameter on purpose (#253). The team-level sentence used to have
 * nowhere to go in this body, so the deck screen showed "저장되었습니다" and the text was gone on
 * reload — the per-player prompts survived (they ride on slots), which made it look like a
 * targeted data loss. Making the caller pass it means a screen that forgets it fails to compile
 * rather than silently wiping the user's text; PUT is a full replace, so omitting = deleting.
 * Pass `""` to clear deliberately.
 */
export function toUpdateRequest(
  draft: DeckDraft,
  teamPrompt: string,
): {
  formation: string;
  teamPrompt: string | null;
  slots: DraftSlot[];
} {
  return {
    formation: draft.formation,
    // Blank-only text is "no sentence" — the server normalizes the same way, and keeping "" out
    // of the snapshot is what lets a cleared prompt land back on its original AI-input cache key.
    teamPrompt: teamPrompt.trim() ? teamPrompt : null,
    slots: draft.slots.map((s) => ({
      playerId: s.playerId,
      role: s.role,
      slotIndex: s.slotIndex,
      promptText: s.promptText ?? null,
    })),
  };
}
