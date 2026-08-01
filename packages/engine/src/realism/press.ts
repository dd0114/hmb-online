import type { MatchLog, TacticalInput } from "@hmb/shared";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setPressUnitObserver, type PressUnitSample } from "../action";
import type { EngineConfig } from "../config";

/**
 * 압박 유닛(#377 S3-A · #350 · #362 · #303) 측정 유틸 — **계약과 관전 증거가 같은 함수를 쓴다**
 * (`loft.ts`·`jitter.ts`·`pass-plan.ts`·`through.ts`·`lane.ts` 선례). 다르게 재면 "증거는 좋은데
 * 계약은 통과"가 성립해 버린다.
 *
 * ## 왜 로그가 아니라 엔진 관측자인가
 * **누가 유닛에 배정됐는지는 스냅샷·이벤트 어디에도 없다.** 좌표에서 역할을 되추론하면 #378 이
 * 벽/백업에서 겪은 사고를 되풀이한다 — 그때 백업 2/3 이 벽으로 오분류돼 "9.15m 침범 566건"이라는
 * **가짜 위반**이 나왔다(벽 9.15m 와 백업 8m 의 1m 차이가 계측을 속였다). 그래서 배정한 쪽이
 * 라벨을 달고(`action.ts:PressUnitObserver`), 진단은 그 라벨을 그대로 받는다.
 *
 * ## ⚠️ 인원 평균은 **0 인 틱을 포함해야 한다**
 * 멤버 샘플만 모아 평균 내면 "배정이 있었던 틱"만 세게 되어 값이 구조적으로 위로 편향된다
 * (트리거 게이트가 막은 틱·루즈볼 틱이 통째로 빠진다). 그래서 관측자가 `kind:"unit"` 요약을
 * **매 틱** 흘리고, 여기서는 그쪽을 분모로 쓴다.
 */

/** 위험거리 버킷 경계(m) — 자기 골에서의 거리. 첫 칸이 hero 제보의 "골문 앞"이다. */
export const DANGER_BUCKETS_M: readonly number[] = [25, 40, 60];

export interface PressUnitReport {
  /** 관측된 팀-틱 수(= `kind:"unit"` 샘플 수). 0 인 틱도 포함한다. */
  unitTicks: number;
  /** 배정 총원 평균(압박 담당 + 커버, **0 인 틱 포함**). */
  countMean: number;
  /** 커버 수 평균(레인을 실제로 끊는 인원, 같은 분모). */
  coverMean: number;
  /** 지원 수 평균 — 총원 − 1 − 커버(막을 레인이 없어 압박 담당을 받치러 간 인원). */
  supportMean: number;
  /**
   * 위험거리 버킷별 배정 총원 평균. 인덱스 = `DANGER_BUCKETS_M` 구간
   * (`[0,25) [25,40) [40,60) [60,∞)`). **A1 의 자[尺]** — 위험도 매핑이 발화하는가.
   */
  countByDanger: number[];
  /** 각 버킷의 표본 수(팀-틱). 빈 버킷을 0 으로 통과시키지 않으려면 이걸 같이 본다. */
  ticksByDanger: number[];
  /**
   * **압박 담당의 목표 오염**(#303 마지막 항) — 최종 목표에서 공까지 거리(m)의 p50/p90/평균.
   * 오염이 없으면 0 이어야 한다(목표가 정확히 공이다).
   */
  presserBallDistP50M: number;
  presserBallDistP90M: number;
  presserBallDistMeanM: number;
  /** 압박 담당 멤버 샘플 수(= 실제로 공으로 달린 틱). */
  presserSamples: number;
  /** 커버 배정 시점 커버→레인 지점 거리(m) 평균. */
  coverLaneDistMeanM: number;
  /** 커버 멤버 샘플 수. */
  coverSamples: number;
  /** 지원 멤버 샘플 수. */
  supportSamples: number;
  /** legacy 경로(= `press.unit.enabled=false`)로 돌았나. */
  legacy: boolean;
}

function pct(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * sorted.length)));
  return sorted[i]!;
}

/** 한 경기를 돌리며 유닛 배정을 엔진에서 직접 받아 둔다. */
export function runWithPressUnit(
  config: EngineConfig,
  seed: string,
  patch?: (t: TacticalInput) => TacticalInput,
): { log: MatchLog; samples: PressUnitSample[] } {
  const samples: PressUnitSample[] = [];
  setPressUnitObserver((s) => {
    samples.push(s);
  });
  try {
    const select = makeSelectData();
    const h = patch ? patch(makeTacticalInput("H", seed)) : makeTacticalInput("H", seed);
    const a = patch ? patch(makeTacticalInput("A", seed)) : makeTacticalInput("A", seed);
    const log = runMatch(seed, h, a, select, config);
    return { log, samples };
  } finally {
    setPressUnitObserver(null);
  }
}

/** 다시드 집계. `patch` 로 팀 지시(예: `pressingScheme.intensity`)를 바꿔 사다리를 만든다. */
export function measurePressUnit(
  config: EngineConfig,
  seeds: string[],
  patch?: (t: TacticalInput) => TacticalInput,
): PressUnitReport {
  const scale = config.fixedScale;
  const nb = DANGER_BUCKETS_M.length + 1;
  const cSum = new Array<number>(nb).fill(0);
  const cN = new Array<number>(nb).fill(0);
  let unitTicks = 0;
  let countSum = 0;
  let coverSum = 0;
  let legacy = false;
  const presserDist: number[] = [];
  let coverLaneSum = 0;
  let coverN = 0;
  let supportN = 0;
  let memberTotal = 0;

  for (const seed of seeds) {
    for (const s of runWithPressUnit(config, seed, patch).samples) {
      if (s.kind === "unit") {
        unitTicks += 1;
        countSum += s.count;
        coverSum += s.coverCount;
        if (s.legacy) legacy = true;
        const dm = s.dangerFx / scale;
        let b = DANGER_BUCKETS_M.length;
        for (let i = 0; i < DANGER_BUCKETS_M.length; i++) {
          if (dm < DANGER_BUCKETS_M[i]!) {
            b = i;
            break;
          }
        }
        cSum[b]! += s.count;
        cN[b]! += 1;
      } else if (s.role === "presser") {
        presserDist.push(s.ballDistFx / scale);
      } else if (s.role === "cover") {
        coverLaneSum += s.laneDistFx / scale;
        coverN += 1;
        memberTotal += 1;
      } else {
        supportN += 1;
        memberTotal += 1;
      }
    }
  }
  presserDist.sort((a, b) => a - b);
  const mean = presserDist.length ? presserDist.reduce((a, b) => a + b, 0) / presserDist.length : 0;
  return {
    unitTicks,
    countMean: unitTicks ? countSum / unitTicks : 0,
    coverMean: unitTicks ? coverSum / unitTicks : 0,
    supportMean: unitTicks ? (memberTotal - coverN) / unitTicks : 0,
    countByDanger: cSum.map((v, i) => (cN[i]! ? v / cN[i]! : 0)),
    ticksByDanger: cN,
    presserBallDistP50M: pct(presserDist, 0.5),
    presserBallDistP90M: pct(presserDist, 0.9),
    presserBallDistMeanM: mean,
    presserSamples: presserDist.length,
    coverLaneDistMeanM: coverN ? coverLaneSum / coverN : 0,
    coverSamples: coverN,
    supportSamples: supportN,
    legacy,
  };
}

/**
 * **볼 10m 안 수비수를 위험거리 버킷별로** 잰다 — `deepen.def.pressWithin10` 과 **같은 정의**
 * (수비팀 아웃필더 중 공에서 10m 안, 소유자가 있는 틱)를 버킷으로 쪼갠 것뿐이다.
 *
 * ## ⚠️ 왜 전역 평균을 쓰면 안 되나 (이 웨이브의 핵심 발견)
 * 로드맵·#350 의 목표 "볼 10m 내 수비 ≥ 2.0" 은 **전역 평균**인데, 그 평균은 성질이 다른 두
 * 상태를 섞는다. 8시드 실측(구동작):
 *
 *   공이 우리 골 **<25m** → **2.225**  ·  25–40m → 1.977  ·  40–60m → 0.645  ·  **>60m → 0.557**
 *
 * 공이 상대 진영에 있을 때(>60m, 표본의 **35%**) 수비팀이 공에서 10m 안에 0.56명인 것은 결함이
 * 아니라 **정의상 당연**하다 — 그때 수비 블록은 공 뒤에 있다. 즉 전역 평균 2.0 은 "상대 진영에서도
 * 공을 둘러싸라"는 뜻이 되고, 그건 #350 이 요구한 것이 아니다(hero 의 문장은 *"골문 앞에서"* 다).
 *
 * 그래서 **hero 가 말한 구역으로 조건부**로 잰다. 같은 부류의 발견이 이 웨이브에 하나 더 있다 —
 * `behindLineAttackers` 도 "침투"와 "수비 붕괴"를 구분 못 했다(S3-A.md).
 */
export function pressWithin10ByDanger(config: EngineConfig, seeds: string[]): { mean: number[]; ticks: number[] } {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const wide = config.press.unit.wideWeight;
  const nb = DANGER_BUCKETS_M.length + 1;
  const sum = new Array<number>(nb).fill(0);
  const n = new Array<number>(nb).fill(0);
  const select = makeSelectData();
  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    for (const sn of log.tickSnapshots) {
      const o = sn.ballOwner;
      if (!o) continue;
      const attSide = o.startsWith("H") ? "home" : "away";
      const defSide = attSide === "home" ? "away" : "home";
      // home 은 +x 로 공격 → home 이 지키는 골은 x=0, away 가 지키는 골은 x=W.
      const gx = defSide === "home" ? 0 : W;
      const gy = H / 2;
      const danger = Math.hypot(sn.ball.x - gx, sn.ball.y - gy) + wide * Math.abs(sn.ball.y - gy);
      let b = DANGER_BUCKETS_M.length;
      for (let i = 0; i < DANGER_BUCKETS_M.length; i++) {
        if (danger < DANGER_BUCKETS_M[i]!) {
          b = i;
          break;
        }
      }
      let c10 = 0;
      for (const p of sn.players) {
        if (p.team !== defSide) continue;
        if (p.playerId === "H0" || p.playerId === "A0") continue; // GK 제외(deepen 과 같은 규약)
        if (Math.hypot(p.pos.x - sn.ball.x, p.pos.y - sn.ball.y) <= 10) c10++;
      }
      sum[b]! += c10;
      n[b]! += 1;
    }
  }
  return { mean: sum.map((v, i) => (n[i]! ? v / n[i]! : 0)), ticks: n };
}

/** `pressingScheme.intensity` 만 바꾸는 패치(사다리용). 다른 지시는 손대지 않는다. */
export function withIntensity(v: number): (t: TacticalInput) => TacticalInput {
  return (t) => ({ ...t, team: { ...t.team, pressingScheme: { ...t.team.pressingScheme, intensity: v } } });
}
