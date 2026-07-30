import { describe, it, expect } from "vitest";
import { runMatch } from "../match";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

/** #307 진단용: `wallSetupTicks` 가 벽 형성에 실제로 필요한가(env 가드). HMB_WALL=1. */
const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_WALL;
const SEEDS = REALISM_SEEDS.slice(0, 8);
const select = makeSelectData();
const W = defaultEngineConfig.pitch.width;
const H = defaultEngineConfig.pitch.height;

function measure(ticks: number): string {
  const cfg: EngineConfig = {
    ...defaultEngineConfig,
    setPiece: {
      ...defaultEngineConfig.setPiece,
      freeKick: { ...defaultEngineConfig.setPiece.freeKick, wallSetupTicks: ticks },
    },
  };
  const walls: number[] = [];
  let inplay = 0;
  let total = 0;
  for (const seed of SEEDS) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
    const restarts = new Set(
      log.events.filter((e) => e.type === "free_kick" || e.type === "penalty" || e.type === "kickoff").map((e) => e.tick),
    );
    total += log.tickSnapshots.length;
    inplay += log.tickSnapshots.filter((s) => s.ballOwner != null || true).length; // placeholder
    for (const e of log.events) {
      if (e.type !== "free_kick" || !e.team) continue;
      const s0 = byTick.get(e.tick);
      if (!s0) continue;
      const spot = s0.ball;
      let kt = e.tick;
      for (let t = e.tick + 1; t <= e.tick + 60; t++) {
        const s = byTick.get(t);
        if (!s) break;
        if (s.ballOwner == null || Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 0.3) break;
        if (restarts.has(t)) break;
        kt = t;
      }
      const sk = byTick.get(kt);
      if (!sk) continue;
      const goal = { x: e.team === "home" ? W : 0, y: H / 2 };
      const dGoal = Math.hypot(spot.x - goal.x, spot.y - goal.y);
      if (dGoal > 30 || Math.abs(spot.y - goal.y) > 20) continue;
      const opp = e.team === "home" ? "A" : "H";
      walls.push(
        sk.players.filter((p) => {
          if (!p.playerId.startsWith(opp)) return false;
          const d = Math.hypot(p.pos.x - spot.x, p.pos.y - spot.y);
          return d >= 7 && d <= 13 && (goal.x - spot.x) * (p.pos.x - spot.x) > 0;
        }).length,
      );
      // 창 길이
      inplay += kt - e.tick;
    }
  }
  const m = walls.reduce((s, v) => s + v, 0) / walls.length;
  const zero = walls.filter((v) => v === 0).length;
  void total;
  return `wallSetupTicks=${String(ticks).padStart(2)} → 벽 평균 ${m.toFixed(2)}명 · 벽 0명 ${zero}/${walls.length}건 · 프리킥 정지틱 합 ${inplay}`;
}

describe("#307 wallSetupTicks 아블레이션", () => {
  it.skipIf(!GEN)("정지 가산이 벽 형성에 필요한가", () => {
    const lines = [measure(0), measure(3), measure(6), measure(9)];
    // eslint-disable-next-line no-console
    console.log("\n" + lines.join("\n") + "\n");
    expect(lines.length).toBe(4);
  }, 900_000);
});
