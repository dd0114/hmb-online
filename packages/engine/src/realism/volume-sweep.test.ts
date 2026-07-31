import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { aggregateRealism, GUARD_SEEDS, REALISM_SEEDS, pointConfig } from "./harness";
import { BENCH, inBench, benchVerdict } from "./bench";
import { collectOneOnOne } from "./one-on-one";
import { countHeaders } from "./header";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

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
  // #358: 조립은 `harness.pointConfig` 단일 출처(foul-sweep 과 같은 함수를 쓴다).
  return pointConfig(defaultEngineConfig, p);
}

/**
 * **품질 지표**(#357) — 볼륨만 맞추고 이걸 죽이면 재보정 실패다. `HMB_VOLSWEEP_Q=1` 로 켠다
 * (경기를 두 번 더 돌리므로 격자 스크리닝에서는 꺼 둘 수 있다. 연산 비용은 제약이 아니다 — #279).
 *
 * 세 지표 모두 **다른 파일의 측정 함수를 그대로 재사용**한다(계약과 진단이 갈리면 안 된다):
 *  · 사거리 안 hold 비율 · one_on_one 라벨 ← `one-on-one.ts`(#353/#316 이 쓰는 관측자)
 *  · 헤더 슛/골 ← `header.ts`(`ball-physics.test.ts` 계약이 쓰는 그 함수)
 */
function quality(c: EngineConfig, seeds: string[]) {
  const r = collectOneOnOne(c, seeds);
  const holdPct = r.inRange > 0 ? (r.inRangeByKind.hold / r.inRange) * 100 : 0;
  const shootPct = r.inRange > 0 ? (r.inRangeByKind.shoot / r.inRange) * 100 : 0;
  // `one_on_one` **라벨**은 60시드에 5건 수준이라 격자 판정에 못 쓴다(20시드면 0 이 정상).
  // 같은 것을 세는 **고빈도 대리 지표** = 단독(10m) 오픈플레이 에피소드 중 슛으로 끝난 비율.
  const free = r.buckets.find((b) => b.clearM === 10)!;
  const freeShotEpiPct = free.openEpisodes > 0 ? (free.openEpisodesWithShot / free.openEpisodes) * 100 : 0;
  const freeHoldPct = free.openTicks > 0 ? (free.byKindOpen.hold / free.openTicks) * 100 : 0;
  const select = makeSelectData();
  const logs = seeds.map((s) => runMatch(s, makeTacticalInput("H", s), makeTacticalInput("A", s), select, c));
  const h = countHeaders(logs);
  return {
    holdPct,
    shootPct,
    oneOnOnePerMatch: r.oneOnOneEvents / r.matches,
    freeShotEpiPct,
    freeHoldPct,
    headerShots: h.headerShots,
    headerGoals: h.headerGoals,
  };
}

function row(label: string, p: Point) {
  const c = cfg(p);
  const b = aggregateRealism(c, SEEDS);
  const struct = STRUCT_KEYS.map((k) => {
    const bm = BENCH.find((x) => x.key === k)!;
    return `${bm.label}=${b.mean[k].toFixed(2)}${inBench(b.mean[k], bm) ? "" : "!" + benchVerdict(b.mean[k], bm)}`;
  }).join(" ");
  let q = "";
  if (ENV?.HMB_VOLSWEEP_Q) {
    const s = quality(c, SEEDS);
    q =
      ` || hold%=${s.holdPct.toFixed(1)} shoot%=${s.shootPct.toFixed(1)} 단독슛에피%=${s.freeShotEpiPct.toFixed(1)}` +
      ` 단독hold%=${s.freeHoldPct.toFixed(1)} 1v1/경기=${s.oneOnOnePerMatch.toFixed(3)}` +
      ` header슛=${s.headerShots} header골=${s.headerGoals} long%=${b.mean.longShareOfAttempts.toFixed(2)}`;
  }
  // eslint-disable-next-line no-console
  console.log(
    `${label} → goals/match=${b.goalsPerMatch.toFixed(2)} teamGoals=${b.mean.goals.toFixed(2)} shots=${b.mean.shots.toFixed(2)} onTarget=${b.mean.onTarget.toFixed(2)} conv=${b.mean.shotConvPct.toFixed(2)}% xg/shot=${b.mean.xgPerShot.toFixed(3)} | ${struct}${q}`,
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
