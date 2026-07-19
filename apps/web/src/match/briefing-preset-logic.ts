/**
 * Briefing preset picking (이슈 #98 요구 2 — "게임 시작 시엔 1/2/3 중 선택 → 그 위에 매치용 추가
 * 수정 → 진행"). Pure decision logic behind the compact `[1][2][3]` chip row embedded in the
 * briefing, kept out of the component so it is unit-testable.
 *
 * 설계: 브리핑 편집기는 **매치용 작업사본**이다. 프리셋 칩은 그 작업사본의 시작점을 고르는 것일
 * 뿐이라 `POST /api/presets/team/{slot}/apply`(활성 덱 교체)를 호출하지 않는다 — 킥오프의
 * `PUT /api/deck` 가 최종본을 영속하므로 매치 준비 중에 덱 화면의 활성 덱을 미리 오염시킬 이유가
 * 없다(프리셋 자체도 손대지 않는다).
 */
import type { TeamPresetSlot } from "../api/v2";
import { editorFingerprint } from "../deck/preset-selector-logic";
import { snapshotToEditor, type EditorState } from "../deck/tactics-logic";

export interface BriefingPresetChoice {
  slot: number;
  /** display name: saved name, `프리셋 N` fallback, or `비어 있음` for an empty slot. */
  name: string;
  /** only filled slots are selectable. */
  filled: boolean;
}

/** Slot chips for the briefing row, ordered 1..3 (server may return them unordered). */
export function briefingPresetChoices(slots: TeamPresetSlot[] | undefined): BriefingPresetChoice[] {
  return [...(slots ?? [])]
    .sort((a, b) => a.slot - b.slot)
    .map((s) => ({
      slot: s.slot,
      name: s.snapshot ? (s.name ?? `프리셋 ${s.slot}`) : "비어 있음",
      filled: Boolean(s.snapshot),
    }));
}

/**
 * Is the chip row worth showing at all? `GET /api/presets/team` always returns 3 slots, so a user
 * who never saved a preset would otherwise see three disabled "비어 있음" chips + a hint on every
 * briefing. Show the row only once at least one slot holds a snapshot.
 */
export function hasAnyPreset(choices: BriefingPresetChoice[]): boolean {
  return choices.some((c) => c.filled);
}

/** Editor state for a filled slot's snapshot; null when the slot is empty/unknown. */
export function presetEditorFor(
  slots: TeamPresetSlot[] | undefined,
  slot: number | null,
): EditorState | null {
  if (slot == null) return null;
  const src = (slots ?? []).find((s) => s.slot === slot);
  return src?.snapshot ? snapshotToEditor(src.snapshot) : null;
}

/** Fingerprint of the editor content at load time (reuses the deck screen's canonical serializer). */
export function briefingBaseline(editor: EditorState): string {
  return editorFingerprint(editor);
}

/** Has the user made match-only edits since the current start point was loaded? */
export function isMatchEditDirty(editor: EditorState, baseline: string): boolean {
  return editorFingerprint(editor) !== baseline;
}

export type PresetSelectionOutcome = "ignore" | "load" | "confirm";

/**
 * What a chip tap should do:
 *  - empty slot → `ignore` (chip is disabled anyway),
 *  - already-selected slot with no edits → `ignore` (reloading changes nothing),
 *  - unsaved match edits present → `confirm` (loading would discard them),
 *  - otherwise → `load`.
 */
export function selectionOutcome(params: {
  slots: TeamPresetSlot[] | undefined;
  slot: number;
  selectedSlot: number | null;
  dirty: boolean;
}): PresetSelectionOutcome {
  const src = (params.slots ?? []).find((s) => s.slot === params.slot);
  if (!src?.snapshot) return "ignore";
  if (params.dirty) return "confirm";
  if (params.selectedSlot === params.slot) return "ignore";
  return "load";
}
