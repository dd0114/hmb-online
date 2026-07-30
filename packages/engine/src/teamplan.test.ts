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

  it("매치가 state.plan 을 채운다 (틱당 1회 갱신 훅)", () => {
    // `lineX` 는 **그 틱 시작 시점의 공 x** 로 계산된다(계획은 decide 루프 **앞**, §5-1).
    // 반면 여기서 다시 계산하면 **틱이 끝난 뒤의 공 x** 를 쓴다 — 마지막 틱에 공이 움직였으면
    // 두 값은 정확히 한 틱 분량만큼 다르다. 구 계약은 `toBe` 로 완전 일치를 요구해서,
    // "마지막 틱에 공이 안 움직였다"는 **우연**에 기대고 있었다(#312 로 공 세기가 바뀌자 깨졌다).
    //
    // 지켜야 하는 것은 "훅이 돌았고 같은 공식을 쓴다" 이지 "마지막 틱에 공이 멈춰 있었다" 가 아니다.
    // 그래서 허용 오차를 **공 한 틱 이동량**으로 둔다 — 훅이 빠지거나 다른 공식을 쓰면
    // (S1 기본값 0 이거나 피치 스케일로 어긋나므로) 이 오차 안에 절대 들어오지 않는다.
    const tol = Math.round(config.ball.passSpeedMax * config.fixedScale);
    for (const side of ["home", "away"] as const) {
      const s = freshState();
      const got = s.plan[side].lineX;
      const now = computeTeamPlan(s, side, config, pitch).lineX;
      expect(Number.isInteger(got)).toBe(true);
      expect(Math.abs(got - now), `${side} plan.lineX ${got} vs 재계산 ${now} (허용 ${tol})`)
        .toBeLessThanOrEqual(tol);
    }
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
        const sign = side === "home" ? 1 : -1;
        const lineShift = (dlh - 0.5) * pitch.wFx * 0.2;
        const expected =
          s.ball.posFx.x - sign * Math.round(pitch.wFx * 0.06) + sign * Math.round(lineShift);
        expect(computeTeamPlan(s, side, defaultEngineConfig, pitch).lineX).toBe(expected);
      }
    }
  });
});
