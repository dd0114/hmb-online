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
import { REWARD_SECTIONS, presentSections, unclaimedIn } from "./registry";
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

  it("등록 목록 = 재화 · 성장 · 미션 (섹션 파일은 각 에픽 소유, 등록 한 줄만 #405)", () => {
    expect(REWARD_SECTIONS.map((s) => s.kind)).toEqual(["CURRENCY", "GROWTH", "MISSION"]);
  });

  it("🚨 '눌러야 지급'인 섹션만 `unclaimed` 를 갖는다 — 자동 지급에 달면 안 받은 게 없는데 막힌다", () => {
    const withUnclaimed = REWARD_SECTIONS.filter((s) => s.unclaimed).map((s) => s.kind);
    expect(withUnclaimed).toEqual(["MISSION"]);
    // 경고가 막다른 길이 되지 않게 "나중에 어디서" 가 반드시 붙는다.
    for (const s of REWARD_SECTIONS.filter((x) => x.unclaimed)) {
      expect(s.unclaimedHint && s.unclaimedHint.length > 0).toBe(true);
    }
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

  it("등록되지 않은 kind 는 무시한다 — 서버가 먼저 새 섹션을 실어도 안전하다", () => {
    const b = withSections([{ kind: "ITEM", entries: [{ id: "i1" }] }]);
    expect(presentSections(b)).toEqual([]);
  });

  it("봉투가 없으면 빈 목록", () => {
    expect(presentSections(null)).toEqual([]);
    expect(presentSections(undefined)).toEqual([]);
  });
});

/**
 * 미션 섹션 (#408) — **자료가 봉투 안에 없다.** 응답의 additive `missions` 블록에서 오므로
 * `presentSections` 의 두 번째 인자가 판정을 가른다.
 */
describe("MISSION 섹션 — 봉투가 아니라 응답을 본다", () => {
  const empty = withSections([{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 300 }] }]);
  const mission = (over: Record<string, unknown> = {}) => ({
    id: "M1", missionId: "away_win_2", title: "원정에서 2승", tier: "NORMAL",
    currency: "GEM", amount: 222, progress: 2, target: 2, completedNow: true,
    state: "COMPLETED", ...over,
  });

  it("응답에 미션이 없으면 탭이 안 생긴다 — 원정이 아닌 경기·구 서버", () => {
    expect(presentSections(empty).map((s) => s.kind)).toEqual(["CURRENCY"]);
    expect(presentSections(empty, {}).map((s) => s.kind)).toEqual(["CURRENCY"]);
    expect(presentSections(empty, { missions: [] }).map((s) => s.kind)).toEqual(["CURRENCY"]);
  });

  it("⚠️ 손상 응답에도 탭이 생기지 않는다 — 빈 탭이 뜨면 섹션 컴포넌트와 판정이 갈린 것이다", () => {
    // 섹션 컴포넌트도 `normalizeMatchMissions` 로 같은 판정을 한다(한 함수를 공유한다).
    for (const raw of [{ missions: { nope: true } }, { missions: "x" }, { missions: [{ noId: 1 }] }]) {
      expect(presentSections(empty, raw).map((s) => s.kind)).toEqual(["CURRENCY"]);
    }
  });

  it("미션이 있으면 재화·성장 **뒤**에 붙는다(order 30)", () => {
    const b = withSections([
      { kind: "GROWTH", entries: [{ playerId: "P001", name: "강태산", xpGained: 12 }] },
      { kind: "CURRENCY", entries: [{ code: "POINT", amount: 300 }] },
    ]);
    expect(presentSections(b, { missions: [mission()] }).map((s) => s.kind)).toEqual([
      "CURRENCY", "GROWTH", "MISSION",
    ]);
  });
});

/**
 * 🚨 **claim ≠ ack** — 셸이 `[확인]` 을 막을 근거. 여기가 틀리면 유저가 미수령분을 잃는다.
 */
describe("unclaimedIn — 아직 받지 않은 건수", () => {
  const b = withSections([{ kind: "CURRENCY", entries: [{ code: "POINT", amount: 300 }] }]);
  const m = (over: Record<string, unknown>) => ({
    id: "M1", missionId: "x", title: "t", tier: "EASY", currency: "GEM", amount: 100,
    progress: 1, target: 1, completedNow: true, state: "COMPLETED", ...over,
  });
  const count = (missions: unknown[]) => {
    const result = { missions };
    return unclaimedIn(presentSections(b, result), b, result).reduce((n, u) => n + u.count, 0);
  };

  it("COMPLETED 만 센다 — 진행 중은 받을 것이 없다", () => {
    expect(count([m({ state: "COMPLETED" }), m({ id: "M2", state: "IN_PROGRESS" })])).toBe(1);
  });

  it("⚠️ **수령한 뒤에는 0 이다** — 안 그러면 경고가 영영 안 사라져 [확인]이 두 번 필요해진다", () => {
    // `progress >= target` 으로 세는 변이가 여기서 죽는다(2/2 인데 CLAIMED 인 표본).
    expect(count([m({ state: "CLAIMED", progress: 2, target: 2 })])).toBe(0);
  });

  it("⚠️ 진행도가 목표에 닿아도 서버가 COMPLETED 가 아니면 안 센다(양방향 표본)", () => {
    expect(count([m({ state: "IN_PROGRESS", progress: 2, target: 2 })])).toBe(0);
    expect(count([m({ state: "COMPLETED", progress: 0, target: 3 })])).toBe(1);
  });

  it("구 서버(state 부재)는 fail-closed — 셀 수 없는 것으로 막지 않는다", () => {
    const { state: _drop, ...noState } = m({});
    expect(count([noState])).toBe(0);
  });

  it("재화·성장만 있으면 0 — 자동 지급은 [확인]을 막지 않는다(회귀 0)", () => {
    const only = withSections([
      { kind: "CURRENCY", entries: [{ code: "POINT", amount: 300 }] },
      { kind: "GROWTH", entries: [{ playerId: "P001", name: "강태산", xpGained: 12 }] },
    ]);
    expect(unclaimedIn(presentSections(only), only)).toEqual([]);
  });
});
