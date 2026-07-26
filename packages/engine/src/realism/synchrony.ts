import type { MatchLog, TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";

/**
 * realism/synchrony — "팀이 다 같이 같은 방향으로 움직인다"(동기 이동)를 수치화하는 측정 유틸. (#147)
 *
 * ## 지표 설계 — 크기 인지(magnitude-aware)가 핵심
 *
 * 초판(W1)은 **단위 변위벡터**의 평균 크기만 봤다. 그 지표는 5cm 움직인 선수와 5m 질주한 선수를
 * 동일 가중해서, "완전정지였던 선수가 초당 5~25cm 표류하기 시작"하는 것만으로도 값이 크게
 * 떨어진다 — 관객 눈에는 아무것도 안 바뀌었는데(105m 피치에서 0.25m = 렌더 2px 미만) 지표만
 * 좋아지는 **표본 구성 아티팩트**. 실제로 W2(로밍 연속화)가 그 함정에 걸렸다(단위 R 0.823→0.729
 * 였지만 변위가중 R 은 0.825→0.823 으로 무변, 검증 세션이 반증).
 *
 * 그래서 주 지표는 **임계값이 없는** 것만 쓴다.
 *
 *  1) **weightedR = |Σd| / Σ|d|** (주 지표) — 팀 총 이동량 중 공통 방향으로 간 비율.
 *     0 = 서로 상쇄(제각각), 1 = 전원이 정확히 한 방향. 임계·표본구성에 영향받지 않는다.
 *     hero 가 지적한 "다 같이 동일 방향으로 행진"에 직접 대응한다.
 *  2) **rigidPct** — 팀 평균변위(강체 병진) vs 병진을 뺀 잔차의 비. 임계 없이 전원 포함.
 *     100%에 가까울수록 형태를 유지한 채 통째로 미끄러진다.
 *  3) **bigMoveR** — |d| ≥ BIG_MOVE_M 인 선수들만의 정렬도. 관객 눈에 실제로 보이는 큰 움직임
 *     (질주·복귀)만 골라 본다. 미세 표류가 섞여 희석되지 않는다.
 *  4) **lockstepPct** — 정렬도가 0.99 이상(= 전원이 *정확히* 같은 방향)인 팀-틱 비율.
 *     전 선수를 같은 틱에 동시 전환시키는 이산 아티팩트의 지문. 3)·4) 는 단위벡터를 쓰므로
 *     반드시 `ALIGN_FLOOR_M` 하한과 `MIN_PLAYERS` 를 함께 건다(안 걸면 1)과 같은 함정).
 *
 * 추가로 **소유권 전환 후 경과틱별 weightedR** 을 낸다. 전환 시 전원이 같은 틱에 공격↔수비
 * 목표식으로 갈아타면 전환 직후 여러 틱 동안 값이 고평탄(plateau)하게 유지된다.
 *
 * 이 파일은 순수 분석 유틸(엔진 프로덕션 빌드 index.ts 에 export 되지 않음).
 */

/** 세트피스 재배치(포메이션 리셋·스팟 배치)는 1틱 텔레포트라 이동으로 치지 않는다. 이 거리(m) 초과 변위는 제외. */
const TELEPORT_M = 12;
/** "관객 눈에 보이는 큰 움직임" 기준(m/tick). 이 이상만 bigMoveR 표본. */
const BIG_MOVE_M = 2;
/**
 * 정렬도 표본의 **크기 하한**(m/tick). 이보다 작은 변위는 방향 표본에서 뺀다.
 * 105m 피치에서 0.25m 는 렌더 2px 미만 — 관객에게 보이지 않는 표류가 단위벡터로 full-weight
 * 잡히면 "완전정지 → 미세표류" 같은 변화만으로 지표가 통째로 움직인다(표본구성 아티팩트).
 * 초판은 하한이 사실상 `>0` 이라 이 함정에 두 번 걸렸다(검증 세션 B1·B5).
 */
const ALIGN_FLOOR_M = 0.25;
/** 완전 동조(lockstep) 판정 정렬도 임계. */
const LOCKSTEP_R = 0.99;
/** 지표를 낼 최소 인원(팀당). */
const MIN_PLAYERS = 5;
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
  /** **주 지표** 변위가중 정렬도 = |Σd|/Σ|d| (0=제각각, 1=전원 동일 방향). 임계·표본구성 무관. */
  weightedR: number;
  /** 병진 비중(%) = 병진/(병진+잔차). 클수록 팀이 한 덩어리. 임계 없음. */
  rigidPct: number;
  /** 큰 움직임(|d| ≥ 2m/tick)만의 정렬도 — 관객 눈에 보이는 행진. */
  bigMoveR: number;
  /** 완전 동조(크기 하한 위 정렬도 ≥ 0.99)인 팀-틱 비율(%) — 이산 동시전환 아티팩트의 지문. */
  lockstepPct: number;
  /** 소유권 전환 후 경과틱 0..20 별 weightedR. 전환 직후 동기 행진 구간이 드러난다. */
  postFlipR: number[];
  /** postFlipR 최댓값 = 전환 후 동기 행진의 피크. */
  postFlipPeak: number;
}

interface Acc {
  wNum: number;
  wDen: number;
  trans: number;
  resid: number;
  bigNum: number;
  bigDen: number;
  lock: number;
  n: number;
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

/**
 * 단위 변위벡터 정렬도(mean resultant length). **크기 하한 + 최소 인원**을 건다.
 * 최소 인원이 없으면 움직인 선수가 1명일 때 R=1.0 이 되는 퇴화 표본이 lockstep 으로 잡힌다
 * (레거시 lockstep 표본의 20%가 그 케이스였다 — 검증 세션 B5).
 */
function unitAlignment(disp: Pt[], floorM: number): number | null {
  const mv = disp.filter((d) => Math.hypot(d.x, d.y) >= floorM);
  if (mv.length < MIN_PLAYERS) return null;
  let ux = 0;
  let uy = 0;
  for (const d of mv) {
    const m = Math.hypot(d.x, d.y);
    ux += d.x / m;
    uy += d.y / m;
  }
  return Math.hypot(ux, uy) / mv.length;
}

/** 한 매치로그의 인플레이 팀-틱 동기 지표를 누적기에 더한다. */
function accumulate(log: MatchLog, acc: Acc, flip: { num: number; den: number }[]): void {
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
      if (disp.length < MIN_PLAYERS) continue;

      // 1) 변위가중 정렬도(주 지표) — 임계 없음, 큰 움직임이 큰 가중.
      const sx = disp.reduce((s, d) => s + d.x, 0);
      const sy = disp.reduce((s, d) => s + d.y, 0);
      const total = disp.reduce((s, d) => s + Math.hypot(d.x, d.y), 0);
      if (total === 0) continue;
      acc.wNum += Math.hypot(sx, sy);
      acc.wDen += total;

      // 2) 강체 병진 vs 잔차 — 임계 없음.
      const cx = sx / disp.length;
      const cy = sy / disp.length;
      acc.trans += Math.hypot(cx, cy);
      acc.resid += disp.reduce((s, d) => s + Math.hypot(d.x - cx, d.y - cy), 0) / disp.length;

      // 3) 큰 움직임만의 정렬도.
      const big = unitAlignment(disp, BIG_MOVE_M);
      if (big != null) {
        acc.bigNum += big;
        acc.bigDen += 1;
      }

      // 4) 완전 동조(이산 동시전환 아티팩트). 크기 하한 위에서만 판정.
      const all = unitAlignment(disp, ALIGN_FLOOR_M);
      if (all != null && all >= LOCKSTEP_R) acc.lock += 1;
      acc.n += 1;

      const lag = cur.tick - lastFlipTick;
      if (lag >= 0 && lag < FLIP_LAGS) {
        flip[lag]!.num += Math.hypot(sx, sy);
        flip[lag]!.den += total;
      }
    }
  }
}

const round = (v: number, d = 3): number => Math.round(v * 10 ** d) / 10 ** d;

/** 다수 시드로 동기 이동 지표를 집계한다. */
export function measureSynchrony(config: EngineConfig, seeds: string[]): SynchronyReport {
  const select = makeSelectData();
  const acc: Acc = { wNum: 0, wDen: 0, trans: 0, resid: 0, bigNum: 0, bigDen: 0, lock: 0, n: 0 };
  const flip = Array.from({ length: FLIP_LAGS }, () => ({ num: 0, den: 0 }));

  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    accumulate(log, acc, flip);
  }

  const postFlipR = flip.map((f) => (f.den > 0 ? round(f.num / f.den, 2) : 0));
  return {
    seeds: seeds.length,
    samples: acc.n,
    weightedR: round(acc.wNum / acc.wDen),
    rigidPct: round((acc.trans / (acc.trans + acc.resid)) * 100, 1),
    bigMoveR: round(acc.bigNum / acc.bigDen),
    lockstepPct: round((acc.lock / acc.n) * 100, 2),
    postFlipR,
    postFlipPeak: Math.max(...postFlipR),
  };
}
