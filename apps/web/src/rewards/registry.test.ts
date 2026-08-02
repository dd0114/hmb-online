// @vitest-environment node
/**
 * 섹션 레지스트리 계약 (#405 §2.9.1 — #408 과 합의한 파일 경계).
 *
 * 여기서 지키는 약속은 하나다: **"섹션이 비면 탭 자체가 안 그려진다"**. 그 약속이 있어야 다른
 * 에픽이 셸을 안 건드리고 섹션 파일 하나 + 등록 한 줄로 붙을 수 있다.
 *
 * ⚠️ 기대값은 리터럴로 박는다 — `SECTION_GROWTH` 같은 상수를 import 해서 비교하면 이름을 바꾸는
 * 변이가 그대로 통과한다(#286 W5 에서 실제로 당한 형태).
 */
import { describe, expect, it } from "vitest";
import { REWARD_SECTIONS, presentSections } from "./registry";
import type { RewardBundle } from "./types";

const withSections = (sections: RewardBundle["sections"]): RewardBundle => ({
  bundleId: "B1",
  source: "MATCH",
  sourceRef: "m1",
  acknowledgedAt: null,
  sections,
});

describe("REWARD_SECTIONS", () => {
  it("kind 는 유일하고 order 는 정렬 가능한 숫자다", () => {
    const kinds = REWARD_SECTIONS.map((s) => s.kind);
    expect(new Set(kinds).size).toBe(kinds.length);
    for (const s of REWARD_SECTIONS) expect(Number.isFinite(s.order)).toBe(true);
  });

  it("#405 가 등록하는 것은 재화·성장 둘뿐이다 (미션 등은 각 에픽이 자기 파일 + 등록 한 줄)", () => {
    expect(REWARD_SECTIONS.map((s) => s.kind)).toEqual(["CURRENCY", "GROWTH"]);
  });
});

describe("presentSections — 비면 탭이 없다", () => {
  it("재화만 있으면 재화 하나(성장 탭 없음)", () => {
    const b = withSections([{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 300 }] }]);
    expect(presentSections(b).map((s) => s.kind)).toEqual(["CURRENCY"]);
  });

  it("성장만 있으면 성장 하나 — 무보상 경기에서 빈 재화 탭이 뜨지 않는다", () => {
    const b = withSections([
      { kind: "CURRENCY", entries: [] },
      { kind: "GROWTH", entries: [{ playerId: "P001", name: "강태산", xpGained: 12 }] },
    ]);
    expect(presentSections(b).map((s) => s.kind)).toEqual(["GROWTH"]);
  });

  it("둘 다 있으면 order 순서(재화 → 성장)", () => {
    const b = withSections([
      { kind: "GROWTH", entries: [{ playerId: "P001", name: "강태산", xpGained: 12 }] },
      { kind: "CURRENCY", entries: [{ code: "POINT", amount: 300 }] },
    ]);
    expect(presentSections(b).map((s) => s.kind)).toEqual(["CURRENCY", "GROWTH"]);
  });

  it("등록되지 않은 kind 는 무시한다 — #408 이 머지되기 전 서버가 먼저 섹션을 실어도 안전하다", () => {
    const b = withSections([{ kind: "MISSION", entries: [{ id: "m1" }] }]);
    expect(presentSections(b)).toEqual([]);
  });

  it("봉투가 없으면 빈 목록", () => {
    expect(presentSections(null)).toEqual([]);
    expect(presentSections(undefined)).toEqual([]);
  });
});
