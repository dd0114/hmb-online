import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS, aggregateRealism } from "./harness";
import { aggregateDeepen } from "./deepen";
import { BENCH, inBench } from "./bench";

/**
 * #279 W2 — chain 가치함수 **경계 있는 스윕**(env 가드). npm test 에서는 skip.
 * 실행: HMB_SWEEP=1 npx vitest run packages/engine/src/realism/chain-sweep.test.ts
 *
 * 왜 스윕인가: 손으로 노브를 더듬으면 hero 가 지적한 "계속 수정" 을 그대로 재현한다.
 * **벤치가 있는 지표로만** 점수를 매겨 격자에서 고른다(벤치 없는 지표로 튜닝하면 내 임계를 만드는 셈).
 *   점수 = 밴드 안 지표 수 − 다이렉트 스피드의 밴드(1.4–2.1) 밖 이탈량
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_SWEEP;
const SEEDS = REALISM_SEEDS.slice(0, 4);

interface Point {
  advanceExponent: number;
  threatWeight: number;
  discount: number;
}

const GRID: Point[] = [];
for (const advanceExponent of [1.5, 2.0, 3.0]) {
  for (const threatWeight of [8, 18, 30]) {
    for (const discount of [0.7, 0.85]) {
      GRID.push({ advanceExponent, threatWeight, discount });
    }
  }
}

function cfg(p: Point): EngineConfig {
  return { ...defaultEngineConfig, chain: { ...defaultEngineConfig.chain, mode: "chain", ...p } };
}

describe("#279 W2 chain value-function sweep", () => {
  it.skipIf(!GEN)("scores a bounded grid on benchmarked metrics only", () => {
    const rows: { p: Point; inBand: number; direct: number; shots: number; goals: number; score: number }[] = [];
    for (const p of GRID) {
      const c = cfg(p);
      const b = aggregateRealism(c, SEEDS);
      const d = aggregateDeepen(c, SEEDS);
      let inBand = 0;
      for (const bm of BENCH) {
        const v = bm.key === "goalsPerMatch" ? b.goalsPerMatch : b.mean[bm.key];
        if (inBench(v, bm)) inBand++;
      }
      const direct = d.mean.directSpeedMs;
      const dev = direct < 1.4 ? 1.4 - direct : direct > 2.1 ? direct - 2.1 : 0;
      const score = inBand - dev;
      rows.push({ p, inBand, direct, shots: b.mean.shots, goals: b.mean.goals, score });
      // eslint-disable-next-line no-console
      console.log(
        `exp=${p.advanceExponent} threat=${p.threatWeight} disc=${p.discount} → inBand=${inBand}/${BENCH.length} direct=${direct.toFixed(2)} shots=${b.mean.shots.toFixed(1)} goals=${b.mean.goals.toFixed(2)} score=${score.toFixed(2)}`,
      );
    }
    rows.sort((a, b) => b.score - a.score);
    // eslint-disable-next-line no-console
    console.log("\nTOP 5:\n" + rows.slice(0, 5).map((r) => `${JSON.stringify(r.p)} score=${r.score.toFixed(2)} inBand=${r.inBand} direct=${r.direct.toFixed(2)}`).join("\n"));
    expect(rows.length).toBe(GRID.length);
  }, 3_600_000);
});
