import { describe, it, expect } from "vitest";
import { TacticalInput, TacticalPatch, applyPatch } from "@hmb/shared";
import {
  buildTeamInputPatchPrompt,
  validateTeamInputPatchOutput,
  tacticalPatchJsonSchema,
} from "./coach.js";
import { stubExecutor } from "../executor/executors/stub.js";
import { makeTeamInputPatchContext, makeOpponentRoster } from "../executor/test-fixtures.js";

/**
 * B(패치 생성) 경로 — team-input-patch (A+B 린패치, #82/W3).
 * B 프롬프트("패치만 출력"·글로서리·A 스칼라 참조·컨텍스트 블록 재사용) + stub 패치 + 게이트 머지(최종 TacticalInput).
 */

describe("coach — buildTeamInputPatchPrompt (B: 패치만·절대값·추론최소)", () => {
  it("패치만 출력·A 재기술 금지·글로서리·카탈로그가 프롬프트에 있다", () => {
    const p = buildTeamInputPatchPrompt(makeTeamInputPatchContext({ teamPrompt: "전원 강하게 압박" }));
    expect(p).toContain("TacticalPatch JSON");
    expect(p).toContain("패치만");
    expect(p).toContain("A 를 재기술 금지");
    expect(p).toContain("필드 글로서리");
    expect(p).toContain("압박/프레스 강도 → team.pressIntensity");
    expect(p).toContain("지원 지시 카탈로그"); // 카탈로그 재사용
    expect(p).toContain("전원 강하게 압박"); // 감독 지시
  });

  it("A 베이스는 팀 스칼라 요약만 참조(선수 11명 성향 전량 덤프 금지 — 토큰 절약)", () => {
    const p = buildTeamInputPatchPrompt(makeTeamInputPatchContext());
    expect(p).toContain("현재 팀 전술 베이스(A");
    expect(p).toContain("pressIntensity 0.55"); // A 팀 스칼라
    expect(p).toContain("성향 베이스는 이미 A 에 계산돼 있다");
    // A 의 선수 behavior JSON(11명 성향)이 프롬프트에 덤프되지 않음 — diff 추론 낭비 방지(#82). 로스터 id 줄만.
    expect(p).not.toContain('"behavior"');
    expect(p).not.toContain('"positioningFreedom":');
    expect(p).toContain("H0 Home GK"); // 로스터 id 줄(키 해석용)
  });

  it("관계·사기·개인지시 블록은 team-input 과 동일 렌더러로 재사용된다", () => {
    const ctx = makeTeamInputPatchContext({
      relations: { H3: { trust: 70, personality: "GLASS" } },
      teamMorale: { morale: 66, streak: 2 },
      playerPrompts: { H9: "과감하게 슛" },
    });
    const p = buildTeamInputPatchPrompt(ctx);
    expect(p).toContain("성격별 반응 규칙");
    expect(p).toContain("팀 사기: 66/100");
    expect(p).toContain("- H9: 과감하게 슛");
  });

  it("half=2 + prevSummary → 전반 요약 포함", () => {
    const p = buildTeamInputPatchPrompt(
      makeTeamInputPatchContext({ half: 2, prevSummary: { scoreHome: 0, scoreAway: 1, shots: 5, possessionHint: "열세" } }),
    );
    expect(p).toContain("전반 결과 요약");
    expect(p).toContain("home 0 : 1 away");
  });

  it("tacticalPatchJsonSchema: TacticalPatch JSON Schema 파생($schema 제거, additionalProperties:false)", () => {
    const s = tacticalPatchJsonSchema();
    expect(s["type"]).toBe("object");
    expect(s["$schema"]).toBeUndefined();
    expect(s["additionalProperties"]).toBe(false); // strict — 모델이 미지정 필드 금지
  });

  it("B 프롬프트 전문 스냅샷(full-gen 과 동일 패턴 — 출력 지시 회귀 가드)", () => {
    // 결정론 컨텍스트(전 블록 on)로 프롬프트 전문을 박제. 문구/순서 회귀를 잡는다.
    const ctx = makeTeamInputPatchContext({
      teamPrompt: "전원 강하게 압박하고 라인 올려",
      playerPrompts: { H9: "과감하게 슛", H2: "A9 막아" },
      opponentRoster: makeOpponentRoster(),
      relations: { H3: { trust: 70, personality: "GLASS" } },
      teamMorale: { morale: 66, streak: 2 },
    });
    expect(buildTeamInputPatchPrompt(ctx)).toMatchSnapshot();
  });
});

describe("coach — stub 패치 산출 + 게이트 머지(최종 TacticalInput)", () => {
  async function runPatch(ctx: Parameters<typeof buildTeamInputPatchPrompt>[0]) {
    const raw = await stubExecutor().execute({ id: "j", kind: "team-input-patch", context: ctx });
    return { raw, out: validateTeamInputPatchOutput(raw, ctx) };
  }

  it("공격 지시 → stub 이 TacticalPatch(팀+byPosition) 를 내고, 게이트가 11명 최종 TacticalInput 으로 머지", async () => {
    const ctx = makeTeamInputPatchContext({ teamPrompt: "하이라인·와이드 공격" });
    const { raw, out } = await runPatch(ctx);
    // raw = 패치(전량 TacticalInput 아님)
    expect(() => TacticalPatch.parse(raw)).not.toThrow();
    expect(() => TacticalInput.parse(raw)).toThrow(); // 패치는 TacticalInput 이 아님
    // 최종 산출 = 11명, 공격 지시가 team 에 반영
    expect(out.players).toHaveLength(11);
    expect(out.team.defensiveLineHeight).toBe(0.85);
    expect(out.team.width).toBe(0.85);
    // 미지정 축(tempo)은 A 베이스 유지
    expect(out.team.tempo).toBe(ctx.base.team.tempo);
  });

  it("'전원 압박' → byPosition 벌크가 DF/MF/FW pressAggression 을 올린다(개별 나열 없이)", async () => {
    const ctx = makeTeamInputPatchContext({ teamPrompt: "전원 강하게 압박해라" });
    const { raw, out } = await runPatch(ctx);
    const patch = TacticalPatch.parse(raw);
    expect(patch.byPosition?.MF?.behavior?.pressAggression).toBe(0.9);
    // 골키퍼(H0) 제외 필드 선수들 pressAggression 상승
    const st = out.players.find((p) => p.role === "ST")!;
    expect(st.behavior.pressAggression).toBe(0.9);
  });

  it("개인 마킹 지시 '<상대> 막아' → markTargets → 최종 그 선수 markTarget", async () => {
    const ctx = makeTeamInputPatchContext({
      opponentRoster: makeOpponentRoster(),
      playerPrompts: { H2: "A9 막아" },
    });
    const { out } = await runPatch(ctx);
    expect(out.players.find((p) => p.playerId === "H2")!.markTarget).toBe("A9");
  });

  it("팀 복수 마킹 → 서로 다른 두 수비수 markTarget(1:1 분배)", async () => {
    const ctx = makeTeamInputPatchContext({
      opponentRoster: makeOpponentRoster(),
      teamPrompt: "Away ST 랑 Away LW 둘 다 마크해",
    });
    const { out } = await runPatch(ctx);
    const targets = out.players.map((p) => p.markTarget).filter(Boolean);
    expect(targets).toContain("A9");
    expect(targets).toContain("A8");
    expect(new Set(targets).size).toBe(targets.length);
  });

  it("GLASS + 질책 → 그 선수 mentalModifier 하향(byPlayer 로)", async () => {
    const ctx = makeTeamInputPatchContext({
      relations: { H3: { trust: 70, personality: "GLASS" } },
      playerPrompts: { H3: "정신차려, 이렇게 하면 질책받는다" },
    });
    const { out } = await runPatch(ctx);
    expect(out.players.find((p) => p.playerId === "H3")!.mentalModifier).toBeLessThan(0);
  });

  it("빈 지시(전술·톤 없음) → 빈 패치 → 최종 = A(seed 주입만)", async () => {
    const ctx = makeTeamInputPatchContext({ teamPrompt: "" });
    const { raw, out } = await runPatch(ctx);
    expect(TacticalPatch.parse(raw)).toEqual({});
    // 빈 패치 머지 = clamp(A), seed 는 ctx.seed 주입
    expect(out).toEqual(applyPatch(ctx.base, {}, { seed: ctx.seed }));
    expect(out.seed).toBe(ctx.seed);
  });

  it("게이트가 seed(halfSeed)를 주입한다 — base.seed 가 아니라 ctx.seed", async () => {
    const ctx = makeTeamInputPatchContext({ seed: "777", teamPrompt: "" });
    const { out } = await runPatch(ctx);
    expect(out.seed).toBe("777");
  });

  it("유령 markTarget 제거 — opponentRoster 에 없는 타깃은 게이트가 떨군다", () => {
    const ctx = makeTeamInputPatchContext({ opponentRoster: makeOpponentRoster() });
    // 모델이 존재하지 않는 상대 id 를 markTargets 로 지어낸 경우(직접 패치 주입).
    const rawPatch = { markTargets: { H2: "GHOST99", H3: "A9" } };
    const out = validateTeamInputPatchOutput(rawPatch, ctx);
    expect(out.players.find((p) => p.playerId === "H2")!.markTarget).toBeUndefined(); // 유령 제거
    expect(out.players.find((p) => p.playerId === "H3")!.markTarget).toBe("A9"); // 유효는 유지
  });

  it("opponentRoster 미제공이면 markTarget 검증 생략(통과 — team-input 과 동일 수위)", () => {
    const ctx = makeTeamInputPatchContext(); // opponentRoster 없음
    const out = validateTeamInputPatchOutput({ markTargets: { H2: "A9" } }, ctx);
    expect(out.players.find((p) => p.playerId === "H2")!.markTarget).toBe("A9");
  });
});
