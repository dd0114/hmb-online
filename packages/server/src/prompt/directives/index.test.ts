import { describe, it, expect } from "vitest";
import {
  DIRECTIVES,
  synthesizeDirectivesSection,
  collectContextNeeds,
  type Directive,
} from "./index.js";

// 지시 카탈로그 구조 계약 (PRD-v3 AC-C3, P2-D6). 순수 데이터·순수 합성 — 네트워크·키 0.
describe("directives 레지스트리", () => {
  it("초기 6종+ 지시가 명시적 배열로 등록돼 있고 id 가 유일하다", () => {
    const ids = DIRECTIVES.map((d) => d.id);
    expect(ids).toContain("marking");
    expect(ids).toEqual(
      expect.arrayContaining(["marking", "overlap", "forward-run", "long-ball", "press-trigger", "tempo-control"]),
    );
    expect(new Set(ids).size).toBe(ids.length); // 중복 없음
    expect(DIRECTIVES.length).toBeGreaterThanOrEqual(6);
  });

  it("각 지시는 promptGuide·outputFields·contextNeeds·examples 를 갖춘다", () => {
    for (const d of DIRECTIVES as readonly Directive[]) {
      expect(d.id).toMatch(/^[a-z][a-z-]*$/);
      expect(d.title.length).toBeGreaterThan(0);
      expect(d.promptGuide.length).toBeGreaterThan(10);
      expect(d.outputFields.length).toBeGreaterThan(0);
      expect(Array.isArray(d.contextNeeds)).toBe(true);
      expect(d.examples.length).toBeGreaterThan(0);
      for (const ex of d.examples) {
        expect(ex.instruction.length).toBeGreaterThan(0);
        expect(ex.effect.length).toBeGreaterThan(0);
      }
    }
  });

  it("marking 은 opponentRoster 를 필요 컨텍스트로, markTarget 을 출력 필드로 선언한다", () => {
    const m = DIRECTIVES.find((d) => d.id === "marking")!;
    expect(m.contextNeeds).toContain("opponentRoster");
    expect(m.outputFields).toContain("players[].markTarget");
  });

  it("collectContextNeeds: 카탈로그 전체가 필요로 하는 컨텍스트 키(중복 제거)", () => {
    expect(collectContextNeeds()).toContain("opponentRoster");
  });
});

describe("synthesizeDirectivesSection — 순수 합성(A/B 프롬프트 공용)", () => {
  it("모든 지시의 제목·id·해석·예시를 렌더한다", () => {
    const s = synthesizeDirectivesSection();
    for (const d of DIRECTIVES) {
      expect(s).toContain(`id: ${d.id}`);
      expect(s).toContain(d.title);
    }
    expect(s).toContain("지원 지시 카탈로그");
  });

  it("AC-C3: 카탈로그 1종(marking) 제거해도 나머지가 정상 합성된다", () => {
    const reduced = DIRECTIVES.filter((d) => d.id !== "marking");
    const s = synthesizeDirectivesSection(reduced);
    expect(s).not.toContain("id: marking");
    expect(s).toContain("id: overlap");
    expect(s).toContain("id: tempo-control");
    // 나머지 전부 여전히 렌더
    for (const d of reduced) expect(s).toContain(`id: ${d.id}`);
  });

  it("satisfiedContext 미제공 시 marking 에 'opponentRoster 미제공' 주의를 표기", () => {
    const withMissing = synthesizeDirectivesSection(DIRECTIVES, new Set());
    expect(withMissing).toContain("opponentRoster 미제공");
    const withCtx = synthesizeDirectivesSection(DIRECTIVES, new Set(["opponentRoster"]));
    expect(withCtx).not.toContain("미제공");
  });

  it("스냅샷: 카탈로그 증감 시 diff 가시화(전체 섹션)", () => {
    expect(synthesizeDirectivesSection()).toMatchSnapshot();
  });
});
