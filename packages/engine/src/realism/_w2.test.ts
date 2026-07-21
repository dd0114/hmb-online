import { describe, it } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { REALISM_SEEDS, aggregateRealism } from "./harness";
import { measureSynchrony } from "./synchrony";

const c = defaultEngineConfig;
const S4 = REALISM_SEEDS.slice(0, 4);
const legacy: EngineConfig = { ...c, variety: { ...c.variety, noisePhasePerPlayer: false, roamContinuous: false } };
const A: EngineConfig = c;                                                   // roamCont + phase (period 25, amp 3)
const B: EngineConfig = { ...c, variety: { ...c.variety, roamPeriodTicks: 12 } };
const D: EngineConfig = { ...c, variety: { ...c.variety, roamPeriodTicks: 15, roamNoiseAmp: 5 } };

describe("w2 bands", () => {
  it("run", () => {
    for (const [n, cf] of [["LEGACY", legacy], ["A: roamCont(25/3)", A], ["B: +period12", B], ["D: period15/amp5", D]] as [string, EngineConfig][]) {
      const s = measureSynchrony(cf, S4);
      const g = aggregateRealism(cf, REALISM_SEEDS);
      const m = g.mean;
      console.log(
        `${n.padEnd(20)} R=${s.meanR.toFixed(3)} >0.9=${s.highRPct}% peak=${s.postFlipPeak} | ` +
        `패스${m.passSuccessPct}% 롱${m.longShareOfAttempts}% 슛${m.shots} 골${m.goals} xG/슛${m.xgPerShot} ` +
        `코너${m.corners} 스로인${m.throwIns} 폭${m.avgWidthM} 길이${m.avgLengthM} 거리${m.avgDistanceKm}km`,
      );
    }
  });
});
