/**
 * Pure logic for the drag-and-drop tactics board + team snapshot serialization (AC-B1~B3).
 *
 * Reuses `deck-logic` DeckDraft/DraftSlot as the in-editor model (the server DeckService
 * remains SoT for validation). This module adds:
 *   - pitch token coordinates per formation (derived from FORMATION_LAYOUTS — no hardcode),
 *   - drag swap/assign state transition (bench↔starter, slot↔slot),
 *   - snapshot (de)serialization to the openapi-v2 TeamSnapshot / TeamSnapshotSaveRequest.
 */
import type { TeamSnapshot, TeamSnapshotSaveRequest, TeamTactics, SnapshotSlot } from "../api/v2";
import {
  assignPlayer,
  BENCH_MAX,
  DEFAULT_FORMATION,
  findPlayerSlot,
  FORMATION_LAYOUTS,
  getSlot,
  STARTER_COUNT,
  type DeckDraft,
  type DraftSlot,
  type SlotRole,
} from "./deck-logic";

export interface SlotCoord {
  slotIndex: number;
  /** 0 (left) .. 1 (right) */
  x: number;
  /** 0 (top = attack/FW) .. 1 (bottom = own goal/GK) */
  y: number;
  label: string;
}

/** Neutral default (each 0.5) — matches server TeamTactics range 0..1 midpoint. */
export const DEFAULT_TEAM_TACTICS: TeamTactics = { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 };

export const TACTICS_KEYS: Array<keyof TeamTactics> = ["line", "press", "tempo", "width"];

export const TACTICS_LABELS: Record<keyof TeamTactics, string> = {
  line: "수비 라인",
  press: "압박",
  tempo: "템포",
  width: "폭",
};

/**
 * Starter token coordinates on a vertical pitch. Rows come from FORMATION_LAYOUTS
 * (display order FW→GK); y is spread top→bottom, x is spread evenly within each row.
 * Deterministic & pure so the board render + tests share one source.
 */
export function starterCoords(formation: string): SlotCoord[] {
  const layout = FORMATION_LAYOUTS[formation] ?? FORMATION_LAYOUTS[DEFAULT_FORMATION]!;
  const rows = layout.length;
  const coords: SlotCoord[] = [];
  layout.forEach((row, rowIdx) => {
    // top margin 0.10, bottom margin 0.92 → GK sits near own goal
    const y = rows <= 1 ? 0.5 : 0.1 + (rowIdx / (rows - 1)) * 0.82;
    const n = row.slotIndexes.length;
    row.slotIndexes.forEach((slotIndex, i) => {
      const x = n === 1 ? 0.5 : 0.14 + (i / (n - 1)) * 0.72;
      coords.push({ slotIndex, x, y, label: row.label });
    });
  });
  return coords;
}

/**
 * Move `playerId` onto (toRole,toSlotIndex) with swap semantics:
 *  - target empty → player moves there (source slot freed).
 *  - target occupied AND player already on the board → the two swap slots.
 *  - target occupied AND player from the pool → occupant is dropped (assignPlayer semantics),
 *    matching the tap-to-place behavior so no duplicate players can exist.
 * Prompt text always travels with its player.
 */
export function movePlayerToSlot(
  draft: DeckDraft,
  playerId: string,
  toRole: SlotRole,
  toSlotIndex: number,
): DeckDraft {
  const source = findPlayerSlot(draft, playerId);
  const occupant = getSlot(draft, toRole, toSlotIndex);

  // no-op: dropped back on its own slot
  if (source && source.role === toRole && source.slotIndex === toSlotIndex) return draft;

  if (occupant && occupant.playerId !== playerId && source) {
    // swap: occupant → source slot, player → target slot
    const slots = draft.slots.map((s): DraftSlot => {
      if (s.playerId === playerId) return { ...s, role: toRole, slotIndex: toSlotIndex };
      if (s.playerId === occupant.playerId) return { ...s, role: source.role, slotIndex: source.slotIndex };
      return s;
    });
    return { ...draft, slots };
  }

  // empty target, or from-pool onto occupied (drop occupant): assignPlayer covers both
  return assignPlayer(draft, toRole, toSlotIndex, playerId);
}

/** First empty bench slot index, or null if the bench is full. */
export function firstEmptyBench(draft: DeckDraft): number | null {
  for (let i = 0; i < BENCH_MAX; i++) {
    if (!getSlot(draft, "bench", i)) return i;
  }
  return null;
}

// ─────────────────────────── snapshot (de)serialization ───────────────────────────

export interface EditorState {
  draft: DeckDraft;
  tactics: TeamTactics;
  teamPrompt: string;
}

/** TeamSnapshot (server) → editor state. starters/bench SnapshotSlot → DraftSlot. */
export function snapshotToEditor(snap: TeamSnapshot): EditorState {
  const slots: DraftSlot[] = [];
  for (const s of snap.starters ?? []) {
    slots.push({ playerId: s.playerId, role: "starter", slotIndex: s.slotIndex, promptText: s.promptText ?? null });
  }
  for (const s of snap.bench ?? []) {
    slots.push({ playerId: s.playerId, role: "bench", slotIndex: s.slotIndex, promptText: s.promptText ?? null });
  }
  return {
    draft: { formation: snap.formation, slots },
    tactics: snap.teamTactics ?? { ...DEFAULT_TEAM_TACTICS },
    teamPrompt: snap.teamPrompt ?? "",
  };
}

function toSnapshotSlots(draft: DeckDraft, role: SlotRole): SnapshotSlot[] {
  return draft.slots
    .filter((s) => s.role === role)
    .sort((a, b) => a.slotIndex - b.slotIndex)
    .map((s) => ({ playerId: s.playerId, slotIndex: s.slotIndex, promptText: s.promptText ?? null }));
}

/** Editor state → PUT /api/presets/team/{slot} body (full replace). */
export function editorToSaveRequest(state: EditorState, name: string): TeamSnapshotSaveRequest {
  return {
    name,
    formation: state.draft.formation,
    starters: toSnapshotSlots(state.draft, "starter"),
    bench: toSnapshotSlots(state.draft, "bench"),
    teamTactics: state.tactics,
    teamPrompt: state.teamPrompt || null,
  };
}

/** Whether the current editor state can be saved as a snapshot (starters == 11). */
export function snapshotSaveable(draft: DeckDraft): boolean {
  return draft.slots.filter((s) => s.role === "starter").length === STARTER_COUNT;
}
