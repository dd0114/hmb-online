import type { MatchLog, TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * realism/synchrony — "팀이 다 같이 같은 방향으로 움직인다"(동기 이동)를 수치화하는 측정 유틸. (#147)
 *
 * 관전자가 느끼는 부자연스러움 = 개별 선수가 독립적으로 판단하는 게 아니라 팀 전체가 한 덩어리로
 * 평행이동하는 것. 이를 두 축으로 잰다.
 *
 *  1) **정렬도 R** — 한 틱, 한 팀의 움직이는 필드 플레이어들의 *단위* 변위벡터 평균 크기
 *     (원형통계의 mean resultant length). 0 = 방향이 제각각, 1 = 전원이 정확히 같은 방향.
 *  2) **병진 비중** — 팀 평균변위(강체 병진) 크기 vs 병진을 뺀 잔차 크기의 비.
 *     100% 에 가까울수록 팀이 형태를 유지한 채 통째로 미끄러진다(= 개별 움직임 없음).
 *
 * 추가로 **소유권 전환 후 경과틱별 R**을 낸다. 전환 시 전원이 같은 틱에 공격↔수비 목표식으로
 * 갈아타면 전환 직후 여러 틱 동안 R 이 고평탄(plateau)하게 유지되는데, 이게 hero 가 지적한
 * "갑자기 다 같이 동일 방향으로 동일 틱씩" 의 실체다.
 *
 * 이 파일은 순수 분석 유틸(엔진 프로덕션 빌드 index.ts 에 export 되지 않음).
 */

/** 세트피스 재배치(포메이션 리셋·스팟 배치)는 1틱 텔레포트라 이동으로 치지 않는다. 이 거리(m) 초과 변위는 제외. */
const TELEPORT_M = 12;
/** 정지로 보는 변위(m) — 이보다 작으면 방향이 무의미해 R 표본에서 뺀다. */
const STILL_M = 0.05;
/** R 을 낼 최소 이동 인원(팀당). 이보다 적으면 표본에서 제외. */
const MIN_MOVERS = 5;
/** 데드볼 전후 제외 창(틱): 이벤트 tick-2 .. tick+14 는 "인플레이"에서 뺀다(세트피스 재배치 구간). */
const DEAD_BEFORE = 2;
const DEAD_AFTER = 14;
/** 소유권 전환 후 추적할 최대 경과틱. */
const FLIP_LAGS = 21;

/** 재배치를 유발하는 데드볼 이벤트 타입. */
const DEAD_EVENTS = new Set([
  "corner", "throw_in", "goal_kick", "kickoff", "goal", "foul", "offside", "penalty", "free_kick",
]);

export interface SynchronyReport {
  /** 사용한 시드 수. */
  seeds: number;
  /** 인플레이 팀-틱 표본 수. */
  samples: number;
  /** 이동방향 정렬도 R 평균(0=독립, 1=완전동기). */
  meanR: number;
  /** R>0.9(사실상 전원 같은 방향)인 팀-틱 비율(%). */
  highRPct: number;
  /** 팀 평균변위(강체 병진) 크기(m/tick). */
  translationM: number;
  /** 병진을 뺀 잔차 변위 크기(m/tick) — 개별 움직임의 양. */
  residualM: number;
  /** 병진 비중(%) = 병진/(병진+잔차). 클수록 팀이 한 덩어리. */
  rigidPct: number;
  /** 소유권 전환 후 경과틱 0..20 별 평균 R. 전환 직후 동기 행진 구간이 드러난다. */
  postFlipR: number[];
  /** postFlipR 최댓값 = 전환 후 동기 행진의 피크. */
  postFlipPeak: number;
}

interface Acc {
  r: number;
  n: number;
  hi: number;
  trans: number;
  resid: number;
}

interface Pt {
  x: number;
  y: number;
}

/** 데드볼 재배치 구간 틱 집합. */
function deadTicks(log: MatchLog): Set<number> {
  const s = new Set<number>();
  for (const e of log.events) {
    if (!DEAD_EVENTS.has(e.type)) continue;
    for (let d = -DEAD_BEFORE; d <= DEAD_AFTER; d++) s.add(e.tick + d);
  }
  return s;
}

/** 한 매치로그의 인플레이 팀-틱 동기 지표를 누적기에 더한다. */
function accumulate(log: MatchLog, acc: Acc, flip: { s: number; n: number }[]): void {
  const dead = deadTicks(log);
  const sn = log.tickSnapshots;
  let lastFlipTick = -9999;
  let prevOwnerSide: TeamSide | null = null;

  for (let t = 1; t < sn.length; t++) {
    const cur = sn[t]!;
    const prev = sn[t - 1]!;
    const prevPos = new Map<string, Pt>(prev.players.map((p) => [p.playerId, p.pos]));
    const ownerSide: TeamSide | null = cur.ballOwner ? (cur.ballOwner.startsWith("H") ? "home" : "away") : null;
    if (ownerSide && prevOwnerSide && ownerSide !== prevOwnerSide) lastFlipTick = cur.tick;
    if (ownerSide) prevOwnerSide = ownerSide;
    if (dead.has(cur.tick)) continue;

    for (const side of ["home", "away"] as const) {
      const gk = side === "home" ? "H0" : "A0";
      const disp: Pt[] = [];
      for (const p of cur.players) {
        if (p.team !== side || p.playerId === gk || p.playerId === cur.ballOwner) continue;
        const b = prevPos.get(p.playerId);
        if (!b) continue;
        const dx = p.pos.x - b.x;
        const dy = p.pos.y - b.y;
        if (Math.hypot(dx, dy) > TELEPORT_M) continue;
        disp.push({ x: dx, y: dy });
      }
      const movers = disp.filter((d) => Math.hypot(d.x, d.y) >= STILL_M);
      if (movers.length < MIN_MOVERS) continue;

      // 1) 정렬도 R = |Σ 단위변위| / n.
      let ux = 0;
      let uy = 0;
      for (const d of movers) {
        const m = Math.hypot(d.x, d.y);
        ux += d.x / m;
        uy += d.y / m;
      }
      const R = Math.hypot(ux, uy) / movers.length;

      // 2) 강체 병진 vs 잔차.
      const cx = disp.reduce((s, d) => s + d.x, 0) / disp.length;
      const cy = disp.reduce((s, d) => s + d.y, 0) / disp.length;
      const trans = Math.hypot(cx, cy);
      const resid = disp.reduce((s, d) => s + Math.hypot(d.x - cx, d.y - cy), 0) / disp.length;

      acc.r += R;
      acc.n += 1;
      acc.trans += trans;
      acc.resid += resid;
      if (R > 0.9) acc.hi += 1;

      const lag = cur.tick - lastFlipTick;
      if (lag >= 0 && lag < FLIP_LAGS) {
        flip[lag]!.s += R;
        flip[lag]!.n += 1;
      }
    }
  }
}

const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** 다수 시드로 동기 이동 지표를 집계한다. */
export function measureSynchrony(config: EngineConfig, seeds: string[]): SynchronyReport {
  const select = makeSelectData();
  const acc: Acc = { r: 0, n: 0, hi: 0, trans: 0, resid: 0 };
  const flip = Array.from({ length: FLIP_LAGS }, () => ({ s: 0, n: 0 }));

  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    accumulate(log, acc, flip);
  }

  const postFlipR = flip.map((f) => (f.n > 0 ? round(f.s / f.n, 2) : 0));
  return {
    seeds: seeds.length,
    samples: acc.n,
    meanR: round(acc.r / acc.n),
    highRPct: round((acc.hi / acc.n) * 100, 1),
    translationM: round(acc.trans / acc.n, 2),
    residualM: round(acc.resid / acc.n, 2),
    rigidPct: round((acc.trans / (acc.trans + acc.resid)) * 100, 1),
    postFlipR,
    postFlipPeak: Math.max(...postFlipR),
  };
}
