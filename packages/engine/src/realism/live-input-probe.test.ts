import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { pointConfig, aggregateRealism, GUARD_SEEDS, REALISM_SEEDS } from "./harness";
import { loadLiveInputs, runLive } from "./live-inputs";

/**
 * #370 진단 하네스 — **실입력 표본 위에서 노브를 스윕**한다. env 게이트(`HMB_LIVE=1`).
 *
 *   HMB_LIVE=1 npx vitest run packages/engine/src/realism/live-input-probe.test.ts
 *   HMB_LIVE=1 HMB_LIVE_SPEC='[{"label":"a","contest.shootXgThreshold":0.07}]' npx vitest run ...
 *   HMB_LIVE_FIX=1 → 같은 점을 픽스처(20/60시드)로도 재서 **두 레짐을 나란히** 찍는다.
 *
 * 계약이 아니라 **측정 도구**다. 계약은 `live-input-volume.test.ts`.
 */

const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env;
const GEN = ENV?.HMB_LIVE;
const FIXSEEDS = ENV?.HMB_LIVE_60 ? GUARD_SEEDS : REALISM_SEEDS;

describe("live-input probe (#370)", () => {
  it.skipIf(!GEN)("sweeps knobs on live inputs", () => {
    const spec = ENV?.HMB_LIVE_SPEC;
    const pts = spec
      ? (JSON.parse(spec) as (Record<string, number> & { label: unknown })[])
      : [{ label: "baseline" } as unknown as Record<string, number> & { label: unknown }];
    const samples = loadLiveInputs();
    for (const p of pts) {
      const c = pointConfig(defaultEngineConfig, p as Record<string, number>);
      const r = runLive(c, samples);
      const detail = r.perSample.map((s) => `${s.id}:${s.shots[0]}/${s.shots[1]}`).join(" ");
      // eslint-disable-next-line no-console
      console.log(
        `[live] ${String(p.label)} → minShots=${r.minShots} meanShots=${r.meanShots.toFixed(2)}` +
          ` minMatchShots=${r.minMatchShots} goals/match=${r.meanGoalsPerMatch.toFixed(2)}\n        ${detail}`,
      );
      if (ENV?.HMB_LIVE_FIX) {
        const b = aggregateRealism(c, FIXSEEDS);
        // eslint-disable-next-line no-console
        console.log(
          `[fix ] ${String(p.label)} → shots=${b.mean.shots.toFixed(2)} onTarget=${b.mean.onTarget.toFixed(2)}` +
            ` goals/match=${b.goalsPerMatch.toFixed(2)} pass=${b.mean.passSuccessPct.toFixed(2)}` +
            ` throwIns=${b.mean.throwIns.toFixed(2)} corners=${b.mean.corners.toFixed(2)}` +
            ` width=${b.mean.avgWidthM.toFixed(2)} fouls=${b.mean.fouls.toFixed(2)}` +
            ` long%=${b.mean.longShareOfAttempts.toFixed(2)}`,
        );
      }
    }
    expect(pts.length).toBeGreaterThan(0);
  }, 7_200_000);
});
