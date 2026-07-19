/**
 * 탭-투-플레이스 = 1급 배치 수단 계약 (이슈 #106 R1).
 * 슬롯 탭 → 필터 → 선수 탭 → 배치 / 역방향 동일 / 토큰↔토큰 = 자리 교체.
 */
import { describe, expect, it } from "vitest";
import { autoFilterFor, NO_SELECTION, tapPoolPlayer, tapSlot } from "./tap-place";
import { emptyDraft, getSlot, type DeckDraft } from "./deck-logic";

const empty = (): DeckDraft => emptyDraft("4-4-2");

describe("정방향: 슬롯 탭 → 리스트 필터 → 선수 탭 → 배치", () => {
  it("빈 슬롯 탭은 그 슬롯을 배치 타깃으로 강조한다(덱은 그대로)", () => {
    const d = empty();
    const r = tapSlot(d, NO_SELECTION, { role: "starter", slotIndex: 6 });
    expect(r.draft).toBe(d);
    expect(r.selection.slot).toEqual({ role: "starter", slotIndex: 6 });
    expect(r.selection.playerId).toBeNull();
  });

  it("타깃 슬롯의 포지션으로 리스트가 자동 필터된다", () => {
    const r = tapSlot(empty(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    expect(autoFilterFor(empty(), r.selection)).toBe("MF");
    const gk = tapSlot(empty(), NO_SELECTION, { role: "starter", slotIndex: 0 });
    expect(autoFilterFor(empty(), gk.selection)).toBe("GK");
  });

  it("선택 없음 / 벤치 타깃이면 필터는 ALL", () => {
    expect(autoFilterFor(empty(), NO_SELECTION)).toBe("ALL");
    const b = tapSlot(empty(), NO_SELECTION, { role: "bench", slotIndex: 0 });
    expect(autoFilterFor(empty(), b.selection)).toBe("ALL");
  });

  it("타깃이 잡힌 상태에서 선수 탭 → 그 슬롯에 배치되고 레일이 그 선수로 전환", () => {
    const t = tapSlot(empty(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    const r = tapPoolPlayer(t.draft, t.selection, "P1");
    expect(getSlot(r.draft, "starter", 6)?.playerId).toBe("P1");
    expect(r.selection.slot).toBeNull();
    expect(r.selection.playerId).toBe("P1");
    expect(r.selection.source).toBe("board");
  });

  it("같은 빈 슬롯을 다시 탭하면 타깃이 해제된다", () => {
    const t = tapSlot(empty(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    const r = tapSlot(t.draft, t.selection, { role: "starter", slotIndex: 6 });
    expect(r.selection).toEqual(NO_SELECTION);
  });
});

describe("역방향: 선수 먼저 탭 → 슬롯 탭 → 배치", () => {
  it("리스트 선수 첫 탭은 배치하지 않고 들고 있는 상태가 된다", () => {
    const d = empty();
    const r = tapPoolPlayer(d, NO_SELECTION, "P1");
    expect(r.draft).toBe(d);
    expect(r.selection.playerId).toBe("P1");
    expect(r.selection.source).toBe("pool");
  });

  it("들고 있는 상태에서 슬롯 탭 → 배치", () => {
    const a = tapPoolPlayer(empty(), NO_SELECTION, "P1");
    const b = tapSlot(a.draft, a.selection, { role: "starter", slotIndex: 10 });
    expect(getSlot(b.draft, "starter", 10)?.playerId).toBe("P1");
    expect(b.selection.playerId).toBe("P1");
  });

  it("같은 선수를 다시 탭하면 해제된다(빈 슬롯·토큰 재탭과 대칭)", () => {
    const a = tapPoolPlayer(empty(), NO_SELECTION, "P1");
    const b = tapPoolPlayer(a.draft, a.selection, "P1");
    expect(b.selection).toEqual(NO_SELECTION);
    expect(b.draft.slots).toHaveLength(0);
  });

  it("다른 선수를 탭하면 그 선수로 바뀐다(취소는 다른 행 탭 또는 레일 닫기)", () => {
    const a = tapPoolPlayer(empty(), NO_SELECTION, "P1");
    const b = tapPoolPlayer(a.draft, a.selection, "P2");
    expect(b.selection.playerId).toBe("P2");
    expect(b.selection.source).toBe("pool");
  });
});

describe("보드 토큰 탭", () => {
  const placed = (): DeckDraft => ({
    formation: "4-4-2",
    slots: [
      { playerId: "A", role: "starter", slotIndex: 6, promptText: null },
      { playerId: "B", role: "starter", slotIndex: 10, promptText: null },
    ],
  });

  it("토큰 탭 → 그 선수가 선택된다(레일 컨텍스트 전환, 배치 변화 없음)", () => {
    const d = placed();
    const r = tapSlot(d, NO_SELECTION, { role: "starter", slotIndex: 6 });
    expect(r.draft).toBe(d);
    expect(r.selection.playerId).toBe("A");
    expect(r.selection.source).toBe("board");
  });

  it("토큰 → 빈 슬롯 탭 = 이동", () => {
    const a = tapSlot(placed(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    const b = tapSlot(a.draft, a.selection, { role: "starter", slotIndex: 5 });
    expect(getSlot(b.draft, "starter", 5)?.playerId).toBe("A");
    expect(getSlot(b.draft, "starter", 6)).toBeUndefined();
  });

  it("토큰 → 토큰 탭 = 자리 교체(둘 다 남는다)", () => {
    const a = tapSlot(placed(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    const b = tapSlot(a.draft, a.selection, { role: "starter", slotIndex: 10 });
    expect(getSlot(b.draft, "starter", 10)?.playerId).toBe("A");
    expect(getSlot(b.draft, "starter", 6)?.playerId).toBe("B");
    expect(b.draft.slots).toHaveLength(2);
  });

  /**
   * R2 r1: 예전 계약("재탭 = 해제")을 뒤집는다. 재탭이 해제였을 때는 **방금 배치한 선수의 토큰을
   * 한 번 탭하면 지시가 열리는 게 아니라 팀 지시로 튕겼다**(배치 후 선택이 남아 있으므로 재탭으로
   * 취급됨). 지시 넣기가 가장 흔한 다음 동작이라 이쪽을 우선한다.
   */
  it("선택된 토큰을 다시 탭해도 그 선수 선택이 유지된다(지시가 열린 채, r1)", () => {
    const a = tapSlot(placed(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    const b = tapSlot(a.draft, a.selection, { role: "starter", slotIndex: 6 });
    expect(b.selection.playerId).toBe("A");
    expect(b.selection.source).toBe("board");
    expect(b.draft).toBe(a.draft);
    expect(getSlot(b.draft, "starter", 6)?.playerId).toBe("A");
  });

  it("리스트에서 배치한 직후 그 토큰을 **한 번** 탭하면 그 선수 지시가 열린다(r1 회귀)", () => {
    // 리스트 선수 집어듦 → 빈 슬롯 탭 = 배치. 여기서 선택은 그 선수로 남는다.
    const held = tapPoolPlayer(empty(), NO_SELECTION, "P1");
    const placedOne = tapSlot(held.draft, held.selection, { role: "starter", slotIndex: 6 });
    expect(placedOne.selection.playerId).toBe("P1");
    // 이어서 그 토큰을 탭 — 예전엔 여기서 해제(팀 지시)로 튕겼다.
    const tapped = tapSlot(placedOne.draft, placedOne.selection, { role: "starter", slotIndex: 6 });
    expect(tapped.selection.playerId).toBe("P1");
    expect(tapped.selection.source).toBe("board");
  });

  it("토큰 → 벤치 빈칸 탭 = 벤치로 내림", () => {
    const a = tapSlot(placed(), NO_SELECTION, { role: "starter", slotIndex: 6 });
    const b = tapSlot(a.draft, a.selection, { role: "bench", slotIndex: 0 });
    expect(getSlot(b.draft, "bench", 0)?.playerId).toBe("A");
    expect(getSlot(b.draft, "starter", 6)).toBeUndefined();
  });

  it("프롬프트는 선수를 따라 이동한다", () => {
    const d: DeckDraft = {
      formation: "4-4-2",
      slots: [{ playerId: "A", role: "starter", slotIndex: 6, promptText: "침투해라" }],
    };
    const a = tapSlot(d, NO_SELECTION, { role: "starter", slotIndex: 6 });
    const b = tapSlot(a.draft, a.selection, { role: "starter", slotIndex: 10 });
    expect(getSlot(b.draft, "starter", 10)?.promptText).toBe("침투해라");
  });
});
