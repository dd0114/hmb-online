import { describe, it, expect } from "vitest";
import { effectiveGrade, GrowthState, CardEffective } from "./growth.js";

describe("effectiveGrade — limit_break 가 등급을 올린다", () => {
  it("돌파 0 = 원본 등급", () => {
    expect(effectiveGrade("BRONZE", 0)).toBe("BRONZE");
    expect(effectiveGrade("GOLD", 0)).toBe("GOLD");
  });
  it("돌파 1단계마다 다음 밴드", () => {
    expect(effectiveGrade("BRONZE", 1)).toBe("SILVER");
    expect(effectiveGrade("BRONZE", 2)).toBe("GOLD");
    expect(effectiveGrade("SILVER", 2)).toBe("DIA");
  });
  it("LEGEND 상한 클램프", () => {
    expect(effectiveGrade("DIA", 5)).toBe("LEGEND");
    expect(effectiveGrade("LEGEND", 3)).toBe("LEGEND");
  });
  it("음수 돌파 방어", () => {
    expect(effectiveGrade("GOLD", -1)).toBe("GOLD");
  });
});

describe("계약 zod 파싱", () => {
  it("GrowthState 왕복", () => {
    const s = {
      playerId: "P001", baseGrade: "BRONZE" as const, effectiveGrade: "SILVER" as const,
      enhanceLevel: 3, limitBreak: 1, matchXp: 900, growthLevel: 3, ovr: 58, completion: 0.82,
    };
    expect(GrowthState.parse(s)).toEqual(s);
  });
  it("completion 범위 밖 거부", () => {
    expect(() => CardEffective.parse({ completion: 1.5 } as never)).toThrow();
  });
});
