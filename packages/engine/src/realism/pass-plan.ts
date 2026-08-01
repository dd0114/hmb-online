import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setDecisionObserver } from "../action";
import type { EngineConfig } from "../config";
import type { SimState } from "../simstate";

/**
 * 예고 패스(#369) 측정 유틸 — **계약과 관전 증거가 같은 함수를 쓴다**(`loft.ts` 선례).
 * 다르게 재면 "증거는 좋은데 계약은 통과"가 성립해 버린다.
 *
 * ## 왜 로그가 아니라 엔진 상태를 읽나
 * `pass` 이벤트는 **도착 틱에 리시버 id 로** 발행된다(`contest.ts:resolveArrival`). 로그만 보고
 * "패서가 언제부터 들고 있었나"를 되추론하면 틀린다 — 실제로 두 번 틀렸고 그 함정은
 * `pass-plan.test.ts` 에 박제돼 있다. 여기서는 `setDecisionObserver` 로 **예고가 게시된 틱과
 * 그 도착 예정 지점**을 엔진에서 직접 받는다.
 *
 * ## 왜 "전원 읽기 팔"이 필요한가
 * 출하값은 `readBase` 0.35 라 게시된 예고의 3분의 1만 읽힌다. 안 읽은 리시버는 자기 역할
 * 자리로 갈 뿐이라 도착 예정 지점에서 **멀어지는 것이 정상**이고, 그게 평균에 섞이면 기제가
 * 작동하는지 자체를 볼 수 없다(초판이 그 −2.09m 였다). 기제는 `readBase: 1` 팔에서 보고,
 * "출하값에서 얼마나 자주 일어나는가"는 별도로 본다.
 */
export interface PlanLead {
  /** 게시된 예고 수(중복 제거: 게시 틱 × 대상). */
  plans: number;
  /** 그중 수명 안에 공이 실제로 떠난 건수. */
  launched: number;
  /** 게시 → 발사 직전 사이 리시버가 도착 예정 지점으로 좁힌 거리(m). 음수 = 멀어졌다. */
  gainAvgM: number;
  /** 0.5m 넘게 좁힌 장면의 비율(%). */
  gainPosPct: number;
  /** 게시가 발사보다 몇 틱 앞섰나. */
  leadTicks: number;
  /** 눈으로 볼 장면(많이 좁힌 순). */
  scenes: PlanScene[];
}

export interface PlanScene {
  tick: number;
  side: string;
  forId: string;
  x: number;
  y: number;
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
}

/** 한 경기를 돌리면서 예고 게시를 엔진 상태에서 받아 둔다. */
export function runWithPlans(config: EngineConfig, seed: string): { log: MatchLog; plans: Plan[] } {
  const plans: Plan[] = [];
  const seen = new Set<string>();
  // ⚠️ 게시는 **act 단계**(`match.ts` 의 dribble/hold)라 같은 틱의 decide 관찰자보다 뒤다.
  // `i.tick === st.tick` 으로 거르면 **한 건도 안 잡힌다**(초판이 그 0건이었다).
  // 다음 틱의 decide 에서 보이는 것을 (게시 틱, 대상) 으로 dedupe 해 모은다.
  setDecisionObserver((raw) => {
    const st = raw as SimState;
    for (const i of st.intents) {
      if (i.kind !== "pass_plan") continue;
      const key = `${i.tick}:${i.forId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      plans.push({
        tick: i.tick,
        side: i.side,
        forId: i.forId ?? "",
        x: i.xFx / config.fixedScale,
        y: i.yFx / config.fixedScale,
      });
    }
  });
  const select = makeSelectData();
  try {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    return { log, plans };
  } finally {
    setDecisionObserver(null);
  }
}

/** `readBase: 1` 팔 — 안 읽은 리시버를 표본에서 빼기 위한 config. */
export function allReadConfig(config: EngineConfig): EngineConfig {
  return {
    ...config,
    movement: {
      ...config.movement,
      passPlan: { ...config.movement.passPlan, readBase: 1, readAttrSwing: 0 },
    },
  };
}

export function measurePlanLead(config: EngineConfig, seeds: string[]): PlanLead {
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
  const n = Math.max(1, scenes.length);
  const avg = (f: (s: PlanScene) => number) => scenes.reduce((t, s) => t + f(s), 0) / n;
  return {
    plans,
    launched: scenes.length,
    gainAvgM: avg((s) => s.gained),
    gainPosPct: (scenes.filter((s) => s.gained > 0.5).length / n) * 100,
    leadTicks: avg((s) => s.leadTicks),
    scenes: [...scenes].sort((x, y) => y.gained - x.gained),
  };
}
