/**
 * Pure logic for the preset-centric deck screen (W1, 이슈 #98 요구 1·2·4).
 *
 * The deck screen is reorganized around the 3 team-preset slots: the top of the screen shows the
 * SELECTED slot's completed snapshot, and the editor below is a working copy. This module holds the
 * pure, unit-tested pieces that decision-drive that UI:
 *   - `editorFingerprint` / `isDirty` — detect unsaved edits vs the loaded baseline (요구 5 dirty 추적),
 *   - `nextEmptySlot` — where "[+new] / 새로 저장" writes (요구 2·4),
 *   - `snapshotPower` — team power of a saved snapshot for the top summary (요구 1).
 *
 * Reuses `editorToSaveRequest` as the canonical serializer so the fingerprint matches exactly what
 * gets persisted (no drift between "dirty?" and "what we save").
 */
import type { CatalogPlayer } from "../api/hooks";
import type { TeamPresetSlot, TeamSnapshot } from "../api/v2";
import { editorToSaveRequest, type EditorState } from "./tactics-logic";
import { teamPower } from "./team-power";

/** The saved reference point an editor session was loaded from (used to detect dirty). */
export interface EditorBaseline {
  /** canonical fingerprint of the editable content at load/save time. */
  fingerprint: string;
  /** preset name at load/save time (name is part of dirty — 요구 5). */
  name: string;
  /** the preset slot this baseline was loaded from (null = ad-hoc active deck, no preset). */
  slot: number | null;
}

/**
 * Order-independent fingerprint of the editable content (formation + starters + bench + team
 * tactics + team prompt). Built from `editorToSaveRequest` which already sorts slots by index and
 * separates starters/bench, so two editors with the same content but different internal slot order
 * fingerprint identically. Name is intentionally excluded here — it is compared separately so the
 * two dirty axes (content vs name) stay independent.
 */
export function editorFingerprint(editor: EditorState): string {
  const req = editorToSaveRequest(editor, "");
  return JSON.stringify({
    f: req.formation,
    s: req.starters,
    b: req.bench,
    t: req.teamTactics,
    p: req.teamPrompt ?? "",
  });
}

/** Capture a baseline from the current editor + name + slot. */
export function makeBaseline(editor: EditorState, name: string, slot: number | null): EditorBaseline {
  return { fingerprint: editorFingerprint(editor), name, slot };
}

/**
 * dirty = editable content changed OR the preset name changed vs the loaded baseline
 * (선수배치·프롬프트·전술·팀프롬프트·포메이션·이름 — 요구 5).
 */
export function isDirty(editor: EditorState, name: string, baseline: EditorBaseline): boolean {
  return editorFingerprint(editor) !== baseline.fingerprint || name !== baseline.name;
}

/** Lowest empty preset slot number (1..3), or null when all three hold a snapshot. */
export function nextEmptySlot(slots: TeamPresetSlot[]): number | null {
  const filled = new Set(slots.filter((s) => s.snapshot).map((s) => s.slot));
  for (const n of [1, 2, 3] as const) {
    if (!filled.has(n)) return n;
  }
  return null;
}

/** Whether every preset slot is empty (first-ever entry → highlight [+new] — 요구 2). */
export function allSlotsEmpty(slots: TeamPresetSlot[]): boolean {
  return slots.length > 0 && slots.every((s) => !s.snapshot);
}

/** Find a slot by number (slots may arrive unordered). */
export function slotByNumber(slots: TeamPresetSlot[], slot: number | null): TeamPresetSlot | undefined {
  if (slot == null) return undefined;
  return slots.find((s) => s.slot === slot);
}

/**
 * Team power (AC-B5) of a SAVED snapshot's starters, using the owned-player attribute pool. Players
 * missing from the pool (e.g. traded away) are skipped — same convention as the live editor bar.
 */
export function snapshotPower(snap: TeamSnapshot, playersById: Map<string, CatalogPlayer>): number {
  const attrs = (snap.starters ?? [])
    .map((s) => playersById.get(s.playerId)?.attributes)
    .filter((a): a is NonNullable<typeof a> => Boolean(a));
  return teamPower(attrs);
}

/** Compact display summary of a saved snapshot for the top card (요구 1). */
export interface PresetSummaryModel {
  formation: string;
  starterCount: number;
  power: number;
  tactics: TeamSnapshot["teamTactics"];
  teamPrompt: string;
}

export function snapshotSummary(
  snap: TeamSnapshot,
  playersById: Map<string, CatalogPlayer>,
): PresetSummaryModel {
  return {
    formation: snap.formation,
    starterCount: (snap.starters ?? []).length,
    power: snapshotPower(snap, playersById),
    tactics: snap.teamTactics,
    teamPrompt: snap.teamPrompt ?? "",
  };
}
