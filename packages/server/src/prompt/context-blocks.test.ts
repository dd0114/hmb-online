import { describe, it, expect } from "vitest";
import {
  renderManualTacticsBlock,
  renderConditionsBlock,
  renderRelationsBlock,
  renderTeamMoraleBlock,
  PERSONALITY_REACTION_RULES,
} from "./context-blocks.js";
import { buildTeamInputPrompt } from "./coach.js";
import {
  makeTeamInputContext,
  makeManualTactics,
  makeConditions,
  makeRelations,
} from "../executor/test-fixtures.js";

// Phase2 컨텍스트 블록 렌더러 — 순수 함수(W3 A+B 공용). 출력 스키마 불변, 입력만 증가(P2-D8).
describe("context-blocks — 순수 렌더러", () => {
  it("manualTactics 블록: 값 + '베이스, 프롬프트로 보정만' 지침 + 필드 매핑", () => {
    const s = renderManualTacticsBlock({ line: 0.85, press: 0.7, tempo: 0.6, width: 0.55 })!;
    expect(s).toContain("수동 팀 전술");
    expect(s).toContain("라인 0.85");
    expect(s).toContain("베이스 위에 보정만");
    expect(s).toContain("team.defensiveLineHeight"); // press→intensity 등 매핑 명세
    expect(renderManualTacticsBlock(undefined)).toBeNull();
  });

  it("conditions 블록: 라인업 컨디션 표기(값+밴드) + 저조 자제 지침", () => {
    const roster = makeTeamInputContext().roster;
    const s = renderConditionsBlock({ [roster[0]!.playerId]: 0.9, [roster[1]!.playerId]: 0.1 }, roster)!;
    expect(s).toContain("라인업 컨디션");
    expect(s).toContain(`${roster[0]!.playerId} ${roster[0]!.name}: 0.90 (최상)`);
    expect(s).toContain("(최저)");
    expect(s).toContain("무리한 성향");
    expect(renderConditionsBlock(undefined, roster)).toBeNull();
    expect(renderConditionsBlock({}, roster)).toBeNull();
  });

  it("relations 블록: 성격 4종 반응 규칙 명문 + trust 완화 + 선수별 나열", () => {
    const roster = makeTeamInputContext().roster;
    const s = renderRelationsBlock(
      { [roster[0]!.playerId]: { trust: 30, personality: "GLASS" } },
      roster,
    )!;
    // 성격 4종 규칙 문구가 전부 존재해야 한다(AC-C4 핵심).
    expect(s).toContain("FIERY");
    expect(s).toContain("과반응");
    expect(s).toContain("GLASS");
    expect(s).toContain("위축");
    expect(s).toContain("AMBITIOUS");
    expect(s).toContain("CALM");
    expect(s).toContain("신뢰도(trust)가 낮은");
    expect(s).toContain(`성격 GLASS · 신뢰 30`);
    expect(renderRelationsBlock(undefined, roster)).toBeNull();
  });

  it("PERSONALITY_REACTION_RULES 상수는 4종 + trust 규칙을 모두 담는다(고정 문구)", () => {
    for (const key of ["FIERY", "CALM", "GLASS", "AMBITIOUS", "trust"]) {
      expect(PERSONALITY_REACTION_RULES).toContain(key);
    }
  });

  it("teamMorale 블록: 사기 + 연승/연패 문맥", () => {
    expect(renderTeamMoraleBlock({ morale: 72, streak: 3 })!).toContain("3연승");
    expect(renderTeamMoraleBlock({ morale: 20, streak: -4 })!).toContain("4연패");
    expect(renderTeamMoraleBlock({ morale: 50, streak: 0 })!).toContain("연속기록 없음");
    expect(renderTeamMoraleBlock(undefined)).toBeNull();
  });
});

// coach 빌더 통합 — 컨텍스트 유무에 따른 블록 렌더(프롬프트 스냅샷).
describe("coach — Phase2 컨텍스트 블록 통합", () => {
  it("컨텍스트 없으면 Phase2 블록 전부 생략(구 프롬프트와 동일 골격)", () => {
    const p = buildTeamInputPrompt(makeTeamInputContext());
    expect(p).not.toContain("수동 팀 전술");
    expect(p).not.toContain("라인업 컨디션");
    expect(p).not.toContain("감독-선수 관계");
    expect(p).not.toContain("팀 사기");
  });

  it("컨텍스트 제공 시 각 블록이 프롬프트에 렌더된다", () => {
    const ctx = makeTeamInputContext({
      manualTactics: makeManualTactics(),
      conditions: makeConditions(),
      relations: makeRelations(),
      teamMorale: { morale: 66, streak: 2 },
    });
    const p = buildTeamInputPrompt(ctx);
    expect(p).toContain("수동 팀 전술");
    expect(p).toContain("라인업 컨디션");
    expect(p).toContain("감독-선수 관계");
    expect(p).toContain("성격별 반응 규칙");
    expect(p).toContain("팀 사기: 66/100");
  });

  it("스냅샷: Phase2 컨텍스트 풀 블록 프롬프트(블록 렌더 diff 가시화)", () => {
    const ctx = makeTeamInputContext({
      teamPrompt: "하이라인·강한 압박",
      manualTactics: { line: 0.8, press: 0.7, tempo: 0.6, width: 0.5 },
      conditions: { [makeTeamInputContext().roster[0]!.playerId]: 0.9 },
      relations: { [makeTeamInputContext().roster[9]!.playerId]: { trust: 78, personality: "AMBITIOUS" } },
      teamMorale: { morale: 72, streak: 3 },
    });
    expect(buildTeamInputPrompt(ctx)).toMatchSnapshot();
  });
});
