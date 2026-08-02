import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setPlanReadObserver } from "../action";
import type { EngineConfig } from "../config";

/**
 * 예고 패스(#369) 측정 유틸 — **계약과 관전 증거가 같은 함수를 쓴다**(`loft.ts`·`jitter.ts` 선례).
 * 다르게 재면 "증거는 좋은데 계약은 통과"가 성립해 버린다.
 *
 * ## 왜 로그가 아니라 엔진 관측자를 쓰나
 * `pass` 이벤트는 **도착 틱에 리시버 id 로** 발행된다(`contest.ts:resolveArrival`). 로그만 보고
 * "패서가 언제부터 들고 있었나"를 되추론하면 틀린다 — 실제로 두 번 틀렸고 그 함정은
 * `pass-plan.test.ts` 에 박제돼 있다. 게다가 **누가 읽었는지**는 스냅샷·이벤트 어디에도 없다.
 * 그래서 `setPlanReadObserver`(진단 전용·옵트인, 결정론 영향 0)로 엔진의 읽기 판정을 그대로 받는다.
 * **판정식을 여기서 다시 구현하지 않는 것**이 핵심이다 — 그러면 계약이 구현과 조용히 갈린다.
 *
 * ## 왜 READ vs UNREAD 대조인가 (독립검증 m1 반영)
 * 초판은 `readBase: 1`(전원 읽기) 팔의 평균으로 쟀다. 그건 **경기 전개 자체를 바꾼 반사실 팔**이라
 * "출하값에서 광고한 동작이 나는가"를 묻는 계약의 관찰량으로는 약하다(메모리
 * `metric-artifact-magnitude-floor` 가 경고하는 표본 구성 아티팩트와 같은 부류).
 * 지금은 **출하 config 한 경기 안에서** 읽은 리시버와 안 읽은 리시버를 갈라 대조한다 —
 * config 를 안 건드리므로 반사실이 없고, 신호도 훨씬 크다(출하값에서 5배).
 */
export interface PlanArm {
  /** 표본 수(수명 안에 공이 떠난 예고). */
  n: number;
  /** 게시 → 발사 직전 사이 리시버가 도착 예정 지점으로 좁힌 거리(m). 음수 = 멀어졌다. */
  gainAvgM: number;
  /** 0.5m 넘게 좁힌 장면의 비율(%). */
  gainPosPct: number;
  /** 게시가 발사보다 몇 틱 앞섰나. */
  leadTicks: number;
  /** 눈으로 볼 장면(많이 좁힌 순). */
  scenes: PlanScene[];
}

export interface PlanSplit {
  /** 게시되고 리시버가 실제로 **읽은** 예고. */
  read: PlanArm;
  /** 게시됐지만 리시버가 **안 읽은** 예고(= 자기 역할 자리로 간다 — 대조군). */
  unread: PlanArm;
  /** 관측된 예고 총수(중복 제거: 게시 틱 × 대상). */
  plans: number;
}

export interface PlanScene {
  tick: number;
  side: string;
  forId: string;
  x: number;
  y: number;
  read: boolean;
  leadTicks: number;
  d0: number;
  d1: number;
  gained: number;
}

interface Plan {
  tick: number;
  side: string;
  forId: string;
  x: number;
  y: number;
  read: boolean;
}

/** 한 경기를 돌리면서 예고 게시·읽기 판정을 엔진에서 직접 받아 둔다. */
export function runWithPlans(config: EngineConfig, seed: string): { log: MatchLog; plans: Plan[] } {
  const plans: Plan[] = [];
  const seen = new Set<string>();
  // 판정은 예고 수명 내내 같은 값이다(버킷 = 게시 틱). 그래서 (게시 틱, 대상) 으로 dedupe 하면
  // 같은 예고가 여러 틱 관측돼도 한 건으로 접힌다.
  setPlanReadObserver((s) => {
    const key = `${s.side}:${s.planTick}:${s.forId}`;
    if (seen.has(key)) return;
    seen.add(key);
    plans.push({
      tick: s.planTick,
      side: s.side,
      forId: s.forId,
      x: s.xFx / config.fixedScale,
      y: s.yFx / config.fixedScale,
      read: s.read,
    });
  });
  const select = makeSelectData();
  try {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    return { log, plans };
  } finally {
    setPlanReadObserver(null);
  }
}

function arm(scenes: PlanScene[]): PlanArm {
  const n = Math.max(1, scenes.length);
  const avg = (f: (s: PlanScene) => number) => scenes.reduce((t, s) => t + f(s), 0) / n;
  return {
    n: scenes.length,
    gainAvgM: avg((s) => s.gained),
    gainPosPct: (scenes.filter((s) => s.gained > 0.5).length / n) * 100,
    leadTicks: avg((s) => s.leadTicks),
    scenes: [...scenes].sort((x, y) => y.gained - x.gained),
  };
}

export function measurePlanSplit(config: EngineConfig, seeds: string[]): PlanSplit {
  const scenes: PlanScene[] = [];
  let plans = 0;
  for (const seed of seeds) {
    const { log, plans: ps } = runWithPlans(config, seed);
    plans += ps.length;
    const byTick = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
    for (const p of ps) {
      // 공이 실제로 떠난 틱 = 소유자가 null 이 되는 첫 틱(예고 수명 안에서만 본다).
      let launch = -1;
      for (let t = p.tick + 1; t <= p.tick + config.movement.passPlan.expireTicks; t++) {
        const s = byTick.get(t);
        if (!s) break;
        if (!s.ballOwner) {
          launch = t;
          break;
        }
      }
      // 발사가 바로 다음 틱이면 리시버가 움직일 틱이 **없다** — 기제와 무관한 표본이라 뺀다.
      if (launch < 0 || launch - 1 === p.tick) continue;
      const team = p.side === "home" ? "home" : "away";
      const a = byTick.get(p.tick)?.players.find((q) => q.team === team && q.playerId === p.forId)?.pos;
      const b = byTick.get(launch - 1)?.players.find((q) => q.team === team && q.playerId === p.forId)?.pos;
      if (!a || !b) continue;
      const d0 = Math.hypot(a.x - p.x, a.y - p.y);
      const d1 = Math.hypot(b.x - p.x, b.y - p.y);
      scenes.push({ ...p, leadTicks: launch - p.tick, d0, d1, gained: d0 - d1 });
    }
  }
  return {
    plans,
    read: arm(scenes.filter((s) => s.read)),
    unread: arm(scenes.filter((s) => !s.read)),
  };
}
