import { describe, it, expect } from "vitest";
import { defaultEngineConfig } from "../config";
import { aggregateRealism, GUARD_SEEDS, REALISM_SEEDS, pointConfig, type ConfigPoint } from "./harness";
import { BENCH, inBench, benchVerdict } from "./bench";
import { collectOneOnOne } from "./one-on-one";
import { countHeaders } from "./header";
import { collectFoul } from "./foul";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * #358 파울 재보정 **격자 스윕**(env 가드). `npm test` 에서는 skip.
 * 실행: `HMB_FOULSWEEP=1 HMB_FOULSWEEP_SPEC='[{"label":"...","rules.foul.base":0.1}]' \
 *        npx vitest run packages/engine/src/realism/foul-sweep.test.ts`
 *
 * `volume-sweep` 과 같은 패턴이고 조립 함수(`harness.pointConfig`)도 **공유**한다. 다른 점은
 * 한 줄에 **파울 계열 파생값**(PK/경기 · 프리킥/경기 · 시도/경기 · 시도당 파울률 · 파울의
 * hold/dribble 분해)까지 같이 낸다는 것 — 파울 총량만 맞추고 **장면**을 놓치는 것을 막으려면
 * "어디서 났는가"가 같은 줄에 있어야 한다.
 */
const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env;
const GEN = ENV?.HMB_FOULSWEEP;
const SEEDS = ENV?.HMB_FOULSWEEP_20 ? REALISM_SEEDS : GUARD_SEEDS;
/** 볼륨·구조 밴드 — 파울을 맞추다 이걸 깨면 재보정 실패다. */
const BAND_KEYS = [
  "shots", "onTarget", "shotConvPct", "xgPerShot",
  "passSuccessPct", "throwIns", "corners", "avgWidthM", "fouls", "yellowCards",
] as const;

function row(label: string, p: ConfigPoint): void {
  const c = pointConfig(defaultEngineConfig, p);
  const b = aggregateRealism(c, SEEDS);
  const bands = BAND_KEYS.map((k) => {
    const bm = BENCH.find((x) => x.key === k)!;
    const v = b.mean[k];
    return `${bm.label}=${v.toFixed(2)}${inBench(v, bm) ? "" : "!" + benchVerdict(v, bm)}`;
  }).join(" ");

  const f = collectFoul(c, SEEDS);
  const m = f.matches;
  const foulDetail =
    `PK=${(f.ev.penalty / m).toFixed(2)}/경기 FK=${(f.ev.freeKick / m).toFixed(2)}/경기 ` +
    `시도=${(f.attempts / m).toFixed(0)} 시도당파울=${((f.fouls / Math.max(1, f.attempts)) * 100).toFixed(2)}% ` +
    `파울출처 hold=${f.foulsByKind.hold} dribble=${f.foulsByKind.dribble} ` +
    `(달리는중 ${((f.foulsByKind.dribble / Math.max(1, f.foulsByKind.hold + f.foulsByKind.dribble)) * 100).toFixed(0)}%)`;

  let q = "";
  if (ENV?.HMB_FOULSWEEP_Q) {
    const r = collectOneOnOne(c, SEEDS);
    const holdPct = r.inRange > 0 ? (r.inRangeByKind.hold / r.inRange) * 100 : 0;
    const select = makeSelectData();
    const logs = SEEDS.map((s) => runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, c));
    const h = countHeaders(logs);
    q =
      ` || hold%=${holdPct.toFixed(1)} 1v1/경기=${(r.oneOnOneEvents / r.matches).toFixed(3)}` +
      ` header슛=${h.headerShots} header골=${h.headerGoals}`;
  }
  // eslint-disable-next-line no-console
  console.log(
    `${label} → goals/match=${b.goalsPerMatch.toFixed(2)} | ${bands} | ${foulDetail}${q}`,
  );
}

describe("#358 파울 재보정 스윕", () => {
  it.skipIf(!GEN)("격자", () => {
    const spec = ENV?.HMB_FOULSWEEP_SPEC;
    if (!spec) {
      row("baseline", {});
      expect(true).toBe(true);
      return;
    }
    const pts = JSON.parse(spec) as (ConfigPoint & { label: unknown })[];
    for (const p of pts) row(String(p.label), p as ConfigPoint);
    expect(pts.length).toBeGreaterThan(0);
  }, 14_400_000);
});
