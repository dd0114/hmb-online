import { describe, it, expect } from "vitest";
import { CardEffective, DiceRollResult, PotentialLine, StarUpResult } from "./growth.js";

const attrs = {
  technical: 60, mental: 60, physical: 60, passing: 60, shooting: 60,
  tackling: 60, pace: 60, stamina: 60, positioning: 60,
};

describe("성장 계약 v2 (메이플 피벗) zod", () => {
  it("PotentialLine 왕복 — STAT_PCT 는 stat 포함", () => {
    const l = { slot: 1, tier: "EPIC" as const, type: "STAT_PCT" as const, stat: "shooting", value: 4 };
    expect(PotentialLine.parse(l)).toEqual(l);
  });
  it("팀/컨디션 훅 옵션은 stat 없이 허용", () => {
    expect(() => PotentialLine.parse({ slot: 2, tier: "RARE", type: "TEAM_MORALE", value: 3 })).not.toThrow();
  });
  it("CardEffective 왕복 — 안 ㄴ 형태(골드 3★ 에픽 2줄)", () => {
    const c = {
      playerId: "P010", grade: "GOLD" as const, star: 3,
      attributes: attrs, prePotential: attrs, base: attrs, caps: attrs,
      statLevels: { shooting: { lv: 3, xp: 120 } },
      potential: {
        unlocked: true, tier: "EPIC" as const, maxTier: "EPIC" as const,
        lines: [
          { slot: 1, tier: "EPIC" as const, type: "STAT_PCT" as const, stat: "shooting", value: 4 },
          { slot: 2, tier: "RARE" as const, type: "STAT_FLAT" as const, stat: "pace", value: 2 },
        ],
        rollsSinceTierUp: 7, ceilingAt: 84,
      },
      ovr: 71.2, completion: 0.4,
    };
    expect(CardEffective.parse(c)).toEqual(c);
  });
  it("성 범위 1~4 강제", () => {
    expect(() => StarUpResult.parse({ playerId: "P1", star: 5, spentCopies: 5, potentialUnlocked: false, maxTier: "UNIQUE" })).toThrow();
  });
  it("DiceRollResult — 랙칫 표현(티어 하락 없음은 서버 불변식, 계약은 필드만)", () => {
    const r = {
      playerId: "P1", kind: "NORMAL" as const, tierBefore: "RARE" as const, tierAfter: "EPIC" as const,
      tierUp: true, byCeiling: false, lines: [], rollsSinceTierUp: 0, ceilingAt: 25, diceLeft: 3,
    };
    expect(DiceRollResult.parse(r)).toEqual(r);
  });
});
