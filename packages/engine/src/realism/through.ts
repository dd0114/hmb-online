import type { MatchLog } from "@hmb/shared";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { newChainProbe, setChainProbe, setPassAimObserver, type ChainProbe } from "../action";
import { newThroughProbe, setThroughProbe, type ThroughProbe } from "../through";
import type { EngineConfig } from "../config";

/**
 * 스루패스(#377 M3-C) 측정 유틸 — **계약과 관전 증거가 같은 함수를 쓴다**
 * (`loft.ts`·`jitter.ts`·`pass-plan.ts` 선례). 다르게 재면 "증거는 좋은데 계약은 통과"가 성립한다.
 *
 * ## 왜 로그가 아니라 엔진 관측자인가
 * **로그에는 조준점이 없다.** `pass` 이벤트는 도착 틱에 리시버 id 로 발행되고(`resolveArrival`),
 * 스냅샷에는 공 좌표만 있다. 거기서 되추론하면 "어디로 찼나"가 아니라 "어떻게 끝났나"(오차·굴러간
 * 거리 포함)를 재게 된다 — 다른 질문이다. 그래서 `setPassAimObserver` 로 **결정 직후 계획 조준점**을
 * 받는다. 조준점 자체도 진단이 다시 계산하지 않고 엔진의 `receiverArrival` 이 낸 값을 그대로 받는다.
 *
 * ## 왜 through 팔 vs 발밑 팔인가 (M3-A 독립검증 m1 의 교훈)
 * `enabled:false` 로 재면 **경기 전개 자체가 다른 반사실 팔**이라 "출하값에서 광고한 동작이 나는가"에
 * 답하지 못한다. 여기서는 **출하 config 한 경기 안에서** 생성기 라벨(`gen`)로 표본을 가른다.
 * (on/off 대조는 별도로 본다 — 그건 "경기가 달라진다"라는 다른 질문이고 변이체 킬이 맡는다.)
 */

/** 픽스처 로스터의 골키퍼 id(`fixtures.ts` — `harness.ts` 와 같은 관용구). */
const GK_IDS = new Set(["H0", "A0"]);

export interface AimArm {
  n: number;
  /** 리드 거리(m) = 발사 틱 리시버 위치 → 계획 조준점. */
  leadP50: number;
  leadP90: number;
  leadAvgM: number;
  /**
   * 리드가 10~25m 구간(= 스루패스 대역)인 패스 비율(%).
   * ⚠️ 비교 전에 소수 1자리로 반올림한다 — 조준점이 고정소수 정수 정규화의 산물이라 상한
   * 25m 후보가 25.0014m 로 나온다. 반올림 없이 `<= 25` 로 걸면 **상한에 걸린 후보가 전부
   * 밴드 밖으로 새어 나간다**(초판 실측: through 팔 100% → 58%).
   */
  band10to25Pct: number;
  /** 조준점이 상대 오프사이드 라인 뒤인 패스 비율(%). */
  behindLinePct: number;
}

export interface AimScene {
  tick: number;
  side: string;
  gen: string;
  passerId: string;
  receiverId: string;
  leadM: number;
  distM: number;
  x: number;
  y: number;
  behindLine: boolean;
  raceFrac: number | null;
}

export interface ThroughSplit {
  /** 관측된 패스 실행 수(사슬 코어 기준). */
  passes: number;
  all: AimArm;
  /** 공간 타깃(스루패스) 팔. */
  through: AimArm;
  /** 발밑 패스 팔(대조군 — 같은 경기, 같은 config). */
  footed: AimArm;
  /** 사슬 계측: 결정 수 · through 생성/채택. */
  decisions: number;
  generatedThrough: number;
  pickedThrough: number;
  /** 상대 최종수비 뒤에 서 있는 **소유팀 공격수** 평균 명수(스냅샷 기반). */
  behindLineAttackers: number;
  /** 생성 게이트 계측 — "왜 안 뽑혔나"를 추측이 아니라 수치로 답한다. */
  gates: ThroughProbe;
  /** 눈으로 볼 장면(리드가 긴 순, through 만). */
  scenes: AimScene[];
}

function pct(a: number[], q: number): number {
  if (a.length === 0) return 0;
  const s = [...a].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.floor(q * (s.length - 1)))]!;
}

function arm(scenes: AimScene[]): AimArm {
  const n = Math.max(1, scenes.length);
  const leads = scenes.map((s) => s.leadM);
  return {
    n: scenes.length,
    leadP50: pct(leads, 0.5),
    leadP90: pct(leads, 0.9),
    leadAvgM: leads.reduce((t, v) => t + v, 0) / n,
    band10to25Pct:
      (scenes.filter((s) => {
        const l = Math.round(s.leadM * 10) / 10;
        return l >= 10 && l <= 25;
      }).length /
        n) *
      100,
    behindLinePct: (scenes.filter((s) => s.behindLine).length / n) * 100,
  };
}

/**
 * **상대 최종수비 뒤 공격수** 평균 명수 — W0 §1-2 의 기준선 지표(그 시점 실측 1.02명).
 *
 * 정의: 공 소유자가 있는 틱마다, 소유팀의 **아웃필더** 중 상대 진영 기준 진행도가 상대의
 * **뒤에서 2번째** 선수(= `checkOffside` 의 오프사이드 라인)보다 앞선 인원. 그 평균.
 * ⚠️ 라인 정의를 엔진(`through.ts:offsideLineProg` / `contest.ts:checkOffside`)과 **같이** 잡는다 —
 * 여기만 "마지막 수비수"로 잡으면 GK 때문에 언제나 0 에 가깝게 나온다.
 */
export function behindLineAttackers(log: MatchLog, pitchWidthM: number): number {
  let sum = 0;
  let ticks = 0;
  for (const s of log.tickSnapshots) {
    if (!s.ballOwner) continue;
    // 픽스처 id 규약(H*/A*)으로 소유팀을 읽는다 — 스냅샷에 소유팀 필드가 없다.
    const side = s.ballOwner.startsWith("H") ? "home" : "away";
    const prog = (x: number): number => (side === "home" ? x / pitchWidthM : 1 - x / pitchWidthM);
    const opp: number[] = [];
    for (const p of s.players) if (p.team !== side) opp.push(prog(p.pos.x));
    if (opp.length < 2) continue;
    opp.sort((a, b) => b - a);
    const line = opp[1]!;
    let n = 0;
    for (const p of s.players) {
      if (p.team !== side || GK_IDS.has(p.playerId)) continue;
      if (prog(p.pos.x) > line) n++;
    }
    sum += n;
    ticks += 1;
  }
  return ticks === 0 ? 0 : sum / ticks;
}

/** 한 경기를 돌리며 패스 조준점·사슬 계측을 엔진에서 직접 받아 둔다. */
export function runWithAims(
  config: EngineConfig,
  seed: string,
): { log: MatchLog; scenes: AimScene[]; probe: ChainProbe; gates: ThroughProbe } {
  const scenes: AimScene[] = [];
  const probe = newChainProbe();
  const gates = newThroughProbe();
  setChainProbe(probe);
  setThroughProbe(gates);
  setPassAimObserver((s) => {
    scenes.push({
      tick: s.tick,
      side: s.side,
      gen: s.gen,
      passerId: s.passerId,
      receiverId: s.receiverId,
      leadM: s.leadFx / config.fixedScale,
      distM: s.distFx / config.fixedScale,
      x: s.aimXFx / config.fixedScale,
      y: s.aimYFx / config.fixedScale,
      behindLine: s.behindLine,
      raceFrac: s.raceFrac,
    });
  });
  const select = makeSelectData();
  try {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    return { log, scenes, probe, gates };
  } finally {
    setPassAimObserver(null);
    setChainProbe(null);
    setThroughProbe(null);
  }
}

export function measureThrough(config: EngineConfig, seeds: string[]): ThroughSplit {
  const all: AimScene[] = [];
  let decisions = 0;
  let generatedThrough = 0;
  let pickedThrough = 0;
  let behindSum = 0;
  const gates = newThroughProbe();
  for (const seed of seeds) {
    const { log, scenes, probe, gates: g } = runWithAims(config, seed);
    for (const k of Object.keys(gates) as (keyof ThroughProbe)[]) gates[k] += g[k];
    all.push(...scenes);
    decisions += probe.decisions;
    generatedThrough += probe.generated.through;
    pickedThrough += probe.picked.through;
    behindSum += behindLineAttackers(log, config.pitch.width);
  }
  const through = all.filter((s) => s.gen === "through");
  return {
    passes: all.length,
    all: arm(all),
    through: arm(through),
    footed: arm(all.filter((s) => s.gen !== "through")),
    decisions,
    generatedThrough,
    pickedThrough,
    gates,
    behindLineAttackers: behindSum / Math.max(1, seeds.length),
    scenes: [...through].sort((a, b) => b.leadM - a.leadM),
  };
}
