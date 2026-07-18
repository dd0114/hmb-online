import { describe, it, expect } from "vitest";
import { TeamInputJobContext, Personality, ManualTactics } from "./team-input-job.js";

/**
 * TeamInputJobContext Phase2 additive 계약 (AC-C4, P2-D7/D8).
 * 신필드는 전부 optional → **구계약(신필드 없는 컨텍스트)도 그대로 파싱**되어야 한다.
 * 필드명·형태는 openapi-v2 `AiJobContextPhase2Fields` 와 1:1.
 */

const base = {
  kind: "team-input" as const,
  matchId: "m1",
  side: "home" as const,
  half: 1 as const,
  seed: "42",
  formation: "4-3-3",
  roster: Array.from({ length: 11 }, (_, i) => ({
    playerId: `H${i}`,
    name: `Home ${i}`,
    position: "MF",
    attributes: {
      technical: 60,
      mental: 60,
      physical: 60,
      passing: 60,
      shooting: 60,
      tackling: 60,
      pace: 60,
      stamina: 60,
      positioning: 60,
    },
    slotIndex: i,
  })),
  teamPrompt: "",
  playerPrompts: {},
};

describe("TeamInputJobContext — Phase2 additive 호환", () => {
  it("신필드 없이(구계약) 파싱된다 — additive optional", () => {
    const parsed = TeamInputJobContext.parse(base);
    expect(parsed.manualTactics).toBeUndefined();
    expect(parsed.conditions).toBeUndefined();
    expect(parsed.relations).toBeUndefined();
    expect(parsed.teamMorale).toBeUndefined();
  });

  it("신필드 전부 제공 시 필드명 자구 그대로 파싱된다(openapi 1:1)", () => {
    const parsed = TeamInputJobContext.parse({
      ...base,
      manualTactics: { line: 0.8, press: 0.6, tempo: 0.5, width: 0.4 },
      conditions: { H0: 0.9, H1: 0.3 },
      relations: { H0: { trust: 82, personality: "AMBITIOUS" }, H1: { trust: 20, personality: "GLASS" } },
      teamMorale: { morale: 72, streak: 3 },
    });
    expect(parsed.manualTactics).toEqual({ line: 0.8, press: 0.6, tempo: 0.5, width: 0.4 });
    expect(parsed.conditions?.H0).toBe(0.9);
    expect(parsed.relations?.H1?.personality).toBe("GLASS");
    expect(parsed.teamMorale).toEqual({ morale: 72, streak: 3 });
  });

  it("Personality 는 4종 enum(FIERY/CALM/GLASS/AMBITIOUS)", () => {
    expect(Personality.options).toEqual(["FIERY", "CALM", "GLASS", "AMBITIOUS"]);
    expect(() => Personality.parse("HOTHEAD")).toThrow();
  });

  it("manualTactics 는 각 축 0..1 범위 강제(openapi TeamTactics 정합)", () => {
    expect(() => ManualTactics.parse({ line: 1.5, press: 0.5, tempo: 0.5, width: 0.5 })).toThrow();
    expect(() => ManualTactics.parse({ line: 0.5, press: 0.5, tempo: 0.5 })).toThrow(); // width 누락
  });

  it("relations.trust 는 0..100 정수, teamMorale.streak 는 정수(음수=연패)", () => {
    expect(() =>
      TeamInputJobContext.parse({ ...base, relations: { H0: { trust: 120, personality: "CALM" } } }),
    ).toThrow();
    const neg = TeamInputJobContext.parse({ ...base, teamMorale: { morale: 30, streak: -4 } });
    expect(neg.teamMorale?.streak).toBe(-4);
  });
});
