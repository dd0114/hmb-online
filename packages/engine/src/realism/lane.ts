import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setDecisionObserver, setLaneReadObserver } from "../action";
import { laneClosest, passOptions } from "../perception";
import { createPitch } from "../pitch";
import type { SimState, SimPlayer } from "../simstate";
import type { EngineConfig } from "../config";

/**
 * 수비 레인 예측(#379 M3-B) 측정 유틸 — **계약과 관전 증거가 같은 함수를 쓴다**
 * (`loft.ts`·`jitter.ts`·`pass-plan.ts`·`through.ts` 선례). 다르게 재면 "증거는 좋은데 계약은
 * 통과"가 성립해 버린다.
 *
 * ## 두 가지를 잰다 (질문이 다르다)
 *  1. **레인 점유**(`measureLaneOccupancy`) — 캐리어의 패스 옵션 중 레인에 수비가 `nearM` 안으로
 *     붙어 있는 비율. W0 §1-2 의 기준선(39.5%)과 **같은 질문**이고, 자[尺]는 엔진의
 *     `perception.ts:laneDangerOn` 을 `passOptions` 를 통해 **그대로** 쓴다(재구현 금지).
 *     ⚠️ 이건 **집계 결과**라 on/off 두 점만 보면 잡음에 인과를 붙이게 된다(트랙 D 가 세 번 걸린
 *     자리) → 계약·증거 모두 **용량–반응 사다리**로 본다(`lane-read.test.ts` 의 사다리 스위트).
 *  2. **READ vs UNREAD**(`measureLaneSplit`) — *출하 config 한 경기 안에서* 레인을 읽은 수비수와
 *     안 읽은 수비수가 그 다음 이동에서 레인에 얼마나 다가갔나. 이쪽이 "광고한 동작이 출하값에서
 *     나는가"를 직접 답한다(반사실 팔 없음 — M3-A 독립검증 m1 의 교훈).
 *
 * ## 왜 로그가 아니라 엔진 관측자인가
 * **어느 레인을 읽었는지는 로그에 없다.** 레인 끝점은 그 수비수의 인지 기억(`player.seen`)의
 * 함수라 관측 시점에만 존재하고, 읽기 판정(`varietyNoise`)도 스냅샷·이벤트 어디에도 안 나온다.
 * 되추론하면 "엔진이 실제로 무엇을 봤나"가 아니라 "내가 다시 계산한 것"을 재게 된다.
 * 그래서 `setLaneReadObserver` 로 엔진이 쓴 값을 그대로 받고, 진단이 더하는 것은
 * **다음 틱 실제 위치**(스냅샷)뿐이다.
 */

/** 레인 점유 판정 거리(m) — W0 §1-2 의 "패스 레인에 상대 3m 안"과 같은 값. */
export const LANE_NEAR_M = 3;

export interface LaneOccupancy {
  /** 심사한 패스 옵션 수(캐리어 결정 × 동료). */
  options: number;
  /** 그중 레인에 수비가 `LANE_NEAR_M` 안으로 붙어 있던 비율(%). */
  occupiedPct: number;
  /** 레인까지 최근접 수비 거리의 평균(m) — 점유율이 이산이라 연속 보조 지표를 같이 본다. */
  laneDangerAvgM: number;
  /**
   * **위협 레인만**(= 그 패스가 수비 골 쪽으로 `threatM` 이상 전진시키는 옵션) 추린 같은 지표.
   *
   * 왜 나눠 보나: `readLane` 이 읽는 대상은 **위협 레인뿐**이다(`minThreatM`). 전 레인 평균에는
   * 백패스·횡패스 레인이 절반 넘게 섞여 있어, 기제가 손대지 않는 표본으로 기제를 재게 된다.
   * (⚠️ 그렇다고 이 쪽이 자동으로 신호를 준다는 뜻은 아니다 — 실측은 M3-B 증거 문서 참조.)
   */
  forwardOptions: number;
  forwardOccupiedPct: number;
  forwardLaneDangerAvgM: number;
  /** 관측된 결정 수. */
  decisions: number;
}

export interface LaneScene {
  tick: number;
  side: string;
  playerId: string;
  toId: string;
  read: boolean;
  /** 레인 끝점(m) — 캐리어(공) → 인지한 위협 리시버. */
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  /** 읽은 시점 레인까지 거리(m). */
  d0: number;
  /** 그 틱 이동 후 레인까지 거리(m). */
  d1: number;
  /** 좁힌 거리(m) = d0 − d1. 음수 = 멀어졌다. */
  closed: number;
  /** 읽은 시점 그 레인의 **팀 전체** 최근접 수비 거리(m) = `laneDangerOn`. */
  g0: number;
  /** 그 틱 이동 후 같은 자[尺]로 잰 값(m). */
  g1: number;
  /** 레인이 막힌 정도의 변화(m) = g0 − g1. AC 의 "레인 점유"와 같은 단위다. */
  guarded: number;
  /** 목표에 더한 선점량(m). */
  stepM: number;
}

export interface LaneArm {
  n: number;
  /** 읽은 시점 레인까지 평균 거리(m) — **두 팔에서 같아야** 선택 편향이 아니다. */
  d0AvgM: number;
  /** 그 틱에 레인으로 좁힌 평균 거리(m). */
  closedAvgM: number;
  /** 0.25m 넘게 좁힌 장면의 비율(%). */
  closedPosPct: number;
  /** 레인의 **팀 최근접**(laneDangerOn)이 그 틱에 줄어든 평균(m). */
  guardedAvgM: number;
  /** 이동 후 그 레인이 `LANE_NEAR_M` 안으로 막혀 있던 비율(%) — AC 의 점유 정의 그대로. */
  guardedPct: number;
  /** 인지 능력 평균((positioning+mental)/2) — 읽기 확률이 능력 비례라 READ 쪽이 높다. */
  attrAvg: number;
  scenes: LaneScene[];
}

export interface LaneSplit {
  /** 관측된 레인 후보 총수(읽었든 아니든). */
  candidates: number;
  read: LaneArm;
  unread: LaneArm;
}

interface RawSample {
  tick: number;
  side: string;
  playerId: string;
  toId: string;
  attr: number;
  read: boolean;
  fromX: number;
  fromY: number;
  toX: number;
  toY: number;
  d0: number;
  g0: number;
  stepM: number;
}

/** 한 경기를 돌리면서 레인 읽기 판정을 엔진에서 직접 받아 둔다. */
export function runWithLanes(
  config: EngineConfig,
  seed: string,
): { log: MatchLog; samples: RawSample[] } {
  const scale = config.fixedScale;
  const samples: RawSample[] = [];
  setLaneReadObserver((s) => {
    samples.push({
      tick: s.tick,
      side: s.side,
      playerId: s.playerId,
      toId: s.toId,
      attr: s.attr,
      read: s.read,
      fromX: s.fromXFx / scale,
      fromY: s.fromYFx / scale,
      toX: s.toXFx / scale,
      toY: s.toYFx / scale,
      d0: s.laneDistFx / scale,
      g0: s.laneDangerFx / scale,
      stepM: s.stepFx / scale,
    });
  });
  const select = makeSelectData();
  try {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    return { log, samples };
  } finally {
    setLaneReadObserver(null);
  }
}

function arm(scenes: LaneScene[], attrs: number[]): LaneArm {
  const n = Math.max(1, scenes.length);
  const avg = (f: (s: LaneScene) => number): number => scenes.reduce((t, s) => t + f(s), 0) / n;
  return {
    n: scenes.length,
    d0AvgM: avg((s) => s.d0),
    closedAvgM: avg((s) => s.closed),
    closedPosPct: (scenes.filter((s) => s.closed > 0.25).length / n) * 100,
    guardedAvgM: avg((s) => s.guarded),
    guardedPct: (scenes.filter((s) => s.g1 <= LANE_NEAR_M).length / n) * 100,
    attrAvg: attrs.reduce((t, v) => t + v, 0) / Math.max(1, attrs.length),
    scenes: [...scenes].sort((x, y) => y.closed - x.closed),
  };
}

/**
 * **출하 config 한 경기 안에서** 레인을 읽은 수비수 vs 안 읽은 수비수.
 *
 * 두 팔은 **같은 기하 게이트를 통과한 표본**이다(위협·사거리를 다 만족해 후보 레인이 잡힌
 * 수비수만 관측된다). 갈리는 것은 시드 노이즈 판정 하나뿐이라, `d0` 이 두 팔에서 같으면
 * 그 차이는 기제가 만든 것이다(M3-A 가 세운 이중차분 규율).
 */
export function measureLaneSplit(config: EngineConfig, seeds: string[]): LaneSplit {
  const scale = config.fixedScale;
  const scenes: LaneScene[] = [];
  const attrs: { read: number[]; unread: number[] } = { read: [], unread: [] };
  let candidates = 0;
  for (const seed of seeds) {
    const { log, samples } = runWithLanes(config, seed);
    candidates += samples.length;
    const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
    for (const s of samples) {
      // 스냅샷(t) = 그 틱 **이동 후** 상태(`match.ts:simulateRange`). 즉 관측 시점(결정)의 거리는
      // 엔진이 준 d0 이고, 이동 결과는 여기서 같은 자[尺]로 잰다.
      const after = byTick.get(s.tick)?.players.find((q) => q.team === s.side && q.playerId === s.playerId)?.pos;
      if (!after) continue;
      const ax = Math.round(s.fromX * scale);
      const ay = Math.round(s.fromY * scale);
      const bx = Math.round(s.toX * scale);
      const by = Math.round(s.toY * scale);
      const d1 =
        laneClosest(Math.round(after.x * scale), Math.round(after.y * scale), ax, ay, bx, by).dist / scale;
      // 팀 최근접(g1)은 `laneDangerOn` 과 **같은 집합**으로 잰다 — 수비 팀 전원(GK 포함),
      // 같은 `laneClosest` 산술. 여기서 집합이 어긋나면 g0/g1 차가 기제가 아니라 정의 차가 된다.
      let g1 = Infinity;
      for (const q of byTick.get(s.tick)?.players ?? []) {
        if (q.team !== s.side) continue;
        const d = laneClosest(
          Math.round(q.pos.x * scale),
          Math.round(q.pos.y * scale),
          ax, ay, bx, by,
        ).dist / scale;
        if (d < g1) g1 = d;
      }
      scenes.push({ ...s, d1, closed: s.d0 - d1, g1, guarded: s.g0 - g1 });
      (s.read ? attrs.read : attrs.unread).push(s.attr);
    }
  }
  return {
    candidates,
    read: arm(scenes.filter((s) => s.read), attrs.read),
    unread: arm(scenes.filter((s) => !s.read), attrs.unread),
  };
}

/**
 * **레인 점유** — 캐리어의 패스 옵션 중 레인에 수비가 붙어 있는 비율(W0 §1-2 기준선 39.5%).
 *
 * 자[尺]는 엔진 것 그대로다: `passOptions` 가 옵션마다 `laneDanger`(= `laneDangerOn`)를 채워 주므로
 * 진단이 레인 기하를 다시 구현하지 않는다. 관측 지점은 `decide` 직후(`setDecisionObserver`) —
 * "그 순간 캐리어에게 보이던 레인들"이 필요한데 로그에는 그 시점 상태가 없다.
 */
export function measureLaneOccupancy(
  config: EngineConfig,
  seeds: string[],
  nearM: number = LANE_NEAR_M,
  threatM: number = config.vision.laneRead.minThreatM,
): LaneOccupancy {
  const scale = config.fixedScale;
  const pitch = createPitch(config);
  const nearFx = nearM * scale;
  const threatFx = threatM * scale;
  const select = makeSelectData();
  const acc = { n: 0, occ: 0, sum: 0, sumN: 0 };
  const fwd = { n: 0, occ: 0, sum: 0, sumN: 0 };
  let decisions = 0;
  setDecisionObserver((raw, owner) => {
    const st = raw as SimState;
    decisions += 1;
    for (const o of passOptions(st, owner as SimPlayer, config, pitch)) {
      for (const a of o.forwardGain >= threatFx ? [acc, fwd] : [acc]) {
        a.n += 1;
        if (o.laneDanger <= nearFx) a.occ += 1;
        // 상대가 없는 레인은 Infinity 다(그런 레인은 평균에서 뺀다 — 없는 값을 0 으로 세면 방향이 뒤집힌다).
        if (Number.isFinite(o.laneDanger)) {
          a.sum += o.laneDanger / scale;
          a.sumN += 1;
        }
      }
    }
  });
  try {
    for (const seed of seeds) {
      runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    }
  } finally {
    setDecisionObserver(null);
  }
  return {
    options: acc.n,
    occupiedPct: acc.n === 0 ? 0 : (acc.occ / acc.n) * 100,
    laneDangerAvgM: acc.sumN === 0 ? 0 : acc.sum / acc.sumN,
    forwardOptions: fwd.n,
    forwardOccupiedPct: fwd.n === 0 ? 0 : (fwd.occ / fwd.n) * 100,
    forwardLaneDangerAvgM: fwd.sumN === 0 ? 0 : fwd.sum / fwd.sumN,
    decisions,
  };
}
