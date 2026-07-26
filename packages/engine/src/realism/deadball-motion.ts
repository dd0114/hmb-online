import type { MatchLog, TickSnapshot } from "@hmb/shared";

/**
 * realism/deadball-motion — 데드볼 정지 구간의 **움직임 품질** 측정 유틸(#185/#174).
 *
 * 두 가지를 센다.
 *  - jitterPer100 (#185): 정지 중 "양쪽 변위가 임계 이상인 방향 반전"(제자리 왕복) 빈도.
 *    임계 없는 반전율은 미세 표류까지 세어 표본 구성 아티팩트에 걸리므로(#178 교훈)
 *    **관객이 실제로 본 왕복만** 센다.
 *  - loneSprintPer100 (#174): 주변이 사실상 정지(중앙값 변위 ≤ stillM)인데 혼자 sprintM 이상
 *    움직이는 선수-틱 비율. "공보다 선수가 빠른" 인지 갭의 계량형.
 *
 * 순수 분석 유틸(엔진 프로덕션 빌드에 export 되지 않음).
 */

export interface DeadBallMotion {
  /** 정지 중 큰 방향 반전 / 선수-틱 100 */
  jitterPer100: number;
  /** 정지 중 단독 질주 선수-틱 / 100 */
  loneSprintPer100: number;
  /** 정지 중 평균 변위(m/tick) */
  meanStepM: number;
  /**
   * 정지 중 변위 99퍼센타일(m/tick). #174("공보다 선수가 빠름")의 임계 없는 지표 —
   * "가장 빠른 선수가 얼마나 빠른가" 를 직접 잰다. 속도 캡을 임계와 같은 값으로 두면
   * 임계 기반 지표(loneSprint)는 캡을 넘지 않아 무조건 0 이 되므로 함께 본다.
   */
  p99StepM: number;
  /** 정지 중 최대 변위(m/tick). */
  maxStepM: number;
  /** 정지 중 사실상 정지(변위 ≤ stillM)인 선수-틱 비율(%). */
  stillPct: number;
  /**
   * **동상 틱 비율(%)** — 그 틱에 선수의 90% 이상이 멈춰 있는 틱의 비율. #174 가 실제로 본 장면
   * ("21/22 가 ≈0.01") 을 직접 센다. 선수-틱 평균(stillPct)은 한 틱에 몰린 정지를 희석해 못 잡는다.
   */
  frozenTickPct: number;
  /** 표본 선수-틱 수 */
  samples: number;
  /** 정지 창 수 */
  windows: number;
}

export interface MotionOpts {
  /** 왕복으로 셀 최소 변위(m, 양쪽 모두). */
  reversalMinM?: number;
  /** "주변이 멈춘" 판정 중앙값 상한(m/tick). */
  stillM?: number;
  /** "혼자 질주" 판정 하한(m/tick). */
  sprintM?: number;
  /** 정지 창 최대 길이(틱). */
  maxWindow?: number;
}

/**
 * 정지 창 = 재시작 이벤트 ~ 공이 인플레이 되기 직전(소유가 비거나 공이 스팟을 떠남).
 * 스냅샷만으로 관측 가능한 신호만 쓴다(엔진 내부 stoppage 를 노출하지 않는다).
 */
function restartTicks(log: MatchLog): { tick: number }[] {
  const out: { tick: number }[] = [];
  for (const e of log.events) {
    if (e.type === "free_kick" || e.type === "penalty" || e.type === "kickoff") out.push({ tick: e.tick });
  }
  return out;
}

export function measureDeadBallMotion(log: MatchLog, opts: MotionOpts = {}): DeadBallMotion {
  const reversalMinM = opts.reversalMinM ?? 1.0;
  const stillM = opts.stillM ?? 0.05;
  const sprintM = opts.sprintM ?? 2.0;
  const maxWindow = opts.maxWindow ?? 45;

  const byTick = new Map<number, TickSnapshot>(log.tickSnapshots.map((s) => [s.tick, s]));
  let reversals = 0;
  let lone = 0;
  let stepSum = 0;
  let samples = 0;
  const allSteps: number[] = [];
  let windows = 0;
  let frozenTicks = 0;
  let tickCount = 0;

  for (const r of restartTicks(log)) {
    const s0 = byTick.get(r.tick);
    if (!s0) continue;
    const spot = { x: s0.ball.x, y: s0.ball.y };
    windows++;
    // 선수별 직전 변위(부호 있는 x/y)로 방향 반전 검출.
    const prevPos = new Map<string, { x: number; y: number }>();
    const prevDelta = new Map<string, { x: number; y: number }>();
    for (let t = r.tick; t <= r.tick + maxWindow; t++) {
      const s = byTick.get(t);
      if (!s) break;
      if (t > r.tick && (s.ballOwner == null || Math.hypot(s.ball.x - spot.x, s.ball.y - spot.y) > 0.3)) break;
      const steps: number[] = [];
      for (const p of s.players) {
        const before = prevPos.get(p.playerId);
        if (before) {
          const dx = p.pos.x - before.x;
          const dy = p.pos.y - before.y;
          const step = Math.hypot(dx, dy);
          steps.push(step);
          allSteps.push(step);
          stepSum += step;
          samples++;
          const pd = prevDelta.get(p.playerId);
          if (pd) {
            // 양쪽 변위가 임계 이상이면서 방향이 뒤집힌(내적<0) 경우만 = 관객이 본 왕복.
            const prevLen = Math.hypot(pd.x, pd.y);
            if (prevLen >= reversalMinM && step >= reversalMinM && pd.x * dx + pd.y * dy < 0) reversals++;
          }
          prevDelta.set(p.playerId, { x: dx, y: dy });
        }
        prevPos.set(p.playerId, { x: p.pos.x, y: p.pos.y });
      }
      if (steps.length > 2) {
        tickCount++;
        if (steps.filter((v) => v <= stillM).length >= steps.length * 0.9) frozenTicks++;
        const sorted = [...steps].sort((a, b) => a - b);
        const med = sorted[Math.floor(sorted.length / 2)]!;
        if (med <= stillM) for (const st of steps) if (st >= sprintM) lone++;
      }
    }
  }
  const per100 = (n: number): number => (samples > 0 ? Math.round((n / samples) * 100 * 100) / 100 : 0);
  const stillN = allSteps.filter((v) => v <= stillM).length;
  allSteps.sort((a, b) => a - b);
  const q = (f: number): number =>
    allSteps.length > 0 ? Math.round(allSteps[Math.min(allSteps.length - 1, Math.floor(f * allSteps.length))]! * 1000) / 1000 : 0;
  return {
    stillPct: samples > 0 ? Math.round((stillN / samples) * 1000) / 10 : 0,
    frozenTickPct: tickCount > 0 ? Math.round((frozenTicks / tickCount) * 1000) / 10 : 0,
    p99StepM: q(0.99),
    maxStepM: q(1),
    jitterPer100: per100(reversals),
    loneSprintPer100: per100(lone),
    meanStepM: samples > 0 ? Math.round((stepSum / samples) * 1000) / 1000 : 0,
    samples,
    windows,
  };
}
