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
    fatigue: 0, isGK: false, idHash: 1, dribbleStreak: 0, yellowCards: 0, seen: {},
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
    expect(Object.keys(me.seen).length).toBe(3);
    // 가까운 순으로 갱신된다.
    expect(Object.keys(me.seen).sort()).toEqual(["A1", "A2", "A3"]);
  });

  it("예산 밖 상대는 판단 입력에서 **옛 좌표 + age>0** 으로 들어온다(실시간 좌표를 쓰지 않는다)", () => {
    const me = mkPlayer("H1", "home", 50, 34);
    const drifter = mkPlayer("A9", "away", 55, 34);
    // 1틱: 예산(3) 안이라 정밀 인지 → 기억 갱신.
    const st = mkState([me, drifter]);
    expect(perceiveOpponents(st, me, cfg)[0]!.x).toBe(toFixed(55, scale));
    // 2틱: 더 가까운 상대 3명이 예산을 전부 차지 → drifter 는 갱신되지 않는다.
    const closer = [1, 2, 3].map((i) => mkPlayer(`A${i}`, "away", 50 + i * 0.5, 34));
    const st2 = mkState([me, drifter, ...closer], 1);
    drifter.posFx.x = toFixed(60, scale); // 실제로는 이동했다
    const known = perceiveOpponents(st2, me, cfg);
    const d = known.find((k) => k.id === "A9")!;
    // 판단 입력은 **옛 좌표**여야 한다 — 실시간 좌표(60)를 쓰면 이 단언이 깨진다.
    expect(d.x).toBe(toFixed(55, scale));
    expect(d.x).not.toBe(drifter.posFx.x);
    expect(d.age).toBe(1);
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
    expect(Object.keys(sharp.seen).length).toBeGreaterThan(Object.keys(dull.seen).length);
  });
});

describe("판단 — 붙을지 말지 (#147 W3)", () => {
  const ownGoal = defendGoal(pitch, "home");

  it("아는 상대가 여럿이어도 **가장 가치 높은 하나만** 고르고 나머지는 고르지 않는다", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    const known = [
      { id: "A1", x: toFixed(28, scale), y: toFixed(34, scale), dist: toFixed(2, scale), age: 0 },
      { id: "A2", x: toFixed(32, scale), y: toFixed(30, scale), dist: toFixed(5, scale), age: 0 },
      { id: "A3", x: toFixed(35, scale), y: toFixed(38, scale), dist: toFixed(6, scale), age: 0 },
    ];
    const t = chooseMarkTarget(known, me, cfg, ownGoal);
    // 가치 = base − 내골거리 − 비용·가중. A1 이 내 골(x=0)에 가장 가깝고 가장 싸다.
    expect(t!.id).toBe("A1");
  });

  it("붙을 가치가 없으면(너무 멀어 비용이 큼) **아무도 고르지 않는다** — 자리를 지킨다", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    // 상대가 우리 골에서 아주 멀고(위협 낮음) 나에게서도 멀다(비용 큼) → 가치 ≤ 0.
    const far = [{ id: "A1", x: toFixed(100, scale), y: toFixed(60, scale), dist: toFixed(75, scale), age: 0 }];
    expect(chooseMarkTarget(far, me, cfg, ownGoal)).toBeNull();
  });

  it("내 골에 더 가까운(위협적인) 상대를 고른다", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    const near = { id: "A1", x: toFixed(20, scale), y: toFixed(34, scale), dist: toFixed(10, scale), age: 0 };
    const far = { id: "A2", x: toFixed(40, scale), y: toFixed(34, scale), dist: toFixed(10, scale), age: 0 };
    const t = chooseMarkTarget([far, near], me, cfg, ownGoal);
    expect(t!.id).toBe("A1"); // home 은 왼쪽(x=0)을 지킨다 → x 가 작을수록 위협
  });

  it("markTarget 은 하드 오버라이드가 아니라 **가중치**다 — 비용이 가산을 이기면 지시를 따르지 않는다", () => {
    const me = mkPlayer("H1", "home", 30, 34);
    me.markTarget = "A9";
    const other = { id: "A1", x: toFixed(20, scale), y: toFixed(34, scale), dist: toFixed(10, scale), age: 0 };
    // 지시 대상이 적당히 가까우면 가산(markTargetBias)이 이겨 선택된다.
    const near = { id: "A9", x: toFixed(45, scale), y: toFixed(34, scale), dist: toFixed(15, scale), age: 0 };
    expect(chooseMarkTarget([other, near], me, cfg, ownGoal)!.id).toBe("A9");
    // 같은 지시라도 **비용이 가산을 넘길 만큼 멀면** 지시를 따르지 않는다.
    // (하드 오버라이드였다면 거리와 무관하게 A9 가 선택된다 → 이 단언이 그 변이를 죽인다.)
    const tooFar = { id: "A9", x: toFixed(95, scale), y: toFixed(60, scale), dist: toFixed(70, scale), age: 0 };
    expect(chooseMarkTarget([other, tooFar], me, cfg, ownGoal)!.id).toBe("A1");
  });
});

describe("롤백 스위치 (#147 W3)", () => {
  const seed = "4815162342";
  const off: EngineConfig = { ...cfg, vision: { ...cfg.vision, enabled: false } };
  const run = (c: EngineConfig, mark?: string) => {
    const home = makeTacticalInput("H", seed);
    if (mark) home.players[4]!.markTarget = mark;
    return runMatch(seed, home, makeTacticalInput("A", seed), makeSelectData(), c);
  };
  const lastHash = (l: ReturnType<typeof runMatch>) => l.tickSnapshots[l.tickSnapshots.length - 1]!.hash;

  it("vision.enabled=true 는 실제로 결과를 바꾼다(계층이 죽어있지 않다)", () => {
    expect(lastHash(run(cfg))).not.toBe(lastHash(run(off)));
  });

  it("롤백(enabled=false)에서도 markTarget 은 살아있다 — 무음 no-op 이 되면 안 된다", () => {
    // 시야 계층을 끄면 레거시 하드 오버라이드 경로로 돌아가야 한다. 지시가 결과를 바꾸지 못하면
    // 그건 "롤백" 이 아니라 AI 마킹 지시(shared tactical-patch 경로)를 통째로 죽인 것이다.
    expect(lastHash(run(off, "A9"))).not.toBe(lastHash(run(off)));
  });

  it("시야 ON 에서도 markTarget 은 결과를 바꾼다(가중치로 살아있다)", () => {
    expect(lastHash(run(cfg, "A9"))).not.toBe(lastHash(run(cfg)));
  });
});
