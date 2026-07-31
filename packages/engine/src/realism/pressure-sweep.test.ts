import { describe, it, expect } from "vitest";
import { defaultEngineConfig, type EngineConfig } from "../config";
import { GUARD_SEEDS, REALISM_SEEDS, aggregateRealism } from "./harness";
import { aggregateDeepen } from "./deepen";
import { collectOneOnOne } from "./one-on-one";
import { BENCH, benchVerdict, inBench } from "./bench";

/**
 * #353 압박 축 **경계 있는 스윕 · 귀속 측정**(env 가드). `npm test` 에서는 skip.
 * 실행: `HMB_PRESS=1 npx vitest run packages/engine/src/realism/pressure-sweep.test.ts`
 * 점 지정: `HMB_PRESS_SPEC='[{"label":"legacy","chain.hold.keepBase":1,...}]'`
 * 20시드로 빠르게: `HMB_PRESS_20=1`
 *
 * 왜 별도 드라이버인가: 이 웨이브는 서로 다른 세 축(홀드 턴오버 · 슛 압박 · 리시버 압박)을
 * 얹는데, 각 축이 만든 이동을 **귀속**하려면 같은 표에 (행동 분포 · 벤치 밴드 · 라인브레이크)를
 * 한 번에 찍어야 한다. `volume-sweep`(밴드만) · `1v1 프로브`(행동 분포만)는 각각 반쪽이다.
 * 계산은 전부 기존 집계기 재사용이다(`aggregateRealism` · `aggregateDeepen` · `collectOneOnOne`).
 */

const ENV = (process as unknown as { env?: Record<string, string | undefined> }).env;
const GEN = ENV?.HMB_PRESS;
const SEEDS = ENV?.HMB_PRESS_20 ? REALISM_SEEDS : GUARD_SEEDS;

type Point = Record<string, number>;

/** "chain.hold.keepBase" 같은 점표기 경로 → 값. */
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

/** 이 웨이브 전(engine@0.27.0)의 노브 값 — 대조군. */
const LEGACY: Point = {
  "chain.hold.keepBase": 1,
  "chain.hold.pressPenalty": 0,
  "chain.hold.tightPenalty": 0,
  "contest.shotPressureXgMult": 1,
  "contest.shotPressureAimPenalty": 0,
  "contest.passReceiverPressurePenalty": 0,
};

/** 격자 스윕에서는 심화 집계(가장 비싼 축)를 끈다 — `HMB_PRESS_FAST=1`. */
const FAST = !!ENV?.HMB_PRESS_FAST;

function row(label: string, p: Point): void {
  const c = cfg(p);
  const one = collectOneOnOne(c, SEEDS, [10]);
  const b = aggregateRealism(c, SEEDS);
  const d = FAST
    ? { mean: { inBehindPasses: NaN, seqPasses: NaN, backwardPct: NaN } }
    : aggregateDeepen(c, SEEDS);
  const pct = (n: number): string => ((100 * n) / one.inRange).toFixed(1);
  const bands = BENCH.map((bm) => {
    const v = bm.key === "goalsPerMatch" ? b.goalsPerMatch : b.mean[bm.key];
    return inBench(v, bm) ? null : `${bm.label}=${v.toFixed(2)} ${benchVerdict(v, bm)}`;
  }).filter((x): x is string => x !== null);
  const bucket = one.buckets[0]!;
  // eslint-disable-next-line no-console
  console.log(
    `\n=== ${label} ===\n` +
      `사거리안 결정 ${one.inRange} → shoot ${pct(one.inRangeByKind.shoot)}% · pass ${pct(one.inRangeByKind.pass)}% · ` +
      `carry ${pct(one.inRangeByKind.dribble)}% · **hold ${pct(one.inRangeByKind.hold)}%**\n` +
      `1v1(10m) 에피소드 ${(bucket.openEpisodes / one.matches).toFixed(2)}/경기 · 슛전환 ` +
      `${((100 * bucket.openEpisodesWithShot) / Math.max(1, bucket.openEpisodes)).toFixed(1)}% · ` +
      `라벨 ${(one.oneOnOneEvents / one.matches).toFixed(3)}/경기\n` +
      `골/경기 ${b.goalsPerMatch.toFixed(2)} · 슛 ${b.mean.shots.toFixed(2)} · 유효슛 ${b.mean.onTarget.toFixed(2)} · ` +
      `xG/슛 ${b.mean.xgPerShot.toFixed(3)} · 패스성공 ${b.mean.passSuccessPct.toFixed(2)}% · ` +
      `코너 ${b.mean.corners.toFixed(2)} · 스로인 ${b.mean.throwIns.toFixed(2)} · 팀폭 ${b.mean.avgWidthM.toFixed(2)} · ` +
      `파울 ${b.mean.fouls.toFixed(2)}\n` +
      `라인브레이크 수신 ${d.mean.inBehindPasses.toFixed(2)} · 시퀀스당 패스 ${d.mean.seqPasses.toFixed(2)} · ` +
      `백패스 ${d.mean.backwardPct.toFixed(2)}%\n` +
      `밴드 이탈: ${bands.length === 0 ? "없음" : bands.join(" | ")}`,
  );
}

describe("#353 압박 축 스윕", () => {
  it.skipIf(!GEN)("점별 행동분포 · 밴드 · 라인브레이크", () => {
    const spec = ENV?.HMB_PRESS_SPEC;
    const pts = (
      spec
        ? (JSON.parse(spec) as unknown[])
        : [{ label: "legacy(0.27.0)", ...LEGACY }, { label: "now" }]
    ) as (Point & { label?: unknown })[];
    for (const p of pts) row(String(p.label ?? "?"), p as Point);
    expect(pts.length).toBeGreaterThan(0);
  }, 7_200_000);
});
