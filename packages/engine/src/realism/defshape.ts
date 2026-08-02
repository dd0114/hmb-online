import type { MatchLog, TacticalInput, TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import type { DefShapeSample } from "../action";
import { setDefShapeObserver } from "../action";
import { runMatch } from "../match";
import { makeSelectData, makeTacticalInput } from "../fixtures";

/**
 * **수비 형태 계측**(#377 S3-B) — 공유 수비 라인 · 오픈플레이 레스트디펜스.
 *
 * 계약(`def-line.test.ts` · `rest-defence.test.ts`)과 관전 증거(`evidence/377/gen-s3b.ts`)가
 * **이 함수들을 공유한다**. 두 곳이 각자 재면 "계약과 다른 자로 재고 그 값을 근거로 적는"
 * 트랙 D 함정 #2 가 그대로 재현된다.
 *
 * ## 역할 라벨은 엔진이 준다
 * 좌표로 "이 선수가 라인 멤버인가"를 되추론하지 않는다 — #378 이 벽/백업을 그렇게 되추론했다가
 * 가짜 위반 566건을 만들었고, 여기서는 위험이 더 크다("라인 멤버"와 "그냥 뒤에 서 있는 선수"는
 * 좌표만으로 구분되지 않는다). 그래서 배정한 쪽이 `DefShapeSample` 로 라벨을 단다.
 *
 * ## ⚠️ 백4 산포는 **게이트가 아니다**(보고 전용)
 * 스코프 단계 검정에서 네 겹으로 기각됐다: ①위험거리 버킷별로 상태가 섞인다(25–40m 6.37m vs
 * >60m 13.93m) ②분포가 쌍봉(p50 6.65 · p90 22.72) ③**물리 상한이 7.2m** 다(모든 당김을 제거하고
 * 투영을 100%로 올려도) ④기존 축(`defendCompactX`)이 **비단조**다. 도달 불가능한 임계는
 * 게이트가 아니라 오판 생성기라 여기서는 **재기만 하고 걸지 않는다**.
 */

const ROLE_BY_INDEX = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
const BACK_FOUR = new Set(["LB", "LCB", "RCB", "RB"]);
const CENTRE_BACKS = new Set(["LCB", "RCB"]);
/** 재시작 이벤트 — 이 창의 틱은 규칙기반 배치가 소유하므로 형태 계측에서 뺀다. */
const RESTART_TYPES = new Set([
  "free_kick",
  "penalty",
  "goal",
  "offside",
  "foul",
  "half_whistle",
  "kickoff",
]);
/** 재시작 이벤트 앞뒤로 제외할 틱 수(정지 8~12틱 + 걸어 들어가는 꼬리). */
const DEAD_BEFORE = 2;
const DEAD_AFTER = 12;

function roleOf(playerId: string): string {
  return ROLE_BY_INDEX[Number(playerId.slice(1))] ?? "?";
}
function sideOfId(playerId: string): TeamSide {
  return playerId.startsWith("H") ? "home" : "away";
}
function mean(v: readonly number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}
function quantile(v: readonly number[], q: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))]!;
}

/** 한 경기를 돌리며 수비 형태 배정을 엔진에서 직접 받아 둔다. */
export function runWithDefShape(
  config: EngineConfig,
  seed: string,
  patch?: (t: TacticalInput) => TacticalInput,
): { log: MatchLog; samples: DefShapeSample[] } {
  const samples: DefShapeSample[] = [];
  setDefShapeObserver((s) => {
    samples.push(s);
  });
  try {
    const select = makeSelectData();
    const h = patch ? patch(makeTacticalInput("H", seed)) : makeTacticalInput("H", seed);
    const a = patch ? patch(makeTacticalInput("A", seed)) : makeTacticalInput("A", seed);
    const log = runMatch(seed, h, a, select, config);
    return { log, samples };
  } finally {
    setDefShapeObserver(null);
  }
}

export interface DefLineReport {
  /** 관측된 수비 팀-틱 수(라인이 안 잡힌 틱도 포함 — 안 그러면 발화율이 위로 편향된다). */
  lineTicks: number;
  /** 그중 보정이 실제로 걸린 틱 비율(%). */
  appliedPct: number;
  /** 라인 멤버 수 평균 · 압박 유닛이 데려가 빠진 인원 평균. */
  membersMean: number;
  excludedByUnitMean: number;
  /**
   * **L2 의 직접 관찰량** — 멤버의 기준선 이탈(m)이 보정으로 얼마나 줄었나.
   * `before` 는 `decideOffBall` 이 만든 목표, `after` 는 보정 후.
   */
  devBeforeP90M: number;
  devAfterP90M: number;
  devBeforeMeanM: number;
  devAfterMeanM: number;
  /** 멤버 목표 진행도 산포(m) — 보정 전/후. */
  spreadBeforeMeanM: number;
  spreadAfterMeanM: number;
  /** 라인 높이 가감량의 절대 평균(m) = `defensiveLineHeight` 슬라이더의 실권한. */
  heightBiasMeanM: number;
  /** 기준선 진행도 평균(m, 자기 골 0). */
  refProgMeanM: number;
  /**
   * **위치** 기준 라인 멤버 산포(m) — 목표가 아니라 **선수가 실제로 어디 서 있나**.
   * 목표 산포만 보면 이 계약은 동어반복이다(위 `posProgFx` 주석).
   */
  memberPosSpreadMeanM: number;
  memberPosSpreadP90M: number;
  /** 멤버의 목표↔위치 간격(m) 평균 — 라인이 "못 따라가는" 정도의 직접 관찰량. */
  targetPosGapMeanM: number;
  /** 라인 멤버 표본 수. */
  memberSamples: number;
}

/** 다시드 라인 계측. `patch` 로 팀 지시(예: `defensiveLineHeight`)를 바꿔 사다리를 만든다. */
export function measureDefLine(
  config: EngineConfig,
  seeds: readonly string[],
  patch?: (t: TacticalInput) => TacticalInput,
): DefLineReport {
  const scale = config.fixedScale;
  let lineTicks = 0;
  let applied = 0;
  let membersSum = 0;
  let excludedSum = 0;
  let heightSum = 0;
  let refSum = 0;
  let refN = 0;
  const devBefore: number[] = [];
  const devAfter: number[] = [];
  const spreadBefore: number[] = [];
  const spreadAfter: number[] = [];
  // lineMember 는 그 틱의 기준선을 모르므로, 직전 line 샘플의 ref 를 쓴다 — 관측자는 멤버를
  // 먼저 흘리고 요약을 나중에 흘리므로 **틱·팀별로 모아** 짝짓는다.
  const pending = new Map<string, { before: number; after: number; pos: number }[]>();
  const posSpread: number[] = [];
  const gap: number[] = [];
  let memberSamples = 0;

  for (const seed of seeds) {
    for (const s of runWithDefShape(config, seed, patch).samples) {
      if (s.kind === "lineMember") {
        const key = `${s.tick}:${s.side}`;
        const arr = pending.get(key) ?? [];
        arr.push({ before: s.beforeProgFx, after: s.afterProgFx, pos: s.posProgFx });
        pending.set(key, arr);
      } else if (s.kind === "line") {
        lineTicks += 1;
        membersSum += s.members;
        excludedSum += s.excludedByUnit;
        if (!s.applied) continue;
        applied += 1;
        heightSum += Math.abs(s.heightBiasFx) / scale;
        refSum += s.refProgFx / scale;
        refN += 1;
        spreadBefore.push(s.beforeSpreadFx / scale);
        spreadAfter.push(s.afterSpreadFx / scale);
        const key = `${s.tick}:${s.side}`;
        const arr = pending.get(key) ?? [];
        let pMin = Number.MAX_SAFE_INTEGER;
        let pMax = -Number.MAX_SAFE_INTEGER;
        for (const m of arr) {
          devBefore.push(Math.abs(m.before - s.refProgFx) / scale);
          devAfter.push(Math.abs(m.after - s.refProgFx) / scale);
          gap.push(Math.abs(m.after - m.pos) / scale);
          memberSamples += 1;
          if (m.pos < pMin) pMin = m.pos;
          if (m.pos > pMax) pMax = m.pos;
        }
        if (arr.length >= 2) posSpread.push((pMax - pMin) / scale);
        pending.delete(key);
      }
    }
    pending.clear();
  }

  return {
    lineTicks,
    appliedPct: lineTicks ? (applied / lineTicks) * 100 : 0,
    membersMean: lineTicks ? membersSum / lineTicks : 0,
    excludedByUnitMean: lineTicks ? excludedSum / lineTicks : 0,
    devBeforeP90M: quantile(devBefore, 0.9),
    devAfterP90M: quantile(devAfter, 0.9),
    devBeforeMeanM: mean(devBefore),
    devAfterMeanM: mean(devAfter),
    spreadBeforeMeanM: mean(spreadBefore),
    spreadAfterMeanM: mean(spreadAfter),
    heightBiasMeanM: applied ? heightSum / applied : 0,
    refProgMeanM: refN ? refSum / refN : 0,
    memberPosSpreadMeanM: mean(posSpread),
    memberPosSpreadP90M: quantile(posSpread, 0.9),
    targetPosGapMeanM: mean(gap),
    memberSamples,
  };
}

export interface RestDefenceReport {
  /** 관측된 공격 팀-틱 수. */
  restTicks: number;
  /** 요청 인원 평균 · 실제 배정 평균 · 상한에 걸린 인원 평균. */
  wantMean: number;
  assignedMean: number;
  cappedMean: number;
  /** 상한이 실제로 문 틱의 비율(%). */
  cappedTickPct: number;
  /** 상한에 걸린 선수가 원래 가려던 진행도 초과분(m) 평균. */
  capOvershootMeanM: number;
}

/** 다시드 레스트디펜스 배정 계측(엔진 라벨 기준). */
export function measureRestDefence(
  config: EngineConfig,
  seeds: readonly string[],
  patch?: (t: TacticalInput) => TacticalInput,
): RestDefenceReport {
  const scale = config.fixedScale;
  let restTicks = 0;
  let wantSum = 0;
  let assignedSum = 0;
  let cappedSum = 0;
  let cappedTicks = 0;
  const overshoot: number[] = [];
  for (const seed of seeds) {
    for (const s of runWithDefShape(config, seed, patch).samples) {
      if (s.kind === "rest") {
        restTicks += 1;
        wantSum += s.want;
        assignedSum += s.assigned;
        cappedSum += s.capped;
        if (s.capped > 0) cappedTicks += 1;
      } else if (s.kind === "restMember" && s.capped) {
        overshoot.push((s.beforeProgFx - s.afterProgFx) / scale);
      }
    }
  }
  return {
    restTicks,
    wantMean: restTicks ? wantSum / restTicks : 0,
    assignedMean: restTicks ? assignedSum / restTicks : 0,
    cappedMean: restTicks ? cappedSum / restTicks : 0,
    cappedTickPct: restTicks ? (cappedTicks / restTicks) * 100 : 0,
    capOvershootMeanM: mean(overshoot),
  };
}

export interface ShapeOutcome {
  /** 공격 중 센터백이 하프라인을 넘은 틱 비율(%) — **R2 의 자**(검정 통과: 4 rung 엄격 단조). */
  cbOverHalfPct: number;
  /** 경기당 CB 최고 진행도(m) 평균 — **R3 의 자**. */
  cbProgMaxM: number;
  /** 공격 중 CB 평균 진행도(m). */
  cbProgMeanM: number;
  /** 수비 중 백4 x-산포(m) — **보고 전용**(위 주석 참조). */
  backSpreadMeanM: number;
  backSpreadP50M: number;
  backSpreadP90M: number;
  /** 수비 중 백4 산포를 위험거리(공↔우리 골)별로. 상태 혼합의 직접 증거. */
  backSpreadByDangerM: number[];
  /** 2nd-last 수비수 진행도(m) 평균 · 경기내 SD 평균 — **L3 후보 ①**. */
  offsideLineMeanM: number;
  offsideLineSdM: number;
  /** 라인(백4 평균)의 틱간 이동(m/tick) — **L3 후보 ②**. */
  lineStepMeanM: number;
  /** 허용 슛의 골까지 거리(m) 중앙값 — **L3 후보 ③**(라인이 서면 슛이 멀어져야 한다). */
  concededShotDistP50M: number;
  /** 공격 중 상대 진영(진행도 > 0.5)에 있는 아웃필더 수 — **R4**(공격을 죽였나). */
  attackersUpfieldMean: number;
  /**
   * 수비 중 **공이 우리 백4 최전방보다 뒤(우리 골 쪽)에 있는** 틱 비율(%).
   * = "라인이 뚫렸다". 라인이 존재하는 이유 그 자체이고, 이 기제가 **쓰지 않는 양**이다
   * (기제는 수비수 목표만 쓴다 — 공 위치도 상대 위치도 안 본다).
   */
  behindLinePossPct: number;
  /** 경기당 오프사이드 · 골 · 슛(팀당) — 볼륨 보고용. */
  offsidesPerMatch: number;
  goalsPerMatch: number;
  shotsPerTeam: number;
}

/** 위험거리 버킷 경계(m) — `press.ts:DANGER_BUCKETS_M` 과 같은 절단이다. */
export const DANGER_BUCKETS_M: readonly number[] = [25, 40, 60];

/**
 * 스냅샷에서 형태·결과 지표를 잰다. **엔진 라벨이 필요 없는 지표만** 여기 있다(좌표로 되추론하는
 * 것이 아니라, 애초에 역할 고정 슬롯 id 로 정의되는 양들이다 — `deepen.ts` 와 같은 관용구).
 */
export function measureShapeOutcome(config: EngineConfig, seeds: readonly string[], patch?: (t: TacticalInput) => TacticalInput): ShapeOutcome {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const nb = DANGER_BUCKETS_M.length + 1;
  const spreadByDanger: number[][] = Array.from({ length: nb }, () => []);
  const backSpread: number[] = [];
  const lineStep: number[] = [];
  const shotProg: number[] = [];
  let cbOverN = 0;
  let cbOverHit = 0;
  let cbProgSum = 0;
  let cbProgN = 0;
  let cbMaxSum = 0;
  let upSum = 0;
  let upN = 0;
  let behindN = 0;
  let behindHit = 0;
  let offsides = 0;
  let goals = 0;
  let shots = 0;
  let lineSdSum = 0;
  let lineSdN = 0;
  let lineMeanSum = 0;
  let lineMeanN = 0;

  const select = makeSelectData();
  for (const seed of seeds) {
    const h = patch ? patch(makeTacticalInput("H", seed)) : makeTacticalInput("H", seed);
    const a = patch ? patch(makeTacticalInput("A", seed)) : makeTacticalInput("A", seed);
    const log = runMatch(seed, h, a, select, config);
    offsides += log.events.filter((e) => e.type === "offside").length;
    goals += log.events.filter((e) => e.type === "goal").length;
    shots += log.events.filter((e) => e.type === "shot").length;

    const dead = new Set<number>();
    for (const e of log.events) {
      if (!RESTART_TYPES.has(e.type)) continue;
      for (let t = e.tick - DEAD_BEFORE; t <= e.tick + DEAD_AFTER; t++) dead.add(t);
    }
    // ⚠️ 슛 **직전 틱**의 공 위치를 쓴다. 슛 이벤트가 난 틱의 공은 이미 골문 쪽으로 옮겨져 있어
    // (초판이 이 함정에 걸려 어떤 사다리에서도 102.50m 상수가 나왔다 = 신호 0 이 아니라 **자가 고장**)
    // 그 틱을 쓰면 "슛을 어디서 쐈나"가 아니라 "골문이 어디인가"를 재게 된다.
    const shotTicks = new Map<number, TeamSide>();
    for (const e of log.events) if (e.type === "shot" && e.team) shotTicks.set(e.tick - 1, e.team as TeamSide);

    const prog = (side: TeamSide, x: number): number => (side === "home" ? x : W - x);
    const lineSeries: Record<TeamSide, number[]> = { home: [], away: [] };
    const prevLine: Record<string, { v: number; t: number }> = {};
    let cbMax = 0;

    for (const sn of log.tickSnapshots) {
      const o = sn.ballOwner;
      if (!o || dead.has(sn.tick)) continue;
      const owner = sideOfId(o);
      const shooter = shotTicks.get(sn.tick);
      // 슛 지점 → 상대 골까지 거리(m). 라인이 서면 슛이 **멀어져야** 한다.
      if (shooter) {
        const gx = shooter === "home" ? W : 0;
        shotProg.push(Math.hypot(sn.ball.x - gx, sn.ball.y - H / 2));
      }
      for (const side of ["home", "away"] as TeamSide[]) {
        const back: number[] = [];
        const cbs: number[] = [];
        let upfield = 0;
        for (const p of sn.players) {
          if (p.team !== side) continue;
          const r = roleOf(p.playerId);
          if (r === "GK") continue;
          const pr = prog(side, p.pos.x);
          if (BACK_FOUR.has(r)) back.push(pr);
          if (CENTRE_BACKS.has(r)) cbs.push(pr);
          if (pr > W / 2) upfield++;
        }
        if (back.length < 4) continue;
        if (owner === side) {
          // 공격 중.
          for (const c of cbs) {
            cbProgSum += c;
            cbProgN += 1;
            cbOverN += 1;
            if (c > W / 2) cbOverHit += 1;
            if (c > cbMax) cbMax = c;
          }
          upSum += upfield;
          upN += 1;
          continue;
        }
        // 수비 중.
        const sorted = [...back].sort((x, y) => x - y);
        const spread = sorted[3]! - sorted[0]!;
        // 라인이 뚫렸나 — 공이 백4 최전방보다 우리 골 쪽에 있나.
        behindN += 1;
        if (prog(side, sn.ball.x) > sorted[3]!) behindHit += 1;
        backSpread.push(spread);
        const gx = side === "home" ? 0 : W;
        const d = Math.hypot(sn.ball.x - gx, sn.ball.y - H / 2);
        let b = DANGER_BUCKETS_M.length;
        for (let i = 0; i < DANGER_BUCKETS_M.length; i++) {
          if (d < DANGER_BUCKETS_M[i]!) {
            b = i;
            break;
          }
        }
        spreadByDanger[b]!.push(spread);
        const mu = mean(back);
        const key = side;
        const pv = prevLine[key];
        // ⚠️ 인접 틱끼리만 뺀다(deepen.ts 와 같은 함정 — 건너뛴 구간을 1틱 이동으로 세면
        // 라인 이동량이 통째로 부풀려진다).
        if (pv && pv.t === sn.tick - 1) lineStep.push(Math.abs(mu - pv.v));
        prevLine[key] = { v: mu, t: sn.tick };
        // 2nd-last 수비수(GK 포함) = `contest.ts:offsideLineProg` 와 같은 정의.
        const all = sn.players.filter((p) => p.team === side).map((p) => prog(side, p.pos.x)).sort((x, y) => x - y);
        if (all.length >= 2) lineSeries[side].push(all[1]!);
      }
    }
    cbMaxSum += cbMax;
    for (const side of ["home", "away"] as TeamSide[]) {
      const v = lineSeries[side];
      if (v.length < 2) continue;
      const mu = mean(v);
      lineSdSum += Math.sqrt(mean(v.map((x) => (x - mu) ** 2)));
      lineSdN += 1;
      lineMeanSum += mu;
      lineMeanN += 1;
    }
  }

  const n = seeds.length;
  return {
    cbOverHalfPct: cbOverN ? (cbOverHit / cbOverN) * 100 : 0,
    cbProgMaxM: n ? cbMaxSum / n : 0,
    cbProgMeanM: cbProgN ? cbProgSum / cbProgN : 0,
    backSpreadMeanM: mean(backSpread),
    backSpreadP50M: quantile(backSpread, 0.5),
    backSpreadP90M: quantile(backSpread, 0.9),
    backSpreadByDangerM: spreadByDanger.map((v) => mean(v)),
    offsideLineMeanM: lineMeanN ? lineMeanSum / lineMeanN : 0,
    offsideLineSdM: lineSdN ? lineSdSum / lineSdN : 0,
    lineStepMeanM: mean(lineStep),
    concededShotDistP50M: quantile(shotProg, 0.5),
    attackersUpfieldMean: upN ? upSum / upN : 0,
    behindLinePossPct: behindN ? (behindHit / behindN) * 100 : 0,
    offsidesPerMatch: n ? offsides / n : 0,
    goalsPerMatch: n ? goals / n : 0,
    shotsPerTeam: n ? shots / n / 2 : 0,
  };
}

/** `defensiveLineHeight` 슬라이더를 바꾸는 팀 지시 패치(L4 사다리용). */
export function withLineHeight(v: number): (t: TacticalInput) => TacticalInput {
  return (t) => ({ ...t, team: { ...t.team, defensiveLineHeight: v } });
}
