import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";
import { unownedRuns, type UnownedRun } from "./loft";

/**
 * loft-probe — **띄운 공(lofted)이 어디까지 가는가** 진단(env 가드). npm test 에서는 skip.
 * 실행: `HMB_LOFT=1 npx vitest run packages/engine/src/realism/loft-probe.test.ts`
 *
 * ## 이 프로브가 #327 의 진단을 뒤집었다
 * 최초 가설은 "감속 거리 188m 라 lofted 는 100% 필드 밖"이었는데, 실측은 **max 84.8m ·
 * >125m 0건**이었다. 대신 **마찰 지문**(스텝 감쇠비)이 진짜 결손을 보여줬다 — ≥3틱 구간
 * **600/990(61%)** 이 10틱 내내 비 0.92 로 감쇠했다. 즉 착지가 **안 일어난 것**이지 거리가
 * 폭발한 게 아니었다. 착지 판정이 "계획 낙하점 통과"에만 걸려 있어서, 조준이 피치 밖이거나
 * 도달 불가인 공은 그 시점이 영영 오지 않았다.
 * → 좌표·총량만 봤으면 못 잡았다. **감쇠비를 봐야 어느 마찰을 쓰는 중인지 보인다.**
 *
 * 측정 함수(`loft.ts`)는 계약(`ball-physics.test.ts` 의 피치 대각선 상한)과 **공유**한다 —
 * 진단과 계약이 다른 자를 쓰면 "진단은 좋아졌는데 계약은 안 움직인다"가 된다.
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_LOFT;

const cfg = defaultEngineConfig;
const select = makeSelectData();
const SEEDS = REALISM_SEEDS.slice(0, 8);

function logOf(seed: string): MatchLog {
  return runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
}

function pct(v: number[], q: number): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

describe("loft-probe — 띄운 공 비행거리", () => {
  it.skipIf(!GEN)("무소유 비행 구간의 총 경로장 분포 · 걷어내기 구간 · 아웃 종료 비율", () => {
    const all: UnownedRun[] = [];
    for (const seed of SEEDS) all.push(...unownedRuns(logOf(seed), seed));

    const paths = all.map((r) => r.pathM);
    const clr = all.filter((r) => r.fromClearance);
    const over = all.filter((r) => r.pathM > 125);
    const n = SEEDS.length;

    // 마찰 지문: 스텝 감쇠비의 중앙값. lofted(0.92) / ground(0.62) / shot 이 각각 다른 값을 낸다.
    const ratioOf = (s: number[]): number => {
      const rs: number[] = [];
      for (let i = 1; i < s.length; i++) rs.push(s[i]! / s[i - 1]!);
      return rs.length ? pct(rs, 0.5) : 0;
    };
    const loftOnly = all.filter((r) => r.ticks >= 3 && ratioOf(r.steps) >= 0.85);
    const groundish = all.filter((r) => r.ticks >= 3 && ratioOf(r.steps) < 0.85);
    const sum = (rs: UnownedRun[]): number => rs.reduce((t, r) => t + r.pathM, 0);

    const worst = [...all]
      .sort((a, b) => b.pathM - a.pathM)
      .slice(0, 8)
      .map(
        (r) =>
          `    ${r.seed} t${r.startTick} ${r.pathM.toFixed(1)}m (${r.ticks}틱, 직선 ${r.netM.toFixed(1)}m${r.fromClearance ? ", clearance" : ""})\n      ${r.steps.map((v) => v.toFixed(1)).join(" → ")}`,
      )
      .join("\n");

    /* eslint-disable no-console */
    console.log(`
=== loft-probe (${cfg.version}, ${n}시드) ===
  무소유 비행 구간        ${all.length}개 (${(all.length / n).toFixed(1)}/경기)
  경로장 m                평균 ${(paths.reduce((t, v) => t + v, 0) / Math.max(1, paths.length)).toFixed(1)} · p50 ${pct(paths, 0.5).toFixed(1)} · p90 ${pct(paths, 0.9).toFixed(1)} · p99 ${pct(paths, 0.99).toFixed(1)} · max ${Math.max(0, ...paths).toFixed(1)}
  >125m (피치 대각선)     ${over.length}개 = ${((100 * over.length) / Math.max(1, all.length)).toFixed(2)}%
  걷어내기 발 구간        ${clr.length}개 · 평균 경로장 ${(clr.reduce((t, r) => t + r.pathM, 0) / Math.max(1, clr.length)).toFixed(1)}m
  --- 마찰 지문(≥3틱 구간) ---
  착지 안 함(비 ≥0.85)   ${loftOnly.length}개 · 평균 ${(sum(loftOnly) / Math.max(1, loftOnly.length)).toFixed(1)}m · 총 ${sum(loftOnly).toFixed(0)}m
  지면 감쇠(비 <0.85)    ${groundish.length}개 · 평균 ${(sum(groundish) / Math.max(1, groundish.length)).toFixed(1)}m · 총 ${sum(groundish).toFixed(0)}m
  최장 8건:
${worst}
`);
    /* eslint-enable no-console */
    expect(all.length).toBeGreaterThan(0);
  });

  it.skipIf(!GEN)("스로인 귀속 — 직전 이벤트 종류별", () => {
    const tally = new Map<string, number>();
    let total = 0;
    for (const seed of SEEDS) {
      const log = logOf(seed);
      const evs = log.events;
      for (let i = 0; i < evs.length; i++) {
        if (!(evs[i]!.type === "kickoff" && evs[i]!.detail === "throw_in")) continue;
        total++;
        let prev = "(none)";
        for (let j = i - 1; j >= 0; j--) {
          const t = evs[j]!.type;
          if (t === "kickoff") break;
          prev = evs[j]!.detail ? `${t}:${evs[j]!.detail}` : t;
          break;
        }
        tally.set(prev, (tally.get(prev) ?? 0) + 1);
      }
    }
    const n = SEEDS.length;
    const rows = [...tally.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `    ${k.padEnd(20)} ${(v / n / 2).toFixed(2)}/팀경기 (${((100 * v) / total).toFixed(1)}%)`)
      .join("\n");
    /* eslint-disable no-console */
    console.log(`
=== 스로인 귀속 (${cfg.version}, ${n}시드) — 총 ${(total / n / 2).toFixed(2)}/팀경기 ===
${rows}
`);
    /* eslint-enable no-console */
    expect(total).toBeGreaterThan(0);
  });
});
