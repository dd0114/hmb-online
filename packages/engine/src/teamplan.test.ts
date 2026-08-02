import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { runFirstHalf } from "./match";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import { defaultEngineConfig } from "./config";
import { createPitch } from "./pitch";
import { hashState } from "./hash";
import { setPossession, type SimState } from "./simstate";
import { computeTeamPlan } from "./teamplan";
import { restartThrowIn } from "./contest";

/**
 * #279 S1 — 상태 골격 계약.
 *
 * 여기서 박제하는 것은 **뒤 스테이지(S2~S7)가 매달릴 상태의 성질**이다.
 *  1) 소유 전환은 `setPossession` 한 지점으로만 일어난다(직접 대입 0) — 훅이 없으면 S4 가 전환을 못 본다.
 *  2) `reason` 이 전환의 종류를 구분한다 — 재시작(스로인/프리킥/코너)은 **턴오버가 아니다**.
 *     이걸 안 하면 S4 의 카운터프레스가 스로인마다 발동한다.
 *  3) 팀 계획은 **순수·배열순서 무관**(결정론 규율 §5-1/3).
 *  4) 새 상태는 `hashState` 에 들어간다 — 해시에 없는 상태는 유실돼도 그 틱을 통과하고
 *     다음 틱부터 갈라진다(무음 desync, §5-6).
 */

const config = defaultEngineConfig;
const pitch = createPitch(config);

function freshState(): SimState {
  return runFirstHalf(demoSeed, demoHome, demoAway, demoSelect, config).state;
}

describe("#279 S1 — setPossession 훅", () => {
  it("contest.ts 에 `state.possession =` 직접 대입이 0건이다 (전환 훅 우회 금지)", () => {
    const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "contest.ts"), "utf8");
    const hits = src.split("\n").filter((l) => /state\.possession\s*=/.test(l));
    expect(hits, `직접 대입 발견:\n${hits.join("\n")}`).toEqual([]);
  });

  it("turnover: 소유가 실제로 바뀌면 possessionSince 와 lastTurnover(공 좌표 포함)를 남긴다", () => {
    const s = freshState();
    s.possession = "home";
    s.ball.posFx.x = 1234;
    s.ball.posFx.y = 5678;
    setPossession(s, "away", 400, "turnover");
    expect(s.possession).toBe("away");
    expect(s.possessionSince).toBe(400);
    expect(s.lastTurnover).toEqual({ side: "away", tick: 400, xFx: 1234, yFx: 5678 });
  });

  it("restart/kickoff/goal: 소유가 바뀌어도 lastTurnover 는 남기지 않는다 (스로인 = 턴오버 아님)", () => {
    for (const reason of ["restart", "kickoff", "goal"] as const) {
      const s = freshState();
      s.possession = "home";
      s.lastTurnover = null;
      setPossession(s, "away", 500, reason);
      expect(s.possession).toBe("away");
      expect(s.possessionSince).toBe(500);
      expect(s.lastTurnover, `reason=${reason}`).toBeNull();
    }
  });

  it("같은 팀 안의 소유 이전(패스 성공)은 턴오버가 아니고 possessionSince 도 유지된다", () => {
    const s = freshState();
    s.possession = "home";
    s.possessionSince = 10;
    s.lastTurnover = null;
    setPossession(s, "home", 900, "turnover");
    expect(s.lastTurnover).toBeNull();
    expect(s.possessionSince).toBe(10);
  });

  it("실제 재시작 경로(restartThrowIn)는 lastTurnover 를 만들지 않는다", () => {
    const s = freshState();
    s.possession = "home";
    s.lastTurnover = null;
    restartThrowIn(s, pitch, config, "away", Math.round(pitch.wFx / 2), 0, 1200, 20);
    expect(s.possession).toBe("away");
    expect(s.lastTurnover).toBeNull();
  });
});

describe("#279 S1 — teamplan 훅", () => {
  it("computeTeamPlan 은 순수하다 (같은 상태 → 같은 결과)", () => {
    const s = freshState();
    expect(computeTeamPlan(s, "home", config, pitch)).toEqual(computeTeamPlan(s, "home", config, pitch));
    expect(computeTeamPlan(s, "away", config, pitch)).toEqual(computeTeamPlan(s, "away", config, pitch));
  });

  it("players 배열 순서에 의존하지 않는다 (퇴장 splice 로 순서가 바뀐다 — §5-3)", () => {
    const s = freshState();
    const before = { home: computeTeamPlan(s, "home", config, pitch), away: computeTeamPlan(s, "away", config, pitch) };
    s.players.reverse();
    expect(computeTeamPlan(s, "home", config, pitch)).toEqual(before.home);
    expect(computeTeamPlan(s, "away", config, pitch)).toEqual(before.away);
  });

  it("lineX 는 고정소수 정수다 (부동소수 금지 — 해시에 들어간다)", () => {
    const s = freshState();
    for (const side of ["home", "away"] as const) {
      const p = computeTeamPlan(s, side, config, pitch);
      expect(Number.isInteger(p.lineX)).toBe(true);
    }
  });

  /**
   * ⚠️ 비교 대상은 **마지막 틱이 끝난 상태**가 아니라 **그 틱이 시작할 때의 공 위치**다.
   *
   * 훅은 `stepTick` **앞**에서 돌고(결정론 규율 §5-1) 공은 그 틱 뒤쪽에서 움직인다. 그래서
   * "끝난 상태로 다시 계산한 값"과는 **한 틱치 공 이동만큼 어긋나는 것이 정상**이다.
   * 원래 이 계약은 그 차이를 무시하고 등식으로 박혀 있었고, 마지막 틱에 공이 안 움직이는
   * 시드 운으로 통과하고 있었다(#307 에서 데드볼 배치가 바뀌자 982fx = 0.98m 차이로 깨졌다).
   * 틱 시작 공 위치는 **직전 틱 스냅샷**에 남아 있으므로 그걸로 정확히 재현한다
   * (스냅샷은 실좌표 2자리 반올림이라 ±0.005m = 5fx 의 반올림 여유만 준다).
   */
  it("매치가 state.plan 을 채운다 (틱당 1회 갱신 훅 — 틱 시작 시점 공 기준)", () => {
    const carry = runFirstHalf(demoSeed, demoHome, demoAway, demoSelect, config);
    const s = carry.state;
    const lastTick = s.tick;
    const prev = carry.snapshots.find((sn) => sn.tick === lastTick - 1);
    expect(prev, "직전 틱 스냅샷이 있어야 한다").toBeTruthy();
    const probe: SimState = {
      ...s,
      ball: { ...s.ball, posFx: { x: Math.round(prev!.ball.x * config.fixedScale), y: Math.round(prev!.ball.y * config.fixedScale) } },
    };
    const TOL = 10; // 스냅샷 2자리 반올림(±5fx) 여유.
    for (const side of ["home", "away"] as const) {
      expect(Math.abs(s.plan[side].lineX - computeTeamPlan(probe, side, config, pitch).lineX), side).toBeLessThanOrEqual(TOL);
    }
    // 훅이 안 돌고 초기값에 굳어 있으면 위 비교가 우연히 통과할 수 있다 → 킥오프 시점(센터)의
    // 계획과 **다르다**는 것도 함께 본다(하프 종료 시 공이 센터에 정확히 있을 확률은 사실상 0).
    const kickoff: SimState = {
      ...s,
      ball: { ...s.ball, posFx: { x: Math.round(pitch.wFx / 2), y: Math.round(pitch.hFx / 2) } },
    };
    expect(s.plan.home.lineX).not.toBe(computeTeamPlan(kickoff, "home", config, pitch).lineX);
  });
});

describe("#279 S1 — hashState 가 새 상태를 흡수한다 (§5-6)", () => {
  it("possessionSince 가 다르면 해시가 다르다", () => {
    const s = freshState();
    const h0 = hashState(s);
    s.possessionSince += 1;
    expect(hashState(s)).not.toBe(h0);
  });

  it("plan.lineX 가 다르면 해시가 다르다 (home/away 각각)", () => {
    const s = freshState();
    const h0 = hashState(s);
    s.plan.home.lineX += 1;
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.plan.home.lineX -= 1;
    s.plan.away.lineX += 1;
    expect(hashState(s)).not.toBe(h0);
    expect(hashState(s)).not.toBe(h1);
  });
});

describe("#279 S1 후속 — 독립 검증 blocker 2건", () => {
  // blocker-2: 재개로 관통하는 상태는 **전부** 해시에 들어가야 한다(§5-6).
  // 초판은 lastTurnover 를 "possessionSince 와 같은 지점에서만 갱신된다"는 이유로 뺐는데,
  // 계측 결과 그 문장이 거짓이었다(유효 갱신 389 vs 281 — 서로 다른 지점 집합).
  it("lastTurnover 가 다르면 해시가 다르다 (null ↔ 값, 필드별)", () => {
    const s = freshState();
    const h0 = hashState(s);
    s.lastTurnover = { side: "home", tick: 10, xFx: 1000, yFx: 2000 };
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    for (const mutate of [
      (): void => { s.lastTurnover!.side = "away"; },
      (): void => { s.lastTurnover!.tick += 1; },
      (): void => { s.lastTurnover!.xFx += 1; },
      (): void => { s.lastTurnover!.yFx += 1; },
    ]) {
      const prev = hashState(s);
      mutate();
      expect(hashState(s)).not.toBe(prev);
    }
  });

  it("plan.blockDepth 가 다르면 해시가 다르다", () => {
    const s = freshState();
    const h0 = hashState(s);
    s.plan.home.blockDepth += 0.001;
    expect(hashState(s)).not.toBe(h0);
  });

  // blocker-1: S4/S5 자리를 **지금** 해시에 넣어 그 스테이지에서 골든을 다시 안 움직인다.
  it("phase 가 다르면 해시가 다르다 (S4 자리)", () => {
    const s = freshState();
    const h0 = hashState(s);
    s.phase.home = "final_third";
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.phase.home = "open";
    s.phase.away = "transition_lose";
    expect(hashState(s)).not.toBe(h0);
    expect(hashState(s)).not.toBe(h1);
  });

  it("intents 가 다르면 해시가 다르다 (S5 자리)", () => {
    const s = freshState();
    const h0 = hashState(s);
    s.intents = [
      { side: "home", fromId: "H6", kind: "pass_to", xFx: 500, yFx: 600, tick: 1, expiresTick: 5 },
    ];
    const h1 = hashState(s);
    expect(h1).not.toBe(h0);
    s.intents[0]!.kind = "run_to";
    expect(hashState(s)).not.toBe(h1);
  });

  // m1: teamplan 의 상수가 decision.ts 리터럴의 **이관**이라는 주장을 박제한다.
  // 누가 한쪽만 튜닝하면 state.plan.lineX 가 조용히 갈라지고 S3 소비 시점에 발현한다.
  it("computeTeamPlan.lineX 가 decision.ts 수비블록 공식과 등가다 (이중 소스 드리프트 가드)", () => {
    const s = freshState();
    const pitch = createPitch(defaultEngineConfig);
    for (const side of ["home", "away"] as const) {
      for (const dlh of [0, 0.35, 0.55, 1]) {
        s.teams[side] = { ...s.teams[side], defensiveLineHeight: dlh };
        s.ball.posFx.x = Math.round(pitch.wFx * 0.42);
        // decision.ts:decideOffBall 수비 분기의 blockCenterX 를 그대로 재현.
        // #377 S3-B: 구 리터럴 0.2 는 **config 로 승격**됐다(`movement.defLine.heightRangeX`,
        // §2-4). 가드의 주장은 그대로다 — 단일 출처가 이제 config 라, 리터럴을 다시 적으면
        // 이 가드가 막으려던 **이중 출처**를 가드 자신이 만들게 된다.
        const sign = side === "home" ? 1 : -1;
        const lineShift = (dlh - 0.5) * pitch.wFx * defaultEngineConfig.movement.defLine.heightRangeX;
        const expected =
          s.ball.posFx.x - sign * Math.round(pitch.wFx * 0.06) + sign * Math.round(lineShift);
        expect(computeTeamPlan(s, side, defaultEngineConfig, pitch).lineX).toBe(expected);
      }
    }
  });

  // #377 S3-B: 롤백 경로는 **구 상수 0.2** 를 쓴다 — 그래야 `defLine.enabled=false` 가 0.38.0 과
  // 비트 동일이다. 승격이 롤백을 조용히 오염시키지 않았다는 것을 따로 박제한다.
  it("롤백(defLine.enabled=false)은 승격 전 상수 0.2 를 쓴다", () => {
    const s = freshState();
    const pitch = createPitch(defaultEngineConfig);
    const off = JSON.parse(JSON.stringify(defaultEngineConfig)) as typeof defaultEngineConfig;
    off.movement.defLine.enabled = false;
    // 승격 값(0.5)과 구 상수(0.2)가 다른 값이어야 이 가드가 의미를 갖는다.
    expect(defaultEngineConfig.movement.defLine.heightRangeX).not.toBe(0.2);
    for (const side of ["home", "away"] as const) {
      s.teams[side] = { ...s.teams[side], defensiveLineHeight: 1 };
      s.ball.posFx.x = Math.round(pitch.wFx * 0.42);
      const sign = side === "home" ? 1 : -1;
      const expected =
        s.ball.posFx.x - sign * Math.round(pitch.wFx * 0.06) + sign * Math.round(0.5 * pitch.wFx * 0.2);
      expect(computeTeamPlan(s, side, off, pitch).lineX).toBe(expected);
    }
  });
});
