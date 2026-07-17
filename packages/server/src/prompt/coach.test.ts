import { describe, it, expect } from "vitest";
import { buildTeamInputPrompt, validateTeamInputOutput, tacticalJsonSchema } from "./coach.js";
import { stubExecutor } from "../executor/executors/stub.js";
import { makeTeamInputContext } from "../executor/test-fixtures.js";

// 프롬프트 빌더 + 검증 게이트(가드레일) — executor(AI) 무관 공통. 키/네트워크 0.
describe("coach — buildTeamInputPrompt (W1: playerPrompts·prevSummary 반영)", () => {
  it("로스터(능력치)·포메이션·팀 지시가 프롬프트에 들어간다", () => {
    const ctx = makeTeamInputContext({ teamPrompt: "하이라인·강한 압박" });
    const p = buildTeamInputPrompt(ctx);
    expect(p).toContain("4-3-3");
    expect(p).toContain("H0"); // 로스터 playerId
    expect(p).toContain("Home GK"); // 로스터 이름
    expect(p).toMatch(/tech \d+\/mental \d+\/phys \d+/); // 능력치 라인
    expect(p).toContain("하이라인·강한 압박"); // 팀 지시
  });

  it("선수별 개인 지시(playerPrompts)가 프롬프트에 나열된다", () => {
    const ctx = makeTeamInputContext({
      playerPrompts: { H9: "적극 침투해라", H1: "오버랩 자제", H5: "   " }, // 공백은 제외
    });
    const p = buildTeamInputPrompt(ctx);
    expect(p).toContain("선수별 개인 지시");
    expect(p).toContain("- H9: 적극 침투해라");
    expect(p).toContain("- H1: 오버랩 자제");
    expect(p).not.toContain("- H5:"); // 빈 지시는 생략
  });

  it("half=2 + prevSummary → 전반 요약 섹션 포함(half=1 은 없음)", () => {
    const h2 = makeTeamInputContext({
      half: 2,
      prevSummary: { scoreHome: 1, scoreAway: 2, shots: 9, possessionHint: "away 우세" },
    });
    const p2 = buildTeamInputPrompt(h2);
    expect(p2).toContain("전반 결과 요약");
    expect(p2).toContain("home 1 : 2 away");
    expect(p2).toContain("away 우세");

    const p1 = buildTeamInputPrompt(makeTeamInputContext());
    expect(p1).not.toContain("전반 결과 요약");
  });

  it("feedback(재시도 사유)이 프롬프트 말미에 포함된다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext(), "선수는 11명이어야 함 (got 10)");
    expect(p).toContain("이전 산출 거부됨");
    expect(p).toContain("11명");
  });

  it("tacticalJsonSchema: TacticalInput JSON Schema 파생($schema 제거)", () => {
    const s = tacticalJsonSchema();
    expect(s["type"]).toBe("object");
    expect(s["$schema"]).toBeUndefined();
  });
});

describe("coach — validateTeamInputOutput (검증 게이트)", () => {
  const ctx = makeTeamInputContext();

  async function validStubOutput(): Promise<unknown> {
    return stubExecutor().execute({ id: "j1", kind: "team-input", context: ctx });
  }

  it("유효 산출(stub)은 검증·클램프 통과(11명·로스터 id 정합)", async () => {
    const out = validateTeamInputOutput(await validStubOutput(), ctx);
    expect(out.players).toHaveLength(11);
    const rosterIds = new Set(ctx.roster.map((r) => r.playerId));
    for (const p of out.players) expect(rosterIds.has(p.playerId)).toBe(true);
  });

  it("범위 밖 수치는 [0,1]/[-1,1] 로 클램프", async () => {
    const bad = structuredClone(await validStubOutput()) as Record<string, any>;
    bad["players"][9].behavior.shootTendency = 5; // >1
    bad["team"].tempo = -3; // <0
    bad["players"][1].mentalModifier = 9; // >1
    const out = validateTeamInputOutput(bad, ctx);
    expect(out.players[9]!.behavior.shootTendency).toBe(1);
    expect(out.team.tempo).toBe(0);
    expect(out.players[1]!.mentalModifier).toBe(1);
  });

  it("선수가 11명이 아니면 throw", async () => {
    const bad = structuredClone(await validStubOutput()) as Record<string, any>;
    bad["players"].pop();
    expect(() => validateTeamInputOutput(bad, ctx)).toThrow(/11명/);
  });

  it("로스터에 없는 playerId 면 throw", async () => {
    const bad = structuredClone(await validStubOutput()) as Record<string, any>;
    bad["players"][0].playerId = "P999";
    expect(() => validateTeamInputOutput(bad, ctx)).toThrow(/로스터에 없는/);
  });

  it("playerId 중복(로스터 전원 미포함)이면 throw", async () => {
    const bad = structuredClone(await validStubOutput()) as Record<string, any>;
    bad["players"][1].playerId = bad["players"][0].playerId; // 중복
    expect(() => validateTeamInputOutput(bad, ctx)).toThrow(/중복/);
  });

  it("스키마 형태가 깨지면(필수 필드 누락) throw", () => {
    expect(() => validateTeamInputOutput({ seed: "42" }, ctx)).toThrow();
  });
});
