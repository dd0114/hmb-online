import { describe, it, expect } from "vitest";
import { validateCoachOutput } from "./coach.js";
import { makeTacticalInput } from "@hmb/engine";

// 검증 게이트(가드레일) — executor(AI) 무관 공통. 키/네트워크 0.
describe("coach — validateCoachOutput (검증 게이트)", () => {
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
