/**
 * 탭-투-플레이스 상태기계 (이슈 #106 R1) — 순수/결정론.
 *
 * #106: **전술보드가 SoT**다. 배치는 보드에서 시작해 보드로 수렴해야 하고, 드래그는 보조 수단일
 * 뿐 1급 배치 수단은 **탭**이다(폰에서 드래그가 실패했던 이력 — #106 결함 항목).
 *
 * 계약(양방향 2탭):
 *   1) 빈 슬롯 탭 → 그 슬롯이 배치 타깃으로 강조되고, 리스트는 그 슬롯 포지션 추천순으로 자동 필터.
 *      이어서 선수를 탭하면 그 슬롯에 배치된다.
 *   2) 역방향도 동일: 리스트 선수 탭 → 그 선수가 "들고 있는" 상태(pending)로 강조 → 슬롯 탭 → 배치.
 *   3) 보드 토큰 탭 → 그 선수가 선택(레일이 그 선수 지시로 전환) + 이동 소스가 된다.
 *      이어서 다른 슬롯을 탭하면 이동, 다른 토큰을 탭하면 **자리 교체**(movePlayerToSlot swap).
 *   4) 같은 대상을 다시 탭하면 선택 해제(토글).
 *
 * 선택(selection)은 레일의 컨텍스트이기도 하다 — playerId 가 있으면 그 선수 지시, 없으면 팀 지시.
 */
import { getSlot, type DeckDraft, type Position } from "./deck-logic";
import { slotPosition } from "./sheet-metrics";
import { movePlayerToSlot } from "./tactics-logic";
import type { SlotRef } from "./TacticsBoard";

export type TapSource = "board" | "pool";

export interface TapSelection {
  /** 배치 타깃으로 강조된 슬롯 (선수 탭을 기다리는 상태) */
  slot: SlotRef | null;
  /** 레일 컨텍스트 = 선택된 선수 (보드 토큰이거나, 배치 대기 중인 리스트 선수) */
  playerId: string | null;
  source: TapSource | null;
}

export interface TapResult {
  draft: DeckDraft;
  selection: TapSelection;
}

export const NO_SELECTION: TapSelection = { slot: null, playerId: null, source: null };

function sameSlot(a: SlotRef | null, b: SlotRef): boolean {
  return a != null && a.role === b.role && a.slotIndex === b.slotIndex;
}

/** 리스트 자동 필터: 타깃 슬롯이 있으면 그 포지션, 없으면 ALL. */
export function autoFilterFor(draft: DeckDraft, sel: TapSelection): Position | "ALL" {
  if (!sel.slot) return "ALL";
  return slotPosition(draft.formation, sel.slot.role, sel.slot.slotIndex) ?? "ALL";
}

/** 보드 슬롯(빈칸 또는 토큰) 탭. */
export function tapSlot(draft: DeckDraft, sel: TapSelection, slot: SlotRef): TapResult {
  const occupant = getSlot(draft, slot.role, slot.slotIndex);

  // (2)(3) 들고 있는 선수가 있으면 → 이 슬롯에 배치/이동/교체
  if (sel.playerId) {
    const holding = sel.playerId;
    if (occupant?.playerId === holding) {
      // R2 r1 (UX 마찰 수정): 자기 자신 재탭은 **해제가 아니라 그 선수 지시 유지**다.
      // 예전엔 여기서 NO_SELECTION 을 돌려줬는데, 방금 배치한 선수는 이미 선택 상태로 남아 있어
      // "이 선수에게 지시 넣자"는 가장 직관적인 제스처(토큰 탭)가 **팀 지시로 튕기고** 한 번 더
      // 탭해야 열렸다(모바일 독은 접힌 채라 더 헛돌았다). 이제 한 번 탭이면 항상 그 선수다.
      // 해제는 레일 ×(rail-close) · 보드 바 [선택 해제](select-clear) · 배치 대기 [취소] 로 한다.
      return { draft, selection: { slot, playerId: holding, source: "board" } };
    }
    return {
      draft: movePlayerToSlot(draft, holding, slot.role, slot.slotIndex),
      selection: { slot: null, playerId: holding, source: "board" },
    };
  }

  // (3) 토큰 탭 → 그 선수 선택(레일 전환 + 이동 소스)
  if (occupant) {
    return { draft, selection: { slot, playerId: occupant.playerId, source: "board" } };
  }

  // (1) 빈 슬롯 탭 → 배치 타깃 (재탭이면 해제)
  if (sameSlot(sel.slot, slot)) return { draft, selection: NO_SELECTION };
  return { draft, selection: { slot, playerId: null, source: null } };
}

/** 보유 선수 리스트 행 탭. */
export function tapPoolPlayer(draft: DeckDraft, sel: TapSelection, playerId: string): TapResult {
  // (1) 타깃 슬롯이 잡혀 있으면 즉시 배치
  if (sel.slot) {
    return {
      draft: movePlayerToSlot(draft, playerId, sel.slot.role, sel.slot.slotIndex),
      selection: { slot: null, playerId, source: "board" },
    };
  }
  // (4) 같은 행 재탭 → 해제. 빈 슬롯 재탭(타깃 해제)·토큰 재탭(선택 해제)과 **대칭**이다.
  if (sel.playerId === playerId && sel.source === "pool") return { draft, selection: NO_SELECTION };
  // (2) 역방향 첫 탭 → 들고 있는 상태
  return { draft, selection: { slot: null, playerId, source: "pool" } };
}
