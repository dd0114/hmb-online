import { describe, it, expect } from "vitest";
import { buildCoachMessages, validateCoachOutput, COACH_SYSTEM } from "./coach.js";
import { makeTacticalInput } from "@hmb/engine";

// 코치의 순수 경로(프롬프트 구성 + 검증/클램프) 테스트 — Claude 호출 없음(키 불필요).
// 라이브 프롬프트→움직임 패리티(AC3)는 별도 키-게이트 테스트에서.

describe("coach — buildCoachMessages", () => {
  it("roster·seed·directive 를 user 프롬프트에 담고 system 은 고정", () => {
    const { system, user } = buildCoachMessages({
      directive: "풀백 오버랩·와이드",
      rosterContext: "H0 GK(0.05,0.5)",
      seed: "4815162342",
      prefix: "H",
    });
    expect(system).toBe(COACH_SYSTEM);
    expect(user).toContain("풀백 오버랩·와이드");
    expect(user).toContain("H0 GK(0.05,0.5)");
    expect(user).toContain("4815162342");
  });
});

describe("coach — validateCoachOutput (가드레일)", () => {
  it("유효 입력은 검증·클램프 통과(11명 유지)", () => {
    const out = validateCoachOutput(makeTacticalInput("H", "42"), "H");
    expect(out.players).toHaveLength(11);
  });

  it("범위 밖 수치는 [0,1]/[-1,1] 로 클램프", () => {
    const bad = structuredClone(makeTacticalInput("H", "42")) as Record<string, any>;
    bad["players"][9].behavior.shootTendency = 5; // >1
    bad["team"].tempo = -3; // <0
    bad["players"][1].mentalModifier = 9; // >1
    const out = validateCoachOutput(bad, "H");
    expect(out.players[9]!.behavior.shootTendency).toBe(1);
    expect(out.team.tempo).toBe(0);
    expect(out.players[1]!.mentalModifier).toBe(1);
  });

  it("선수가 11명이 아니면 throw", () => {
    const bad = structuredClone(makeTacticalInput("H", "42")) as Record<string, any>;
    bad["players"].pop();
    expect(() => validateCoachOutput(bad, "H")).toThrow(/11명/);
  });

  it("playerId prefix 불일치면 throw", () => {
    expect(() => validateCoachOutput(makeTacticalInput("A", "42"), "H")).toThrow(/prefix/);
  });

  it("스키마 형태가 깨지면(필수 필드 누락) throw", () => {
    expect(() => validateCoachOutput({ seed: "42" }, "H")).toThrow();
  });
});
