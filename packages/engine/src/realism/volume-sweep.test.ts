import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { aggregateRealism, GUARD_SEEDS, REALISM_SEEDS } from "./harness";
import { BENCH, inBench, benchVerdict } from "./bench";

/**
 * #279 볼륨 재보정 — **경계 있는 스윕**(env 가드). npm test 에서는 skip.
 * 실행: HMB_VOLSWEEP=1 npx vitest run packages/engine/src/realism/volume-sweep.test.ts
 *
 * 배경: engine@0.25.0 (공 물리 3건 + 데드볼 2건) 합산으로 공 소유 틱 46.2%→25.2%,
 * 팀당 슛 7.27 · 골 0.99 로 볼륨이 붕괴했다. hero 지시 = "밸런스는 config 로. 중요한 건
 * 그런 플레이가 가능한지. **경기당 골 평균 5골**".
 *
 * 목표 = goalsPerMatch(양팀 합) ≈ 5.0. **코드 무변경, config 노브만.**
 * 손으로 더듬지 않기 위해 chain-sweep.test.ts 와 같은 격자 스윕 패턴을 쓴다.
 * 판정 표본은 GUARD_SEEDS(60) — 20시드로는 판정 못 하는 축이 있다(harness.ts 주석).
 */

const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env;
const GEN = ENV?.HMB_VOLSWEEP;
const SEEDS = ENV?.HMB_VOLSWEEP_20 ? REALISM_SEEDS : GUARD_SEEDS;

/** 구조 지표(볼륨 조정으로 깨지면 안 되는 것) — 이게 깨지면 조정을 잘못한 것이다. */
const STRUCT_KEYS = ["passSuccessPct", "avgWidthM", "corners", "throwIns", "fouls"] as const;

/** "chain.goalValue" 같은 점표기 경로 → 값. 격자 정의를 문자열로 넘길 수 있게 한다. */
type Point = Record<string, number>;

function cfg(p: Point): EngineConfig {
  const out = JSON.parse(JSON.stringify(defaultEngineConfig)) as EngineConfig;
  for (const [path, v] of Object.entries(p)) {
    if (path === "label") continue;
    const seg = path.split(".");
    let node = out as unknown as Record<string, unknown>;
    for (let i = 0; i < seg.length - 1; i++) node = node[seg[i]!] as Record<string, unknown>;
    node[seg[seg.length - 1]!] = v;
  }
  return out;
}

function row(label: string, p: Point) {
  const c = cfg(p);
  const b = aggregateRealism(c, SEEDS);
  const struct = STRUCT_KEYS.map((k) => {
    const bm = BENCH.find((x) => x.key === k)!;
    return `${bm.label}=${b.mean[k].toFixed(2)}${inBench(b.mean[k], bm) ? "" : "!" + benchVerdict(b.mean[k], bm)}`;
  }).join(" ");
  // eslint-disable-next-line no-console
  console.log(
    `${label} → goals/match=${b.goalsPerMatch.toFixed(2)} teamGoals=${b.mean.goals.toFixed(2)} shots=${b.mean.shots.toFixed(2)} onTarget=${b.mean.onTarget.toFixed(2)} conv=${b.mean.shotConvPct.toFixed(2)}% xg/shot=${b.mean.xgPerShot.toFixed(3)} | ${struct}`,
  );
  return b;
}

describe("volume recalibration sweep (engine@0.25.0)", () => {
  it.skipIf(!GEN)("scans knobs for goals/match ~= 5.0", () => {
    const spec = ENV?.HMB_VOLSWEEP_SPEC;
    if (!spec) {
      row("baseline", {});
      expect(true).toBe(true);
      return;
    }
    // spec = JSON array of {label, ...Point}
    const pts = JSON.parse(spec) as (Point & { label: unknown })[];
    for (const p of pts) row(String(p.label), p as Point);
    expect(pts.length).toBeGreaterThan(0);
  }, 7_200_000);
});
