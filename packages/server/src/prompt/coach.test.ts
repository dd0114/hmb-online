import { describe, it, expect } from "vitest";
import { FORMATION_BASE_POSITIONS } from "@hmb/shared";
import { buildTeamInputPrompt, validateTeamInputOutput, tacticalJsonSchema } from "./coach.js";
import { stubExecutor } from "../executor/executors/stub.js";
import { makeTeamInputContext, makeOpponentRoster } from "../executor/test-fixtures.js";

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

  it("지시 카탈로그(지원 지시) 섹션이 프롬프트에 합성된다", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).toContain("지원 지시 카탈로그");
    expect(p).toContain("id: marking");
    expect(p).toContain("id: overlap");
    expect(p).toContain("id: tempo-control");
  });

  it("opponentRoster 없으면 상대 로스터 블록만 생략(카탈로그 고정 문구는 유지)", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).not.toContain("상대 로스터(마킹 대상 해석용");
    // 카탈로그의 필요 컨텍스트 문구는 요청 무관 고정(단일 변형) — 제공 여부는 가변부 블록으로만 전달.
    expect(p).toContain("필요 컨텍스트: opponentRoster");
    expect(p).not.toContain("미제공");
  });

  it("opponentRoster 제공 시 상대 로스터 블록(이름→playerId)이 포함되고 카탈로그 문구는 동일", () => {
    const opponentRoster = makeOpponentRoster();
    const p = buildTeamInputPrompt(makeTeamInputContext({ opponentRoster }));
    expect(p).toContain("상대 로스터(마킹 대상 해석용");
    expect(p).toContain("A9 Away ST"); // 상대 playerId + 이름
    expect(p).toContain("필요 컨텍스트: opponentRoster");
    expect(p).not.toContain("미제공");
  });

  it("tacticalJsonSchema: TacticalInput JSON Schema 파생($schema 제거)", () => {
    const s = tacticalJsonSchema();
    expect(s["type"]).toBe("object");
    expect(s["$schema"]).toBeUndefined();
  });
});

describe("coach — 마킹(AC-C2): stub 이 카탈로그 marking 지시를 markTarget 으로 산출", () => {
  it("개인 지시 '<상대> 막아' → 그 우리 선수의 markTarget=상대 playerId", async () => {
    const opponentRoster = makeOpponentRoster();
    const ctx = makeTeamInputContext({
      opponentRoster,
      playerPrompts: { H2: "A9 막아" }, // H2(LCB) 가 상대 A9(Away ST) 전담
    });
    const out = validateTeamInputOutput(await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx }), ctx);
    const marker = out.players.find((p) => p.playerId === "H2")!;
    expect(marker.markTarget).toBe("A9");
  });

  it("팀 지시 복수 마킹 → 서로 다른 두 수비수에 1:1 분배", async () => {
    const opponentRoster = makeOpponentRoster();
    const ctx = makeTeamInputContext({
      opponentRoster,
      teamPrompt: "Away ST 랑 Away LW 둘 다 마크해",
    });
    const out = validateTeamInputOutput(await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx }), ctx);
    const targets = out.players.map((p) => p.markTarget).filter(Boolean);
    expect(targets).toContain("A9"); // Away ST
    expect(targets).toContain("A8"); // Away LW
    // 서로 다른 수비수(중복 배정 없음)
    expect(new Set(targets).size).toBe(targets.length);
    const markers = out.players.filter((p) => p.markTarget);
    expect(markers.length).toBe(2);
  });

  it("opponentRoster 없으면 마킹 지시라도 markTarget 을 지어내지 않는다", async () => {
    const ctx = makeTeamInputContext({ playerPrompts: { H2: "A9 막아" } }); // opponentRoster 없음
    const out = validateTeamInputOutput(await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx }), ctx);
    expect(out.players.every((p) => p.markTarget === undefined)).toBe(true);
  });

  it("W0 이월: playerId 단어경계 매칭 — 'A10 막아'는 A1 을 매칭하지 않는다", async () => {
    // away 로스터는 A0..A10(11명). 'A10 막아' → markTarget 은 정확히 A10, 접두 A1 오매칭 금지.
    const opponentRoster = makeOpponentRoster();
    const ctx = makeTeamInputContext({ opponentRoster, playerPrompts: { H2: "A10 막아" } });
    const out = validateTeamInputOutput(await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx }), ctx);
    const marker = out.players.find((p) => p.playerId === "H2")!;
    expect(marker.markTarget).toBe("A10");
    expect(out.players.some((p) => p.markTarget === "A1")).toBe(false);
  });
});

/**
 * #295 의 packages/server 축 — 스텁 실행기가 <b>선언만</b> 요청 포메이션으로 갈아 끼우고 좌표는
 * 엔진 픽스처(항상 4-3-3)를 그대로 물려주던 것. 오프라인 E2E·폴백이 이 경로를 타므로, 유저가
 * 4-4-2 를 골라도 실제 배치는 4-3-3 이었다. 게이트 G4 가 막는 바로 그 형태다(gates.test.ts).
 */
describe("coach — 스텁 산출이 요청 포메이션대로 배치된다 (#295 / #367)", () => {
  it("표의 4종 전부 — 스텁 산출이 게이트(G4 포함)를 통과한다", async () => {
    for (const formation of Object.keys(FORMATION_BASE_POSITIONS)) {
      const ctx = makeTeamInputContext({ formation });
      const raw = await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx });
      expect(() => validateTeamInputOutput(raw, ctx), `${formation} 스텁 산출`).not.toThrow();
    }
  });

  it("재시도 산출(겹침 피드백 → spread 보정)도 게이트를 통과한다 — 보정이 형태를 무너뜨리지 않는다", async () => {
    for (const formation of Object.keys(FORMATION_BASE_POSITIONS)) {
      const ctx = makeTeamInputContext({ formation });
      const raw = await stubExecutor().execute(
        { id: "j", kind: "team-input", context: ctx },
        { feedback: "배치 파손 — 겹친 선수들을 떨어뜨려라" },
      );
      expect(() => validateTeamInputOutput(raw, ctx), `${formation} 재시도 산출`).not.toThrow();
    }
  });

  it("4-4-2 요청 → 슬롯 좌표가 4-4-2 표와 일치(4-3-3 을 물려주지 않는다)", async () => {
    const ctx = makeTeamInputContext({ formation: "4-4-2" });
    const out = validateTeamInputOutput(
      await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx }),
      ctx,
    );
    const slots = FORMATION_BASE_POSITIONS["4-4-2"]!;
    for (const r of ctx.roster) {
      const p = out.players.find((x) => x.playerId === r.playerId)!;
      expect(p.basePosition, `slot${r.slotIndex} ${r.playerId}`).toEqual({ ...slots[r.slotIndex]! });
    }
  });
});

describe("coach — 관계·사기 방향성(AC-C4): stub 이 mentalModifier 방향을 흉내", () => {
  const H = makeTeamInputContext().roster.map((r) => r.playerId);

  async function run(ctx: Parameters<typeof buildTeamInputPrompt>[0]) {
    return validateTeamInputOutput(await stubExecutor().execute({ id: "j", kind: "team-input", context: ctx }), ctx);
  }

  it("GLASS + 질책성 개인 지시 → 그 선수 mentalModifier 하향(위축)", async () => {
    const target = H[3]!;
    const ctx = makeTeamInputContext({
      relations: { [target]: { trust: 70, personality: "GLASS" } }, // trust 높아 완화 안 걸림
      playerPrompts: { [target]: "정신차려, 이렇게 하면 질책받는다" },
    });
    const out = await run(ctx);
    expect(out.players.find((p) => p.playerId === target)!.mentalModifier).toBeLessThan(0);
  });

  it("FIERY + 강한 공격 팀 지시 → mentalModifier 상향(과반응)", async () => {
    const target = H[8]!;
    const ctx = makeTeamInputContext({
      teamPrompt: "전방부터 강하게 밀어붙이고 과감하게 공격해라",
      relations: { [target]: { trust: 70, personality: "FIERY" } },
    });
    const out = await run(ctx);
    expect(out.players.find((p) => p.playerId === target)!.mentalModifier).toBeGreaterThan(0);
  });

  it("연패(streak<0) 팀 사기 → 팀 전반 mentalModifier 하향", async () => {
    const ctx = makeTeamInputContext({ teamMorale: { morale: 20, streak: -5 } });
    const out = await run(ctx);
    expect(out.players.every((p) => p.mentalModifier < 0)).toBe(true);
  });

  it("관계 컨텍스트 없으면 mentalModifier 는 베이스(0) 유지", async () => {
    const out = await run(makeTeamInputContext());
    expect(out.players.every((p) => p.mentalModifier === 0)).toBe(true);
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
