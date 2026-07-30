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
    possessionSince: 0, lastTurnover: null,
    plan: { home: { lineX: 0, blockDepth: 0 }, away: { lineX: 0, blockDepth: 0 } },
    phase: { home: "open", away: "open" },
    intents: [],
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

  it("붙을 가치가 없으면 **아무도 고르지 않는다** — 자리를 지킨다", () => {
    // 인지 반경(radiusM 20) 안에서 실제로 도달 가능한 값만 쓴다 — dist 70 같은 값은
    // perceiveOpponents 가 만들 수 없어 계약이 헛돈다(검증 세션 minor-1).
    const me = mkPlayer("H1", "home", 90, 40);
    const far = [{ id: "A1", x: toFixed(100, scale), y: toFixed(55, scale), dist: toFixed(18, scale), age: 0 }];
    expect(chooseMarkTarget(far, me, cfg, ownGoal)).toBeNull();
  });

  it("markTarget 은 하드 오버라이드가 아니라 **가중치**다 — 비용이 가산을 이기면 지시를 따르지 않는다", () => {
    // 인지 반경 안에서 **실제로 도달 가능한** 배치로 경계를 박는다. 반경 밖 값(dist 70 등)을 쓰면
    // perceiveOpponents 가 그런 후보를 못 만들어 계약이 무력해진다(검증 세션 minor-1).
    const me = mkPlayer("H1", "home", 30, 34);
    me.markTarget = "A9";
    const cheap = { id: "A1", x: toFixed(29, scale), y: toFixed(34, scale), dist: toFixed(1, scale), age: 0 };
    const commanded = { id: "A9", x: toFixed(50, scale), y: toFixed(34, scale), dist: toFixed(20, scale), age: 0 };
    // 비용 차이가 가산을 넘으면 지시를 따르지 않는다(하드 오버라이드였다면 항상 A9).
    expect(chooseMarkTarget([cheap, commanded], me, cfg, ownGoal)!.id).toBe("A1");
    // 반대로 지시 대상이 충분히 쌀 땐 가산이 이겨 선택된다.
    const near = { id: "A9", x: toFixed(36, scale), y: toFixed(34, scale), dist: toFixed(6, scale), age: 0 };
    expect(chooseMarkTarget([cheap, near], me, cfg, ownGoal)!.id).toBe("A9");
  });

  it("markTargetBias 가 60 이상이면 반경 안에서 하드 오버라이드와 구별 불가 — 그 경계를 박는다", () => {
    // 도메인 전수탐색상 bias≥60 은 인지 반경(20m) 안에서 지시 거부율이 0% 가 된다(검증 세션 minor-1).
    // 즉 이 계약이 없으면 bias 를 올려 "가중치" 를 사실상 오버라이드로 되돌려도 아무도 못 잡는다.
    const me = mkPlayer("H1", "home", 30, 34);
    me.markTarget = "A9";
    const cheap = { id: "A1", x: toFixed(29, scale), y: toFixed(34, scale), dist: toFixed(1, scale), age: 0 };
    const commanded = { id: "A9", x: toFixed(50, scale), y: toFixed(34, scale), dist: toFixed(20, scale), age: 0 };
    const hard: EngineConfig = { ...cfg, vision: { ...cfg.vision, markTargetBias: 60 } };
    expect(chooseMarkTarget([cheap, commanded], me, hard, ownGoal)!.id).toBe("A9"); // 거부 불가
    expect(cfg.vision.markTargetBias).toBeLessThan(60); // 출하값은 경계 아래여야 한다
  });
});

describe("롤백 스위치 (#147 W3)", () => {
  const seed = "4815162342";
  // 롤백 경로 = 그 이후 추가된 기능 스위치를 전부 끈 상태 — 시야(#147)와 코너 rest defence(#182).
  // (#181 이후 이 계약은 "0.16.0 과 동일"이 아니라 "롤백 경로가 조용히 드리프트하지 않는다" 다.
  //  아래 상수 주석 참조.)
  const off: EngineConfig = {
    ...cfg,
    vision: { ...cfg.vision, enabled: false },
    setPiece: { ...cfg.setPiece, corner: { ...cfg.setPiece.corner, enabled: false } },
  };
  const run = (c: EngineConfig, mark?: string) => {
    const home = makeTacticalInput("H", seed);
    if (mark) home.players[4]!.markTarget = mark;
    return runMatch(seed, home, makeTacticalInput("A", seed), makeSelectData(), c);
  };
  const lastHash = (l: ReturnType<typeof runMatch>) => l.tickSnapshots[l.tickSnapshots.length - 1]!.hash;
  // 롤백 회귀 가드(#181 기준선).
  //
  // ⚠️ 0.18.0 까지 이 상수는 **0.16.0 과 bit-identical** 을 주장했다(0.16.0 트리를 따로 체크아웃해
  // 대조). #181 에서 그 주장은 더 이상 성립하지 않는다 — vision 스위치는 **시야 계층만** 되돌리는데,
  // #181 은 그 아래 공 물리(도착 판정·리드패스 조준·사이드라인 아웃 검출)를 바꿨기 때문이다.
  // 특히 `boundaryCross` 의 아웃 미검출은 **순수 버그 수정**이라 config 토글을 두지 않았다
  // (버그 재현용 스위치는 만들지 않는다) → 0.16.0 재현 불가.
  //
  // 그래서 "레거시와 같다" 대신 **"조용히 드리프트하지 않는다"** 를 지킨다: 현 트리의 vision-off
  // 출력을 상수로 박제해, 이후 변경이 롤백 경로를 건드리면 반드시 diff 로 드러나게 한다.
  // #230(0.22.0): 골키퍼가 데드볼 형태 당김에서 제외되고(gkShapeReach) GK 의 접근금지 면제가
  // "자기 박스일 때만"으로 좁혀지면서 정지 중 배치가 바뀐다 → 롤백(vision-off) 경로도 함께 움직인다.
  // #176 과 같은 성격(규칙 수정은 롤백 대상이 아님)이라 값 변경은 정상. 재실행 2회 동일 확인.
  // #279 S1: `hashState` 가 새 팀 상태(possessionSince·plan.lineX)를 흡수하면서 **해시 공식이**
  // 바뀐다 → 이 상수도 이동한다. **동작은 안 바뀌었다**는 것을 값을 베끼지 않고 독립 검증했다:
  // 새 트리의 최종 상태에 **구 hashState 공식**(possessionSince·plan 미포함)을 적용하면
  // 구 상수 a7be3a33 / 9d21c53c 가 그대로 나온다(= 좌표·피로·스코어·소유가 비트동일).
  // 같은 방식으로 데모 골든도 d58237c3 재현 확인. (S1 은 동작 변경 0 이 목표다.)
  // #279 사슬 채택(engine@0.24.0): **이번엔 해시 공식이 아니라 동작이 바뀌었다** — 볼 소유자
  // 결정 코어가 `chain.mode: "weighted" → "chain"` 으로 교체됐다(hero A/B 실관전 채택). 롤백
  // 스위치는 시야(#147)·코너(#182) 두 개뿐이라 코어 교체는 여기서 되돌려지지 않는다. 코어까지
  // 되돌리려면 `chain.mode: "weighted"`(= 0.23.0 동작). 이 상수의 역할은 그대로다 —
  // "롤백 경로가 **조용히** 드리프트하지 않는다".
  // #307(프리킥 벽/백업 · 데드볼 도착 페이싱 · 정지 중 teamplan 갱신): 또다시 **동작 변경**이라
  // 롤백 경로 해시도 같이 움직인다. 데드볼 규칙(#176)과 마찬가지로 이 셋은 롤백 스위치 대상이
  // 아니라 무조건 적용이다(끄는 노브는 `rules.deadBall.pacedArrival` ·
  // `setPiece.freeKick.enabled` 로 따로 있다). 상수의 역할은 그대로 — "조용한 드리프트 금지".
  const ROLLBACK_HASH = "68abbc65";
  // #182 재보정(foul.base 0.017→0.0178)으로 marked 변형의 해시가 바뀐다.
  // ⚠️ **내 트리 출력을 베끼지 않았다** — `origin/main`(6f1b12b) 를 별도 워크트리로 체크아웃해
  // 같은 foul.base 를 넣고 독립 도출한 값이다(main 에는 corner 기능 자체가 없다):
  //   foul 0.017  → plain 9bc816ea · marked d63d417e
  //   foul 0.0178 → plain 9bc816ea · marked **fb490748**
  // plain 이 안 바뀐 건 그 매치에서 Δ0.0008 폭에 걸린 파울 롤이 하나도 없었기 때문(정상).
  //
  // ⚠️ 이 대조가 말하는 것과 말하지 않는 것(gameqa 회귀판정 정정):
  //  · 말하는 것 — **같은 튜닝값에서** corner 스위치를 끄면 코너 기능이 결과에 아무 기여도 하지
  //    않는다(= 스위치가 제 일을 한다: 레거시 전원전진 동작 복원).
  //  · 말하지 않는 것 — "롤백하면 main 을 재현한다"는 **아니다**. foul.base 0.017→0.0178 은
  //    코너와 무관한 **전역 노브**라 롤백 상태에서도 경기가 달라진다(gameqa 실측: corner off 고정
  //    후 foul 만 바꿔 7시드 대조 → **3건만 동일**). 이 스위치는 "코너 동작 롤백"이지
  //    "main 비트동등 복원"이 아니다.
  const ROLLBACK_HASH_MARKED = "66c92a53"; // #307 데드볼 배치 변경 — 위 ROLLBACK_HASH 와 같은 이유(동작 변경).

  // #176: 데드볼 접근 금지 규칙은 **롤백 스위치 없이 무조건 적용**(hero 결정)이라 vision-off 출력도
  // 함께 움직인다. 이 상수의 목적은 "레거시와 같다"가 아니라 **"롤백 경로가 조용히 드리프트하지
  // 않는다"** 이므로(#181 재정의) 규칙 도입으로 값이 바뀌는 것은 정상이다. 규칙이 롤백 대상이
  // 아니라는 **의미**는 아래 구조 계약이 따로 지킨다(해시만으론 못 잡는다).

  it("vision.enabled=true 는 실제로 결과를 바꾼다(계층이 죽어있지 않다)", () => {
    expect(lastHash(run(cfg))).not.toBe(lastHash(run(off)));
  });

  it("롤백(enabled=false)은 조용히 드리프트하지 않는다 — 골든 해시로 박제", () => {
    // "롤백 경로가 안 바뀌었다" 를 문장이 아니라 상수로 고정한다. 이게 없으면 롤백 스위치가
    // 조용히 어긋나도 아무도 못 잡는다(검증 세션 minor-5).
    expect(lastHash(run(off))).toBe(ROLLBACK_HASH);
    expect(lastHash(run(off, "A9"))).toBe(ROLLBACK_HASH_MARKED);
  });

  /**
   * 해시 가드(위)와 **짝을 이루는 의미 계약**. 해시는 "롤백 경로가 움직였다"만 알려주고 그게
   * 정당한 변경인지 말해주지 않는다 — 실제로 이 값은 #181(공 물리)·#182(파울 재보정)·#176(데드볼
   * 규칙)에서 연달아 갱신됐다. 갱신할 때마다 **무엇이 지켜져야 하는지**는 사람이 다시 판단해야
   * 하므로, 그 판단 기준을 구조로 박아 둔다:
   *   "롤백 스위치는 **시야 계층만** 끈다 — 데드볼 접근 금지 규칙(Law 8/13/14/15/16/17)은
   *    hero 결정으로 롤백 스위치가 없고, 따라서 vision-off 에서도 살아 있어야 한다."
   */
  it("롤백(enabled=false)이 데드볼 규칙까지 끄지는 않는다 — 규칙은 롤백 대상이 아님(#176)", () => {
    const log = run(off);
    const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
    let checked = 0;
    const viol: string[] = [];
    for (const e of log.events) {
      if (e.type !== "kickoff" || e.detail !== "goal_kick" || !e.team) continue;
      const s0 = byTick.get(e.tick);
      if (!s0) continue;
      const gx = e.team === "home" ? 0 : cfg.pitch.width;
      const oppPrefix = e.team === "home" ? "A" : "H";
      // 골킥 선언 후 정지가 끝날 때까지(공이 스팟을 떠나기 전) 상대는 차는 팀 박스 밖이어야 한다.
      let last = e.tick;
      for (let t = e.tick + 1; t <= e.tick + 45; t++) {
        const s = byTick.get(t);
        if (!s || s.ballOwner == null) break;
        if (Math.hypot(s.ball.x - s0.ball.x, s.ball.y - s0.ball.y) > 0.3) break;
        last = t;
      }
      const sEnd = byTick.get(last);
      if (!sEnd || last === e.tick) continue;
      checked++;
      for (const p of sEnd.players) {
        if (!p.playerId.startsWith(oppPrefix) || p.playerId === `${oppPrefix}0`) continue;
        const inBox =
          Math.abs(p.pos.x - gx) < cfg.rules.penalty.boxDepthM - 0.05 &&
          Math.abs(p.pos.y - cfg.pitch.height / 2) < cfg.rules.penalty.boxHalfWidthM - 0.05;
        if (inBox) viol.push(`t${last} ${p.playerId} 박스 안`);
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(viol, viol.join(" | ")).toEqual([]);
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
