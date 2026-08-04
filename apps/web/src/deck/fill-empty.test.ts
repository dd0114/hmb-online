import { describe, expect, it } from "vitest";
import { canFillEmptySlots, fillEmptySlots } from "./fill-empty";
import type { AutoPlayer } from "./auto-lineup";
import { BENCH_MAX, type DeckDraft, type DraftSlot, type Position } from "./deck-logic";

/**
 * `fillEmptySlots` 계약 (#439, hero 확정 Q1=ⓑ).
 *
 * 이 함수는 **화면 무관**이고, 두 화면의 차이는 오직 `candidates` 다:
 *   덱셋팅 → 보유 선수 전체(미배치) · 경기전 → 벤치 선수만(R2 제한이 후보 목록에서 나온다)
 *
 * 그래서 여기 계약의 절반은 "무엇을 하지 **않는가**"다 — 이미 놓인 선수·프롬프트·포메이션·
 * 팀 전술을 건드리지 않는 것이 hero 가 [초기화] 를 없애라고 한 이유와 같은 축이다.
 */

function attrs(overall: number) {
  return {
    technical: overall, mental: overall, physical: overall, passing: overall, shooting: overall,
    tackling: overall, pace: overall, stamina: overall, positioning: overall,
  };
}
const mk = (id: string, position: Position, overall: number): AutoPlayer => ({
  id, position, attributes: attrs(overall),
});

const slot = (playerId: string, role: "starter" | "bench", slotIndex: number, promptText: string | null = null): DraftSlot =>
  ({ playerId, role, slotIndex, promptText });

/** 4-4-2 · 선발 0..9 채움(슬롯 10 = FW 자리만 비어 있다) + 벤치 2명. */
function briefingDraft(): DeckDraft {
  return {
    formation: "4-4-2",
    slots: [
      slot("GK1", "starter", 0),
      slot("DF1", "starter", 1), slot("DF2", "starter", 2), slot("DF3", "starter", 3), slot("DF4", "starter", 4),
      slot("MF1", "starter", 5, "안쪽으로 파고들어라"),
      slot("MF2", "starter", 6), slot("MF3", "starter", 7), slot("MF4", "starter", 8),
      slot("FW1", "starter", 9),
      slot("FW2", "bench", 0, "교체로 들어가면 측면을 넓게 써라"),
      slot("GK2", "bench", 1),
    ],
  };
}
const BENCH_POOL = [mk("FW2", "FW", 72), mk("GK2", "GK", 62)];

const at = (d: DeckDraft, role: "starter" | "bench", i: number) =>
  d.slots.find((s) => s.role === role && s.slotIndex === i)?.playerId ?? null;

describe("fillEmptySlots — 빈 자리만 채운다(Q1=ⓑ)", () => {
  it("경기전(후보=벤치): 빈 선발 자리를 적합도 최고 벤치 선수로 채운다", () => {
    const next = fillEmptySlots(briefingDraft(), BENCH_POOL);
    // 슬롯 10 = FW 자리 → GK2(교차 감점)가 아니라 FW2 가 와야 한다.
    expect(at(next, "starter", 10)).toBe("FW2");
  });

  it("이미 놓인 선수는 자리도 프롬프트도 건드리지 않는다", () => {
    const before = briefingDraft();
    const next = fillEmptySlots(before, BENCH_POOL);
    for (const s of before.slots) {
      if (s.playerId === "FW2") continue; // 유일하게 이동한 선수(벤치 → 빈 선발 자리)
      const now = next.slots.find((n) => n.playerId === s.playerId);
      expect(now, `${s.playerId} 가 사라졌다`).toBeDefined();
      expect({ role: now!.role, slotIndex: now!.slotIndex }).toEqual({ role: s.role, slotIndex: s.slotIndex });
      expect(now!.promptText ?? null).toBe(s.promptText ?? null);
    }
  });

  it("올라간 선수의 프롬프트도 따라간다 — 지우지 않는다", () => {
    const next = fillEmptySlots(briefingDraft(), BENCH_POOL);
    const fw2 = next.slots.find((s) => s.playerId === "FW2")!;
    expect(fw2.role).toBe("starter");
    expect(fw2.promptText).toBe("교체로 들어가면 측면을 넓게 써라");
  });

  it("비워진 벤치 자리를 **이미 벤치에 앉은 선수로 다시 채우지 않는다**(재배치 금지)", () => {
    const next = fillEmptySlots(briefingDraft(), BENCH_POOL);
    expect(at(next, "bench", 0)).toBeNull(); // FW2 가 떠난 자리는 빈 채로
    expect(at(next, "bench", 1)).toBe("GK2"); // GK2 는 그대로
  });

  it("포메이션을 바꾸지 않는다", () => {
    expect(fillEmptySlots(briefingDraft(), BENCH_POOL).formation).toBe("4-4-2");
    expect(fillEmptySlots({ ...briefingDraft(), formation: "4-3-3" }, BENCH_POOL).formation).toBe("4-3-3");
  });

  it("채울 것이 없으면 **입력을 그대로 돌려준다**(같은 참조 = 무동작)", () => {
    // 경기전의 정상 상태: 선발 11 이 다 차 있고 후보(벤치)는 전부 이미 벤치에 앉아 있다.
    // 벤치 2..6 은 비어 있지만 **재배치는 하지 않으므로** 여기서 아무 일도 일어나면 안 된다.
    const full: DeckDraft = { ...briefingDraft(), slots: [...briefingDraft().slots, slot("FW3", "starter", 10)] };
    const next = fillEmptySlots(full, BENCH_POOL);
    expect(next).toBe(full);
    expect(canFillEmptySlots(full, BENCH_POOL)).toBe(false);
    expect(canFillEmptySlots(briefingDraft(), BENCH_POOL)).toBe(true);
  });

  it("후보가 비면 무동작 — 후보 목록이 곧 규칙이다(R2)", () => {
    const d = briefingDraft();
    expect(fillEmptySlots(d, [])).toBe(d);
    expect(canFillEmptySlots(d, [])).toBe(false);
  });

  it("빈 덱 + 보유 전체: 선발 11 + 벤치를 채우되 포메이션은 그대로", () => {
    const owned = [
      mk("GK1", "GK", 70), mk("GK2", "GK", 62),
      ...Array.from({ length: 5 }, (_, i) => mk(`DF${i + 1}`, "DF", 76 - i)),
      ...Array.from({ length: 6 }, (_, i) => mk(`MF${i + 1}`, "MF", 84 - i)),
      ...Array.from({ length: 4 }, (_, i) => mk(`FW${i + 1}`, "FW", 90 - i)),
    ];
    const next = fillEmptySlots({ formation: "4-4-2", slots: [] }, owned);
    expect(next.slots.filter((s) => s.role === "starter")).toHaveLength(11);
    expect(next.slots.filter((s) => s.role === "bench")).toHaveLength(Math.min(BENCH_MAX, owned.length - 11));
    expect(next.formation).toBe("4-4-2");
    // 진짜 GK 가 GK 자리에.
    expect(["GK1", "GK2"]).toContain(at(next, "starter", 0));
    // 자동 배치는 **프롬프트를 지어내지 않는다**(구 autoBuildLineup 은 전원에게 기본문구를 넣었다).
    expect(next.slots.every((s) => (s.promptText ?? null) === null)).toBe(true);
  });

  it("결정론 — 후보 순서를 섞어도 같은 결과", () => {
    const owned = [
      mk("A_GK", "GK", 70), mk("B_DF", "DF", 70), mk("C_MF", "MF", 70), mk("D_FW", "FW", 70),
      mk("E_MF", "MF", 70), mk("F_DF", "DF", 70),
    ];
    const base = fillEmptySlots({ formation: "4-4-2", slots: [] }, owned);
    const shuffled = fillEmptySlots({ formation: "4-4-2", slots: [] }, [...owned].reverse());
    expect(shuffled.slots).toEqual(base.slots);
  });

  it("후보에 이미 **선발**인 선수가 섞여 있어도 그를 옮기지 않는다(방어)", () => {
    const d = briefingDraft();
    // MF1 은 선발(슬롯 5)이다 — 후보로 들어와도 빈 자리로 끌려가면 안 된다.
    const next = fillEmptySlots(d, [mk("MF1", "MF", 99), ...BENCH_POOL]);
    expect(at(next, "starter", 5)).toBe("MF1");
    expect(at(next, "starter", 10)).toBe("FW2");
  });
});
