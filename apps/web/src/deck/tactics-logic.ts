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
 *  - target occupied AND player from the pool → the occupant is **demoted to the first empty
 *    bench slot**, and only dropped from the deck when the bench is full (#442 R4-B).
 * Prompt text always travels with its player.
 *
 * ⚠️ **밀려난 선수의 행선지 판정은 이 함수 한 곳에만 있다** (hero #442 R4-B:
 * *"벤치 자리있으면 벤치 벤치 자리없으면 빼자"*). 구 동작은 **무조건 덱에서 뺐다** — 빈 벤치 칸이
 * 남아 있어도 그 선수의 **프롬프트째** 사라졌고 되돌리기가 없었다(독립검증 minor-2). 화면은 그걸
 * "명단을 바꿨다"로 안내하고 있었으니 안내와 결과가 어긋나 있었다.
 *
 * ⛔ **`assignPlayer` 로 내리지 마라.** 그쪽은 저수준 원시연산이고 `fill-empty`(Auto)도 쓴다 —
 * 거기에 이 규칙을 적으면 소비자마다 같은 규칙을 상속받아 두 곳에서 해석된다(#439 major-2).
 * "맞바꾸기냐 밀어냄이냐"를 이미 소유한 자리가 여기다: 드래그 드롭·슬롯 탭·시트 선택이 전부 여기로 온다.
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

  if (occupant && occupant.playerId !== playerId && !source) {
    /*
     * 풀(스쿼드 밖) 선수가 찬 자리로 들어온다 — 밀려난 선수는 맞바꿀 자리가 없다.
     * 벤치에 빈칸이 있으면 거기로 내리고(프롬프트는 `assignPlayer` 가 같이 옮긴다),
     * 없으면 아래로 떨어져 구 동작(덱에서 제외)이 된다. 이것이 hero 가 고른 두 갈래 전부다.
     * ⚠️ 대상이 **벤치 슬롯**이어도 같다 — `firstEmptyBench` 는 찬 칸을 안 고르므로 그 자리와
     *    겹치지 않는다.
     */
    const benchIndex = firstEmptyBench(draft);
    if (benchIndex !== null) {
      const demoted = assignPlayer(draft, "bench", benchIndex, occupant.playerId);
      return assignPlayer(demoted, toRole, toSlotIndex, playerId);
    }
  }

  // empty target, or from-pool onto occupied with a full bench (drop occupant)
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
