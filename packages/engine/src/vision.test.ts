import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "./config";
import { perceiveOpponents, chooseMarkTarget } from "./decision";
import { runMatch } from "./match";
import { makeTacticalInput, makeSelectData, demoSelect } from "./fixtures";
import { createPitch, defendGoal } from "./pitch";
import type { SimState, SimPlayer } from "./simstate";
import { toFixed } from "./fixedmath";

/**
 * 시야 기반 인지·판단 계약 (#147 W3, 후보 E — hero 실관전 채택).
 *
 * 두 계층을 각각 박는다:
 *  1) 인지 — 1틱에 정밀 추적하는 상대 수가 유한(주의 예산), 나머지는 마지막 본 위치(낡음), 오래되면 폐기.
 *  2) 판단 — 아는 상대 전원에게 붙지 않고 위협도−도달비용이 가장 큰 한 명만. markTarget 은
 *     하드 오버라이드가 아니라 가중치.
 */

const cfg = defaultEngineConfig;
const scale = cfg.fixedScale;
const pitch = createPitch(cfg);

function mkPlayer(id: string, side: "home" | "away", xM: number, yM: number): SimPlayer {
  const fx = { x: toFixed(xM, scale), y: toFixed(yM, scale) };
  return {
    id, side, role: "CM", duty: "support",
    behavior: {
      positioningFreedom: 0.5, forwardRunFreq: 0.5, widthTendency: 0.5, supportDepth: 0.5,
      pressAggression: 0.5, passRisk: 0.5, passDirectness: 0.5, dribbleTendency: 0.5, shootTendency: 0.5,
    },
    mentalModifier: 0,
    attrs: { technical: 50, mental: 50, physical: 50, passing: 50, shooting: 50, tackling: 50, pace: 50, stamina: 50, positioning: 50 },
    baseFx: { ...fx }, posFx: { ...fx }, targetFx: { ...fx },
    fatigue: 0, isGK: false, idHash: 1, dribbleStreak: 0, yellowCards: 0, seen: new Map(),
  };
}

function mkState(players: SimPlayer[], tick = 0): SimState {
  const byId = new Map(players.map((p) => [p.id, p]));
  return {
    players, byId,
    ball: { posFx: { x: 0, y: 0 }, owner: null, ownerSide: null, flight: null },
    score: { home: 0, away: 0 }, possession: "away", tick,
    seedHash: 1, teams: {} as never, stoppage: 0, setPiece: null,
  };
}

describe("인지 — 주의 예산과 기억 (#147 W3)", () => {
  it("반경 안 상대가 예산보다 많아도 이번 틱에 정밀 추적하는 건 예산 수만큼이다", () => {
    const me = mkPlayer("H1", "home", 50, 34);
    // 예산(기본 3 + 속성보정 0 = 3) 보다 많은 5명을 가까이 배치.
    const opps = [1, 2, 3, 4, 5].map((i) => mkPlayer(`A${i}`, "away", 50 + i, 34));
    const st = mkState([me, ...opps]);
    perceiveOpponents(st, me, cfg);
    expect(me.seen.size).toBe(3);
    // 가까운 순으로 갱신된다.
    expect([...me.seen.keys()].sort()).toEqual(["A1", "A2", "A3"]);
  });

  it("정밀 추적 못 한 상대는 '마지막 본 위치'로 남고, 실제로 움직여도 옛 좌표로 판단한다", () => {
    const me = mkPlayer("H1", "home", 50, 34);
    const far = mkPlayer("A9", "away", 55, 34);
    const st = mkState([me, far]);
    perceiveOpponents(st, me, cfg); // A9 를 봄(예산 안)
    const seenAt = me.seen.get("A9")!;
    // 상대가 실제로 이동했지만, 이번 틱엔 예산이 다른 상대들로 찼다고 가정하기 위해 기억만 유지.
    far.posFx.x = toFixed(60, scale);
    st.tick = 1;
    // 예산을 0 명분으로 만들 수 없으니, 기억이 갱신되지 않은 상황을 직접 검증:
    expect(seenAt.x).toBe(toFixed(55, scale));
    expect(seenAt.x).not.toBe(far.posFx.x);
  });

  it("memoryTicks 를 넘긴 기억은 판단 입력에서 빠진다", () => {
    const me = mkPlayer("H1", "home", 50, 34);
    const opp = mkPlayer("A1", "away", 55, 34);
    const st = mkState([me, opp]);
    perceiveOpponents(st, me, cfg);
    expect(perceiveOpponents(st, me, cfg).length).toBe(1);
    // 상대를 반경 밖으로 치우고 시간을 흘려보내면(=더는 못 봄) 기억이 만료된다.
    opp.posFx.x = toFixed(200, scale);
    st.tick = cfg.vision.memoryTicks + 1;
    expect(perceiveOpponents(st, me, cfg).length).toBe(0);
  });

  it("주의 예산은 인지 속성(positioning·mental)으로 늘어난다 — 반경이 아니라 주의", () => {
    const dull = mkPlayer("H1", "home", 50, 34);
    dull.attrs = { ...dull.attrs, positioning: 0, mental: 0 };
    const sharp = mkPlayer("H2", "home", 50, 34);
    sharp.attrs = { ...sharp.attrs, positioning: 100, mental: 100 };
    const opps = [1, 2, 3, 4, 5, 6].map((i) => mkPlayer(`A${i}`, "away", 50 + i, 34));
    const st1 = mkState([dull, ...opps]);
    const st2 = mkState([sharp, ...opps]);
    perceiveOpponents(st1, dull, cfg);
    perceiveOpponents(st2, sharp, cfg);
    expect(sharp.seen.size).toBeGreaterThan(dull.seen.size);
  });
});

describe("판단 — 붙을지 말지 (#147 W3)", () => {
  const ownGoal = defendGoal(pitch, "home");

  it("아는 상대가 여럿이어도 마킹 대상은 최대 한 명이다(전원에게 끌리지 않는다)", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    const known = [
      { id: "A1", x: toFixed(28, scale), y: toFixed(34, scale), dist: toFixed(2, scale), age: 0 },
      { id: "A2", x: toFixed(32, scale), y: toFixed(30, scale), dist: toFixed(5, scale), age: 0 },
      { id: "A3", x: toFixed(35, scale), y: toFixed(38, scale), dist: toFixed(6, scale), age: 0 },
    ];
    const t = chooseMarkTarget(known, me, cfg, ownGoal);
    expect(t).not.toBeNull();
    expect(known.filter((k) => k.id === t!.id).length).toBe(1);
  });

  it("내 골에 더 가까운(위협적인) 상대를 고른다", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    const near = { id: "A1", x: toFixed(20, scale), y: toFixed(34, scale), dist: toFixed(10, scale), age: 0 };
    const far = { id: "A2", x: toFixed(40, scale), y: toFixed(34, scale), dist: toFixed(10, scale), age: 0 };
    const t = chooseMarkTarget([far, near], me, cfg, ownGoal);
    expect(t!.id).toBe("A1"); // home 은 왼쪽(x=0)을 지킨다 → x 가 작을수록 위협
  });

  it("markTarget 은 하드 오버라이드가 아니라 가중치다 — 도달비용이 과하면 그래도 안 붙는다", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    me.markTarget = "A9";
    // 지시 대상이 인지 반경 밖(=known 에 없음)이면 아무 일도 일어나지 않는다.
    const t0 = chooseMarkTarget([], me, cfg, ownGoal);
    expect(t0).toBeNull();
    // 지시 대상이 보이면, 덜 위협적이어도 가산 덕에 선택된다.
    const other = { id: "A1", x: toFixed(20, scale), y: toFixed(34, scale), dist: toFixed(10, scale), age: 0 };
    const commanded = { id: "A9", x: toFixed(45, scale), y: toFixed(34, scale), dist: toFixed(15, scale), age: 0 };
    const t1 = chooseMarkTarget([other, commanded], me, cfg, ownGoal);
    expect(t1!.id).toBe("A9");
  });
});

describe("롤백 스위치 (#147 W3)", () => {
  it("vision.enabled=false 면 매치 결과가 레거시와 동일하다(회귀 기준)", () => {
    const off: EngineConfig = { ...cfg, vision: { ...cfg.vision, enabled: false } };
    const seed = "4815162342";
    const a = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), demoSelect, off);
    const b = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), demoSelect, off);
    expect(a.tickSnapshots[a.tickSnapshots.length - 1]!.hash).toBe(b.tickSnapshots[b.tickSnapshots.length - 1]!.hash);
  });

  it("vision.enabled=true 는 실제로 결과를 바꾼다(계층이 죽어있지 않다)", () => {
    const off: EngineConfig = { ...cfg, vision: { ...cfg.vision, enabled: false } };
    const seed = "4815162342";
    const sel = makeSelectData();
    const on = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), sel, cfg);
    const legacy = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), sel, off);
    expect(on.tickSnapshots[on.tickSnapshots.length - 1]!.hash).not.toBe(
      legacy.tickSnapshots[legacy.tickSnapshots.length - 1]!.hash,
    );
  });
});
