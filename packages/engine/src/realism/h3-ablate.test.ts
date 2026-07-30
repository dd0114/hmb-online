import { describe, it, expect } from "vitest";
import { runMatch } from "../match";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { measureDeadBallMotion } from "./deadball-motion";

/** #307 진단용 아블레이션(env 가드). HMB_H3=1 로만 실행. */
const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_H3;
const SEEDS = REALISM_SEEDS.slice(0, 6);
const select = makeSelectData();

function variant(name: string, cfg: EngineConfig): string {
  const rows = SEEDS.map((seed) => {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
    const m = measureDeadBallMotion(log);
    // 진단 하네스와 같은 정의의 "팀 평균 <0.3m 틱 비율"
    const snaps = log.tickSnapshots;
    const dead = new Set<number>();
    for (const e of log.events) {
      if (["kickoff", "free_kick", "penalty", "goal", "foul", "offside", "half_whistle"].includes(e.type)) {
        for (let t = e.tick - 2; t <= e.tick + 16; t++) dead.add(t);
      }
    }
    let still = 0;
    let n = 0;
    let sum = 0;
    const avgs: number[] = [];
    for (let i = 1; i < snaps.length; i++) {
      const cur = snaps[i]!;
      if (!dead.has(cur.tick)) continue;
      const prev = new Map(snaps[i - 1]!.players.map((p) => [`${p.team}:${p.playerId}`, p]));
      let moved = 0;
      let k = 0;
      for (const p of cur.players) {
        const q = prev.get(`${p.team}:${p.playerId}`);
        if (!q) continue;
        const d = Math.hypot(p.pos.x - q.pos.x, p.pos.y - q.pos.y);
        if (d > 12) continue;
        moved += d;
        k++;
      }
      if (k > 0) {
        const avg = moved / k;
        n++;
        sum += avg;
        avgs.push(avg);
        if (avg < 0.3) still++;
      }
    }
    avgs.sort((a, b) => a - b);
    return {
      jitter: m.jitterPer100,
      lone: m.loneSprintPer100,
      max: m.maxStepM,
      still: (still / n) * 100,
      mean: sum / n,
      med: avgs[Math.floor(avgs.length / 2)]!,
      p10: avgs[Math.floor(avgs.length * 0.1)]!,
    };
  });
  const avg = (f: (r: (typeof rows)[number]) => number): number => rows.reduce((s, r) => s + f(r), 0) / rows.length;
  return `${name.padEnd(28)} jitter ${avg((r) => r.jitter).toFixed(2)}/100 · lone ${avg((r) => r.lone).toFixed(2)} · max ${avg((r) => r.max).toFixed(2)} · still ${avg((r) => r.still).toFixed(1)}% · mean ${avg((r) => r.mean).toFixed(3)} · med ${avg((r) => r.med).toFixed(3)} · p10 ${avg((r) => r.p10).toFixed(3)}`;
}

describe("#307 H3 아블레이션", () => {
  it.skipIf(!GEN)("각 축을 하나씩 꺼서 원인 분리", () => {
    const base = defaultEngineConfig;
    const off = (o: Partial<EngineConfig["rules"]["deadBall"]>): EngineConfig => ({
      ...base,
      rules: { ...base.rules, deadBall: { ...base.rules.deadBall, ...o } },
    });
    const lines = [
      variant("현행(전부 on)", base),
      variant("pace off", off({ pacedArrival: false })),
      variant("smooth off", off({ idleDriftSmooth: false })),
      variant("pace+smooth off", off({ pacedArrival: false, idleDriftSmooth: false })),
      variant("freeKick off", {
        ...base,
        setPiece: { ...base.setPiece, freeKick: { ...base.setPiece.freeKick, enabled: false } },
      }),
      variant("전부 off(기준선)", {
        ...base,
        rules: { ...base.rules, deadBall: { ...base.rules.deadBall, pacedArrival: false, idleDriftSmooth: false } },
        setPiece: { ...base.setPiece, freeKick: { ...base.setPiece.freeKick, enabled: false } },
      }),
    ];
    // eslint-disable-next-line no-console
    console.log("\n" + lines.join("\n") + "\n");
    expect(lines.length).toBeGreaterThan(0);
  }, 900_000);
});
