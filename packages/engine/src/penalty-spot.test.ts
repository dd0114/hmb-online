import { describe, it, expect } from "vitest";
import { runMatch } from "./match";
import { defaultEngineConfig } from "./config";
import { demoSeed, demoHome, demoAway, demoSelect } from "./fixtures";
import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * #48 페널티 스팟 무드리프트 계약: PK 는 페널티 스팟(정중앙)에서 실행돼야 한다.
 * restartPenalty 가 taker.posFx 만 스팟에 고정하고 targetFx 를 오픈플레이 잔여값으로 두면,
 * 세트피스 정지 동안 위치적분 루프(match.ts)가 taker 를 그 targetFx 로 걸어나가게 해 공이
 * 스팟에서 드리프트한다 — 코너/스로인의 #31 과 동일 메커니즘(restartSetPiece 는 targetFx 도
 * 스팟으로 핀). 페널티만 그 라인이 누락됐던 회귀를 박제한다.
 */
const config = defaultEngineConfig;
const CENTER_Y = config.pitch.height / 2; // 34
// default config(engine@0.12.0)에서 페널티가 발생하는 시드(스캔으로 확정). 재현 고정.
const PK_SEED = "3";

function snapByTick(log: MatchLog): Map<number, TickSnapshot> {
  return new Map(log.tickSnapshots.map((s) => [s.tick, s]));
}

describe("penalty spot no-drift (#48)", () => {
  it("PK 정지 동안 공이 페널티 스팟에서 드리프트하지 않는다(스팟에서 슛)", () => {
    const log = runMatch(PK_SEED, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const pens = log.events.filter((e) => e.type === "penalty");
    expect(pens.length, `시드 ${PK_SEED} 에 페널티가 있어야 한다(스캔 확정)`).toBeGreaterThan(0);

    const STOP = config.rules.penalty.stoppageTicks;
    const DRIFT_MAX_M = 2; // 스팟 정착 허용치. 버그 드리프트는 5m+ 라 넉넉히 판별.
    for (const p of pens) {
      const spot = byTick.get(p.tick)!.ball; // 선언 순간 = 페널티 스팟(정중앙).
      // 스팟 자체가 정중앙(y=34)인지 확인.
      expect(
        Math.abs(spot.y - CENTER_Y),
        `penalty@${p.tick} 스팟 y=${spot.y.toFixed(1)} 중앙 아님`,
      ).toBeLessThan(0.5);
      // 선언~슛(정지 종료)까지 공이 스팟에 머무는가.
      let maxDrift = 0;
      let worst = -1;
      for (let t = p.tick; t <= p.tick + STOP; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) {
          maxDrift = d;
          worst = t;
        }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `penalty@${p.tick} 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m (t${worst}) — taker 가 스팟에서 걸어나감`,
      ).toBe(true);
    }
  });

  // 프리킥도 restartSetPiece 를 거치지 않아 같은 targetFx 누락 버그가 있었다(#48 스윕에서 발견,
  // demoSeed free_kick@226 은 수정 전 22m 드리프트). 같은 1줄 수정으로 함께 해소 → 회귀 방지.
  it("free_kick 정지 동안 공이 스팟에서 드리프트하지 않는다", () => {
    const log = runMatch(demoSeed, demoHome, demoAway, demoSelect, config);
    const byTick = snapByTick(log);
    const fks = log.events.filter((e) => e.type === "free_kick");
    expect(fks.length).toBeGreaterThan(0);
    const STOP = config.rules.freeKickStoppageTicks;
    const DRIFT_MAX_M = 3;
    for (const fk of fks) {
      const spot = byTick.get(fk.tick)!.ball;
      let maxDrift = 0;
      let worst = -1;
      for (let t = fk.tick; t <= fk.tick + STOP; t++) {
        const s = byTick.get(t);
        if (!s) continue;
        const d = Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y);
        if (d > maxDrift) {
          maxDrift = d;
          worst = t;
        }
      }
      expect(
        maxDrift <= DRIFT_MAX_M,
        `free_kick@${fk.tick} 정지 중 공 드리프트 ${maxDrift.toFixed(1)}m (t${worst})`,
      ).toBe(true);
    }
  });
});
