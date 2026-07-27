import { describe, it, expect } from "vitest";
import {
  TeamInputJobContext,
  TeamInputPatchJobContext,
  Personality,
  ManualTactics,
  PromptDelta,
} from "./team-input-job.js";

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

/**
 * PromptDelta additive 계약 (#193 W2b-B3).
 * Java(server-java)가 감독시간 편집분에서 만들어 싣는 JSON 이 이 스키마를 통과해야 한다.
 * 구계약(promptDelta 없는 patch 컨텍스트)은 그대로 파싱 — 후방 호환.
 */
describe("TeamInputPatchJobContext.promptDelta — additive 계약", () => {
  /** 최소 유효 TacticalInput(base) — 11명, 로스터 id 정합. */
  const baseTactical = {
    seed: "42",
    team: {
      formation: "4-3-3",
      defensiveLineHeight: 0.55,
      compactness: 0.5,
      tempo: 0.5,
      width: 0.55,
      pressingScheme: { intensity: 0.55, triggerLine: 0.5 },
      offsideTrap: false,
    },
    players: Array.from({ length: 11 }, (_, i) => ({
      playerId: `H${i}`,
      role: "MF",
      duty: "support" as const,
      basePosition: { x: 0.1 * i, y: 0.05 * i },
      behavior: {
        positioningFreedom: 0.5,
        forwardRunFreq: 0.5,
        widthTendency: 0.5,
        supportDepth: 0.5,
        pressAggression: 0.5,
        passRisk: 0.5,
        passDirectness: 0.5,
        dribbleTendency: 0.5,
        shootTendency: 0.5,
      },
      mentalModifier: 0,
    })),
  };
  const patchBase = { ...base, kind: "team-input-patch" as const, base: baseTactical };

  it("promptDelta 없이(구계약) 파싱된다 — additive optional", () => {
    const parsed = TeamInputPatchJobContext.parse(patchBase);
    expect(parsed.promptDelta).toBeUndefined();
  });

  it("Java 가 만들 JSON 형태(팀 수정 + 선수 신규/수정/삭제)가 라운드트립한다", () => {
    const json = {
      ...patchBase,
      promptDelta: {
        team: { old: "전방압박 강하게", new: "수비적으로 전환, 라인 내려" },
        players: {
          H9: { old: "적극 침투", new: "상대 CB 뒤 공간만 노려라" }, // 수정
          H2: { new: "A9 전담 마크" }, // 신규(old 없음)
          H3: { old: "오버랩 자제" }, // 삭제(new 없음)
        },
      },
    };
    const parsed = TeamInputPatchJobContext.parse(json);
    expect(parsed.promptDelta?.team).toEqual({ old: "전방압박 강하게", new: "수비적으로 전환, 라인 내려" });
    expect(parsed.promptDelta?.players?.["H2"]).toEqual({ new: "A9 전담 마크" });
    expect(parsed.promptDelta?.players?.["H3"]).toEqual({ old: "오버랩 자제" });
    // 직렬화 라운드트립(Java ↔ TS JSON 왕복 동일)
    expect(TeamInputPatchJobContext.parse(JSON.parse(JSON.stringify(parsed))).promptDelta).toEqual(
      parsed.promptDelta,
    );
  });

  it("PromptDelta 단독 파싱: 빈 오브젝트 허용, team 은 old/new 둘 다 필수", () => {
    expect(PromptDelta.parse({})).toEqual({});
    expect(() => PromptDelta.parse({ team: { new: "only-new" } })).toThrow(); // 팀은 수정만
    expect(() => PromptDelta.parse({ players: { H1: { old: 1 } } })).toThrow(); // 타입 강제
  });

  it("기존 필드는 무변경 — promptDelta 를 얹어도 base/roster/prompts 는 그대로", () => {
    const parsed = TeamInputPatchJobContext.parse({
      ...patchBase,
      promptDelta: { team: { old: "a", new: "b" } },
    });
    expect(parsed.base.players).toHaveLength(11);
    expect(parsed.roster).toHaveLength(11);
    expect(parsed.kind).toBe("team-input-patch");
  });
});
