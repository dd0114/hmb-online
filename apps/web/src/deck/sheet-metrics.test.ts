/**
 * 시트 바 3지표 계약 (이슈 #106 R1): 선발 n/11 · 벤치 n/7 · 지시 n/11.
 */
import { describe, expect, it } from "vitest";
import { sheetMetrics, slotPosition } from "./sheet-metrics";
import { emptyDraft, type DeckDraft, type DraftSlot } from "./deck-logic";

function draftOf(slots: DraftSlot[]): DeckDraft {
  return { ...emptyDraft(), slots };
}

const starter = (i: number, prompt?: string | null): DraftSlot => ({
  playerId: `S${i}`,
  role: "starter",
  slotIndex: i,
  promptText: prompt ?? null,
});

describe("sheetMetrics — 시트 바 3지표", () => {
  it("빈 덱은 0/11 · 0/7 · 0/11", () => {
    expect(sheetMetrics(emptyDraft())).toEqual({
      starters: 0, starterMax: 11, bench: 0, benchMax: 7, directives: 0, directiveMax: 11,
    });
  });

  it("선발·벤치 수를 각각 센다", () => {
    const d = draftOf([
      ...Array.from({ length: 11 }, (_, i) => starter(i)),
      { playerId: "B1", role: "bench", slotIndex: 0, promptText: null },
      { playerId: "B2", role: "bench", slotIndex: 1, promptText: null },
    ]);
    const m = sheetMetrics(d);
    expect(m.starters).toBe(11);
    expect(m.bench).toBe(2);
  });

  it("지시 = 선발 중 프롬프트가 실제로 있는 수 (공백만 있으면 미집계)", () => {
    const d = draftOf([
      starter(0, "과감하게 슛"),
      starter(1, "   "),
      starter(2, ""),
      starter(3, null),
      starter(4, "뒷공간 침투"),
    ]);
    expect(sheetMetrics(d).directives).toBe(2);
  });

  it("벤치 프롬프트는 지시 지표에 들어가지 않는다 (분모 11 = 선발)", () => {
    const d = draftOf([
      starter(0, "지시"),
      { playerId: "B1", role: "bench", slotIndex: 0, promptText: "벤치 지시" },
    ]);
    const m = sheetMetrics(d);
    expect(m.directives).toBe(1);
    expect(m.directiveMax).toBe(11);
  });
});

describe("slotPosition — 슬롯이 요구하는 포지션", () => {
  it("4-4-2 선발 슬롯의 포메이션 행 라벨을 돌려준다", () => {
    expect(slotPosition("4-4-2", "starter", 0)).toBe("GK");
    expect(slotPosition("4-4-2", "starter", 2)).toBe("DF");
    expect(slotPosition("4-4-2", "starter", 6)).toBe("MF");
    expect(slotPosition("4-4-2", "starter", 10)).toBe("FW");
  });

  it("4-3-3 은 다른 배분을 따른다", () => {
    expect(slotPosition("4-3-3", "starter", 8)).toBe("FW");
    expect(slotPosition("4-3-3", "starter", 7)).toBe("MF");
  });

  it("벤치·미상 포메이션·범위 밖은 null (필터 제한 없음)", () => {
    expect(slotPosition("4-4-2", "bench", 0)).toBeNull();
    expect(slotPosition("4-4-2", "starter", 99)).toBeNull();
    // 미상 포메이션은 기본 포메이션 레이아웃으로 폴백
    expect(slotPosition("9-9-9", "starter", 0)).toBe("GK");
  });
});
