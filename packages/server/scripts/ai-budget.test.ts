import { describe, it, expect } from "vitest";
import {
  TacticalInput,
  TeamInput,
  PlayerInput,
  PlayerBehavior,
} from "@hmb/shared";
import { measureBudget, buildVariants, approxTokens, measurePatchBudget } from "./ai-budget-core.js";

/**
 * AI 예산 회귀 가드 (AC-C5 / P2-D8).
 * (a) 블록별 프롬프트 증분이 문서화된 기준선 대비 ±20% 이내 (docs/plan-v3/ai-budget-baseline.md).
 * (b) 출력 스키마 불변 — TacticalInput zod 필드가 Phase2 에서 증가 없음(컨텍스트는 입력만).
 * (c) 전체(전 블록 on) 프롬프트 길이 상한 스냅샷 + 하드 상한.
 */

// 문서화된 기준선(오프라인 근사, chars 증분) — docs/plan-v3/ai-budget-baseline.md 와 동기화.
const BASELINE_DELTA_CHARS: Record<string, number> = {
  manualTactics: 270,
  conditions: 373,
  relations: 835,
  teamMorale: 74,
  opponentRoster: 243,
  "catalog(full)": 3040,
};
const TOLERANCE = 0.2; // ±20%

describe("ai-budget 하네스 — 기준선 회귀 가드 (a)", () => {
  const report = measureBudget();
  const byId = Object.fromEntries(report.blocks.map((b: any) => [b.id, b]));

  for (const [id, baseline] of Object.entries(BASELINE_DELTA_CHARS)) {
    it(`${id} 증분이 기준선 ${baseline} chars 대비 ±20% 이내`, () => {
      const block = byId[id];
      expect(block, `block ${id} 존재`).toBeTruthy();
      const lo = Math.floor(baseline * (1 - TOLERANCE));
      const hi = Math.ceil(baseline * (1 + TOLERANCE));
      expect(block.deltaChars).toBeGreaterThanOrEqual(lo);
      expect(block.deltaChars).toBeLessThanOrEqual(hi);
    });
  }

  it("approxTokens = chars/4 올림(근사 계약 고정)", () => {
    expect(approxTokens("abcd")).toBe(1);
    expect(approxTokens("abcde")).toBe(2);
    expect(approxTokens("")).toBe(0);
  });
});

describe("출력 스키마 불변 가드 (b) — P2-D8: 컨텍스트는 입력만, 출력 필드 증가 없음", () => {
  // Phase2 컨텍스트 확장이 TacticalInput 출력 계약을 늘리지 않았음을 필드 집합으로 박제한다.
  it("TacticalInput 최상위 필드 = {seed, team, players, meta} 고정", () => {
    expect(Object.keys(TacticalInput.shape).sort()).toEqual(["meta", "players", "seed", "team"]);
  });
  it("TeamInput 필드 고정(7개)", () => {
    expect(Object.keys(TeamInput.shape).sort()).toEqual(
      ["compactness", "defensiveLineHeight", "formation", "offsideTrap", "pressingScheme", "tempo", "width"],
    );
  });
  it("PlayerInput 필드 고정(7개 — markTarget 포함, 신규 없음)", () => {
    expect(Object.keys(PlayerInput.shape).sort()).toEqual(
      ["basePosition", "behavior", "duty", "markTarget", "mentalModifier", "playerId", "role"],
    );
  });
  it("PlayerBehavior 필드 고정(9개 성향 파라미터)", () => {
    expect(Object.keys(PlayerBehavior.shape).sort()).toEqual(
      [
        "dribbleTendency",
        "forwardRunFreq",
        "passDirectness",
        "passRisk",
        "positioningFreedom",
        "pressAggression",
        "shootTendency",
        "supportDepth",
        "widthTendency",
      ],
    );
  });
});

describe("B(team-input-patch) 프롬프트 입력 계측 (W3 — A+B 린패치)", () => {
  it("measurePatchBudget: base/allOn 결정론 + full-gen 대비 Δ 산출", () => {
    const a = measurePatchBudget();
    const b = measurePatchBudget();
    expect(a).toEqual(b); // 결정론
    expect(a.base.chars).toBeGreaterThan(0);
    expect(a.allOn.chars).toBeGreaterThan(a.base.chars); // 컨텍스트 블록 켜면 길어짐
    // deltaVsFullGen = B 입력 − full-gen 입력. A 스칼라 참조+글로서리 vs full-gen 로스터 능력치 — 유한한 정수.
    expect(Number.isInteger(a.base.deltaVsFullGen)).toBe(true);
  });

  it("measureBudget().patch 가 리포트에 포함(하네스 통합)", () => {
    const report = measureBudget();
    expect(report.patch.base.id).toBe("patch-base");
    expect(report.patch.allOn.id).toBe("patch-allOn");
  });
});

describe("전체 프롬프트 길이 상한 (c)", () => {
  const report = measureBudget();
  it("전부 on 프롬프트 길이 스냅샷(증분 가시화)", () => {
    expect({ chars: report.allOn.chars, approxTokens: report.allOn.approxTokens }).toMatchSnapshot();
  });
  it("전부 on 프롬프트가 하드 상한(8500 chars) 미만 — 컨텍스트 폭주 방지", () => {
    // 기준선 6775 chars + 여유. 초과 시 컨텍스트 블록 팽창 재검토 신호.
    expect(report.allOn.chars).toBeLessThan(8500);
  });
  it("buildVariants 는 base+5블록+allOn = 7 변형을 결정론적으로 생성", () => {
    const v = buildVariants();
    expect(v.map((x: any) => x.id)).toEqual([
      "base",
      "manualTactics",
      "conditions",
      "relations",
      "teamMorale",
      "opponentRoster",
      "allOn",
    ]);
    // 결정론: 두 번 빌드해도 동일 프롬프트.
    const v2 = buildVariants();
    expect(v2.map((x: any) => x.prompt)).toEqual(v.map((x: any) => x.prompt));
  });
});
