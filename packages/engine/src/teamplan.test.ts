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
    const s = freshState();
    expect(s.plan.home.lineX).toBe(computeTeamPlan(s, "home", config, pitch).lineX);
    expect(s.plan.away.lineX).toBe(computeTeamPlan(s, "away", config, pitch).lineX);
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
