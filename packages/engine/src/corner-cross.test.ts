import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #31 코너 크로스 계약: 코너킥은 taker 가 공을 몰고 나가는 게 아니라 **코너 아크에서 박스로
 * 딜리버리(크로스)** 되어야 한다. hero 보고: "코너를 중앙선까지 드리블해 가져온다".
 * 두 불변조건:
 *  (A) 딜리버리: 코너 후 공이 공격팀 페널티에어리어로 배달된다(중앙선 드리블 아님).
 *  (B) 무드리프트(독립 QA #31 발견): 정지("코너킥!") 동안 taker 가 공을 몰고 코너에서 걸어
 *      나가면 안 된다 — 크로스는 코너 아크에서 출발해야 한다.
 */

const config = defaultEngineConfig;
const W = config.pitch.width; // 105
const CENTER_Y = config.pitch.height / 2; // 34
const STOP = config.setPiece.stoppageTicks; // 12

// 페널티에어리어 ≈ 골라인 16.5m 깊이 · 중앙 ±20m. near-post 경합 크로스도 박스로 인정(중앙 고집 X).
const PEN_DEPTH_M = 18;
const PEN_HALFW_M = 22;

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  return new Map(log.tickSnapshots.map((s) => [s.tick, s]));
}
const attackGoalX = (side: string) => (side === "home" ? W : 0);

/**
 * 판정 가능한 코너만: 크로스 완료 창(정지+비행)이 하프타임/경기종료 경계를 넘지 않는 코너.
 * 하프 휘슬이 크로스를 끊으면(킥오프 리셋) 판정이 무의미하므로 제외.
 */
function usableCorners(log: MatchLog) {
  const lastTick = log.tickSnapshots[log.tickSnapshots.length - 1]!.tick;
  const halfW = log.events.find((e) => e.type === "half_whistle");
  const half = halfW ? halfW.tick : Math.floor((lastTick + 1) / 2);
  const win = STOP + 8;
  return log.events
    .filter((e) => e.type === "kickoff" && e.detail === "corner")
    .filter((e) => e.tick + win <= lastTick) // 경기 종료 전 완료
    .filter((e) => !(e.tick < half && e.tick + win > half)); // 하프 경계 안 넘음
}

describe("corner cross (#31)", () => {
  it("(A) 코너 후 공이 taker 드리블이 아니라 페널티에어리어로 딜리버리된다", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const corners = usableCorners(log);
    expect(corners.length).toBeGreaterThan(0);

    for (const c of corners) {
      const gx = attackGoalX(c.team!);
      let delivered = false;
      let closest = { tick: -1, dGoal: 1e9, dY: 1e9 };
      for (let t = c.tick + 1; t <= c.tick + STOP + 8; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const dGoal = Math.abs(s.ball.x - gx);
        const dY = Math.abs(s.ball.y - CENTER_Y);
        if (dGoal + dY < closest.dGoal + closest.dY) closest = { tick: t, dGoal, dY };
        if (dGoal <= PEN_DEPTH_M && dY <= PEN_HALFW_M) { delivered = true; break; }
      }
      expect(
        delivered,
        `corner@${c.tick}(${c.team}) 박스 미도달 — 창 내 최근접 t${closest.tick} ` +
          `골라인거리=${closest.dGoal.toFixed(1)}m |y-중앙|=${closest.dY.toFixed(1)}m`,
      ).toBe(true);
    }
  });

  it("(B) 코너 정지 동안 공이 코너 스팟에서 드리프트하지 않는다(taker 걸어나감 방지)", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const corners = usableCorners(log);
    expect(corners.length).toBeGreaterThan(0);

    const DRIFT_MAX_M = 6; // 정지 중 taker 정착 허용치. 버그(드리프트)는 29~45m 라 넉넉히 판별.
    for (const c of corners) {
      const spot = byTick.get(c.tick)!.ball; // 코너 배치 순간 = 코너 스팟.
      let maxDrift = 0;
      let worst = -1;
      for (let t = c.tick; t <= c.tick + STOP - 2; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) { maxDrift = d; worst = t; }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `corner@${c.tick}(${c.team}) 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m ` +
          `(t${worst}) — taker 가 코너에서 걸어 나감`,
      ).toBe(true);
    }
  });
});
