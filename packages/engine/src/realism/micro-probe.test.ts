import { describe, it, expect } from "vitest";
import type { MatchLog } from "@hmb/shared";
import { defaultEngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { REALISM_SEEDS } from "./harness";

/**
 * micro-probe — **공 미시 물리 진단**(env 가드). npm test 에서는 skip.
 * 실행: `HMB_MICRO=1 npx vitest run packages/engine/src/realism/micro-probe.test.ts`
 *
 * hero 실관전 제보(#320): "공이 너무 일정속도로 감속되는 것 같아. 슛이나 공이 뜨면 **직선으로
 * 꽂혀야** 되는데 지금은 **정지될 위치를 먼저 잡고 공이 점점 정지**하는 느낌이야."
 *
 * ## ② 공 속도 프로파일 — 이 진단의 핵심 지표
 * 무소유 공의 연속 이동량(m/tick)을 **비행 세그먼트**로 잘라, 세그먼트마다
 * `마지막스텝 / 첫스텝` 을 잰다.
 *  - **목표점 보간 모델**(구): 목표에 닿는 마지막 틱이 잘린 부분스텝이라 비율이 뚝 떨어지고,
 *    그 뒤 settle 이 속도를 25% 로 **되올려** 궤적이 `12 → 0.9 → 3.0` 처럼 **비단조로 요동**한다.
 *  - **속도 벡터 모델**(신): 매 틱 `pos += v; v *= friction` 이라 스텝이 **단조 감소**하고
 *    비율이 1.0 에 가깝다(등속 비행 후 자연 감속).
 *
 * 진단만 한다 — 계약(임계값)은 `ball-physics.test.ts` · `ball-continuity.test.ts` 가 진다.
 */

const GEN = (process as unknown as { env?: Record<string, string | undefined> }).env?.HMB_MICRO;

const cfg = defaultEngineConfig;
const select = makeSelectData();
const SEEDS = REALISM_SEEDS.slice(0, 8);

function logOf(seed: string): MatchLog {
  return runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, cfg);
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  return Math.hypot(ax - bx, ay - by);
}

/** 데드볼 재배치 틱(공이 스팟으로 순간 배치되는 구간) — 물리 프로파일 대상이 아니다. */
function cutTicks(log: MatchLog): Set<number> {
  const cut = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff", "goal", "shot"].includes(kind)) {
      for (let t = e.tick - 1; t <= e.tick + 1; t++) cut.add(t);
    }
  }
  return cut;
}

interface Segment {
  seed: string;
  startTick: number;
  steps: number[];
}

/**
 * 무소유 공의 연속 이동 구간을 세그먼트로 자른다.
 * 시작 = 직전 틱보다 크게 움직이기 시작한 무소유 틱(첫 스텝 >= MIN_LAUNCH).
 * 끝 = 소유가 생기거나 / 컷 틱이거나 / 이동량이 STOP 미만.
 */
const MIN_LAUNCH = 3; // m — "찼다"고 볼 최소 첫 스텝.
const STOP = 0.2; // m — 이 아래는 정지.

function segments(seed: string, log: MatchLog): Segment[] {
  const S = log.tickSnapshots;
  const cut = cutTicks(log);
  const out: Segment[] = [];
  let cur: number[] | null = null;
  let curStart = 0;
  for (let i = 1; i < S.length; i++) {
    const a = S[i - 1]!, b = S[i]!;
    const owned = a.ballOwner != null || b.ballOwner != null;
    const isCut = cut.has(a.tick) || cut.has(b.tick);
    const d = dist(a.ball.x, a.ball.y, b.ball.x, b.ball.y);
    if (owned || isCut) {
      if (cur && cur.length >= 2) out.push({ seed, startTick: curStart, steps: cur });
      cur = null;
      continue;
    }
    if (cur == null) {
      if (d >= MIN_LAUNCH) {
        cur = [d];
        curStart = a.tick;
      }
      continue;
    }
    if (d < STOP) {
      if (cur.length >= 2) out.push({ seed, startTick: curStart, steps: cur });
      cur = null;
      continue;
    }
    cur.push(d);
  }
  if (cur && cur.length >= 2) out.push({ seed, startTick: curStart, steps: cur });
  return out;
}

/** 스텝열이 비단조(중간에 다시 빨라짐)인가 — 되올림 폭이 REBOUND 이상이면 요동. */
const REBOUND = 0.5; // m/tick

function hasRebound(steps: number[]): boolean {
  for (let i = 1; i < steps.length; i++) {
    if (steps[i]! - steps[i - 1]! > REBOUND) return true;
  }
  return false;
}

function pct(v: number[], q: number): number {
  if (v.length === 0) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))]!;
}

describe("micro-probe — 공 미시 물리", () => {
  it.skipIf(!GEN)("② 공 속도 프로파일 (마지막스텝/첫스텝 · 비단조 요동 · 정지 빈도)", () => {
    const all: Segment[] = [];
    let stopsTotal = 0;
    let stopTicksTotal = 0;
    for (const seed of SEEDS) {
      const log = logOf(seed);
      const segs = segments(seed, log);
      all.push(...segs);
      // "공이 선다" = 무소유 상태로 이동량 STOP 미만이 연속되는 구간.
      const S = log.tickSnapshots;
      const cut = cutTicks(log);
      let run = 0;
      for (let i = 1; i < S.length; i++) {
        const a = S[i - 1]!, b = S[i]!;
        if (a.ballOwner != null || b.ballOwner != null || cut.has(b.tick)) {
          if (run > 0) { stopsTotal++; stopTicksTotal += run; run = 0; }
          continue;
        }
        if (dist(a.ball.x, a.ball.y, b.ball.x, b.ball.y) < STOP) run++;
        else if (run > 0) { stopsTotal++; stopTicksTotal += run; run = 0; }
      }
      if (run > 0) { stopsTotal++; stopTicksTotal += run; }
    }

    const ratios = all.map((s) => s.steps[s.steps.length - 1]! / s.steps[0]!);
    const mean = ratios.reduce((t, v) => t + v, 0) / Math.max(1, ratios.length);
    const rebounds = all.filter((s) => hasRebound(s.steps)).length;
    const n = SEEDS.length;

    const sample = all
      .filter((s) => s.steps.length >= 3)
      .slice(0, 6)
      .map((s) => `    seed ${s.seed} t${s.startTick}: ${s.steps.map((v) => v.toFixed(1)).join(" → ")}`)
      .join("\n");

    /* eslint-disable no-console */
    console.log(`
=== micro-probe ② 공 속도 프로파일 (${cfg.version}, ${n}시드) ===
  비행 세그먼트           ${all.length}개 (${(all.length / n).toFixed(1)}/경기)
  마지막스텝/첫스텝 평균  ${mean.toFixed(3)}   (p10 ${pct(ratios, 0.1).toFixed(3)} · p50 ${pct(ratios, 0.5).toFixed(3)} · p90 ${pct(ratios, 0.9).toFixed(3)})
  비단조 요동 세그먼트    ${rebounds}개 = ${((100 * rebounds) / Math.max(1, all.length)).toFixed(1)}%
  공이 서는 횟수          ${(stopsTotal / n).toFixed(1)}회/경기 (평균 ${(stopTicksTotal / Math.max(1, stopsTotal)).toFixed(1)}틱)
  궤적 예시:
${sample}
`);
    /* eslint-enable no-console */
    expect(all.length).toBeGreaterThan(0);
  });
});
