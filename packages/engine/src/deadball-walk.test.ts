import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #59 엔진 네이티브 데드볼: taker 를 스팟에 즉시 순간배치하지 않고 공(스팟)으로 걸어가게 한다.
 *  - 공은 스팟에 정지 유지(no drift).
 *  - taker(공 소유자)는 여러 틱에 걸쳐 공으로 이동 — 프레임간 이동이 걷기 속도(≤MAX_STEP)라
 *    순간배치(15~40m 점프)가 아니다. 그리고 공에 도달한다.
 * 뷰어 트릭 없이 이 데이터로 자연 무브먼트가 재생된다.
 */
const config = defaultEngineConfig;
const STOP = config.setPiece.stoppageTicks;

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  return new Map(log.tickSnapshots.map((s) => [s.tick, s]));
}

describe("deadball taker walk (#59)", () => {
  it("코너/스로인 taker 가 공으로 걸어간다(순간배치 아님) + 공은 스팟 정지", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const restarts = log.events.filter(
      (e) => e.type === "kickoff" && (e.detail === "corner" || e.detail === "throw_in"),
    );
    expect(restarts.length).toBeGreaterThan(0);
    const MAX_STEP = 8; // 걷기 상한(빠른 선수 maxPerTick=7). 순간배치/클램프면 10~40m.
    const MAX_WIN = STOP + 18; // 동적 정지(도달까지 연장) 상한 초과 판정창.
    let checked = 0;
    for (const r of restarts) {
      const ci = r.tick;
      const c0 = byTick.get(ci);
      if (!c0 || !c0.ballOwner) continue;
      const spot = c0.ball;
      const takerId = c0.ballOwner;
      // ci-1(재시작 직전) 스냅샷 없으면 배치 점프 판정 불가 → 스킵.
      if (!byTick.get(ci - 1)) continue;
      checked++;
      let maxStep = 0;
      let reached = false;
      let ballLeft = false;
      let ranOut = false;
      let prevPos: { x: number; y: number } | null = null;
      // ci-1 부터 본다: **배치 순간(ci-1→ci)의 순간이동/클램프 점프까지** 잡는다(클램프 제거 검증).
      // 정지는 동적(taker 도달까지 연장)이므로 공이 스팟을 떠나면(재시작 실행) 종료.
      for (let t = ci - 1; t <= ci + MAX_WIN; t++) {
        const s = byTick.get(t);
        if (!s) { ranOut = true; break; }
        const tk = s.players.find((p) => p.playerId === takerId);
        if (!tk) continue;
        const ballOff = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 3;
        if (t > ci && ballOff) { ballLeft = true; break; } // 재시작 실행(크로스/스로인) → 정지 종료.
        if (prevPos && t >= ci) {
          maxStep = Math.max(maxStep, Math.hypot(tk.pos.x - prevPos.x, tk.pos.y - prevPos.y));
        }
        prevPos = { x: tk.pos.x, y: tk.pos.y };
        if (Math.hypot(tk.pos.x - spot.x, tk.pos.y - spot.y) <= config.contest.controlRange + 0.5) reached = true;
        if (t >= ci) {
          // 공은 스팟에 정지 유지(taker 가 걸어오는 동안 공은 안 움직임).
          expect(
            Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y),
            `restart@${ci} 공 드리프트 t${t} (${s.ball.x.toFixed(1)},${s.ball.y.toFixed(1)})`,
          ).toBeLessThan(1.5);
        }
      }
      // 경기 끝에 걸려 재시작 미완(공 안 떠남 + 스냅샷 소진 + 미도달) → 판정 불가, 제외.
      if (ranOut && !ballLeft && !reached) { checked--; continue; }
      expect(
        maxStep,
        `restart@${ci} taker(${takerId}) 단일틱 점프 ${maxStep.toFixed(1)}m — 순간배치/클램프(걷기 아님)`,
      ).toBeLessThanOrEqual(MAX_STEP);
      expect(reached, `restart@${ci} taker 가 공(스팟)에 도달 못 함(정지 시간 부족?)`).toBe(true);
    }
    expect(checked, "판정 가능한 코너/스로인 없음").toBeGreaterThan(0);
  });
});
