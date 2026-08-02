import type { MatchLog, TacticalInput, TeamSide } from "@hmb/shared";
import type { EngineConfig } from "../config";
import type { DefShapeSample } from "../action";
import { setDefShapeObserver } from "../action";
import { runMatch } from "../match";
import { makeSelectData, makeTacticalInput } from "../fixtures";

/**
 * **오프사이드 트랩 계측**(#377 S3-C 스코프 단계) — "트랩이 작동한다"를 잴 **자[尺] 후보들**.
 *
 * ## 왜 별도 파일인가
 * 이 웨이브의 첫 과제는 기제가 아니라 **자 검정**이다. `offsides` 이벤트는 0.65/경기(20시드
 * 총 13건)라 포아송 노이즈만 ±28% 이고, 표본을 바꾸면 ±50% 흔들린다 — **2배 미만 효과를
 * 검출할 수 없다**. 그래서 게이트로 쓸 수 있는 **밀도 높은 관찰량**을 먼저 찾는다.
 *
 * 여기 있는 자들은 **기제가 아직 없어도 잴 수 있다**(스냅샷·이벤트만 읽는다). 그래서 기존
 * 레버(`defensiveLineHeight` · `heightRangeX` · `lineDiscipline` · `trapBiasM`)로 **용량–반응**을
 * 먼저 검정하고, 신호가 없는 자는 계약에 넣지 않는다(S3-A·S3-B 선례).
 *
 * ⚠️ 역할 라벨은 고정 슬롯 id 로만 쓴다(`defshape.ts` 와 같은 관용구) — 좌표로 되추론하지 않는다.
 */

const ROLE_BY_INDEX = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
const BACK_FOUR = new Set(["LB", "LCB", "RCB", "RB"]);
/** 재시작 창 — 규칙기반 배치가 소유하므로 형태 계측에서 뺀다(`defshape.ts` 와 동일). */
const RESTART_TYPES = new Set([
  "free_kick", "penalty", "goal", "offside", "foul", "half_whistle", "kickoff",
]);
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
function sd(v: readonly number[]): number {
  if (v.length < 2) return 0;
  const mu = mean(v);
  return Math.sqrt(v.reduce((s, x) => s + (x - mu) ** 2, 0) / (v.length - 1));
}

/** 한 수비팀(= `side` 가 수비하는 상황)에 대한 자들. */
export interface TrapSideMeasure {
  /** 표본 = 상대가 공을 가진 인플레이 틱 수. */
  defTicks: number;
  /**
   * **후보 ① 오프사이드 포지션 점유** — 그 틱에 우리 라인 뒤(상대 골 쪽)에 남겨진 상대
   * 아웃필더 수의 평균. 라인을 밀어올리면 오르고, 뚫리면 내린다.
   */
  caughtMean: number;
  /** 라인 뒤에 상대가 1명 이상 있는 틱 비율(%). */
  caughtPct: number;
  /** 라인 뒤 상대의 라인 초과 거리 평균(m) — 얼마나 깊이 잡혔나. */
  caughtDepthM: number;
  /**
   * **후보 ② 라인 전진 버스트** — 백4 평균 진행도가 인접 틱에 `BURST_M` 이상 전진한 비율(%).
   * "트랩이 걸리는 순간"의 직접 신호.
   */
  burstPct: number;
  /** **후보 ③ 전진 동기화** — 백4 4명이 **동시에** 전진한 인접 틱 비율(%). */
  syncFwdPct: number;
  /** 백4 평균 진행도의 틱간 전진량 평균(m/tick, 음수 포함). */
  stepMeanM: number;
  /** 우리 오프사이드 라인(2nd-last) 진행도 평균(m). */
  lineMeanM: number;
  /**
   * **후보 ④ 뒷공간 실점 위험** — 상대 소유자가 **우리 라인 뒤에서** 공을 가진 틱 비율(%).
   * 트랩의 실패 모드. 기제(수비수 목표 이동)가 직접 쓰지 않는 양이다.
   */
  behindLineOwnPct: number;
  /** 그 상태에서 우리 골까지 거리 중앙값(m). */
  behindLineGoalDistM: number;
  /**
   * **트랩 기회 사이징** — 라인 **바로 앞**(온사이드, `SHOULDER_BANDS_M` 안)에 상대가 있는
   * 틱 비율(%). 라인을 그만큼 밀어올리면 잡히는 사람들이다. 기제 설계 전에 "얼마나 자주
   * 걸 만한 상황이 오는가"를 사이징한다.
   */
  shoulderPct: number[];
  /** 그 밴드 안 상대 수 평균. */
  shoulderMean: number[];
  /**
   * **플리커(#178) 검출** — 백4 개인의 **진행도 축 방향 반전** / 100 선수-틱.
   * 두 스텝 모두 `FLICKER_FLOOR_M` 이상이고 부호가 반대일 때만 센다(미세 표류 배제,
   * `jitter.ts` 와 같은 규율). 트랩이 목표를 앞뒤로 흔들면 여기가 오른다.
   */
  lineFlickerPer100: number;
  /** 백4 개인의 진행도 축 절대 이동(m/tick) 평균 — 플리커는 이동량도 부풀린다. */
  lineStepAbsM: number;
  /**
   * **트리거 설계 표** — 공↔우리 골 거리 버킷별(`DANGER_BUCKETS_M`) 로:
   * 틱 점유율(%) · 어깨(4m) 인원 · 잡힌 인원 · 뚫린 비율(%).
   * "어디서 걸면 싸게 사는가"를 본다.
   */
  byDanger: { tickPct: number; shoulder4: number; caught: number; behindPct: number }[];
}

/** 위험거리 버킷 경계(m) — `defshape.ts` 와 같은 절단. */
export const DANGER_BUCKETS_M: readonly number[] = [25, 40, 60];

/** 어깨 밴드(m) — 라인에서 자기 골 쪽으로 이만큼 안에 있는 상대. */
export const SHOULDER_BANDS_M: readonly number[] = [2, 4, 6];

export interface TrapMeasure {
  home: TrapSideMeasure;
  away: TrapSideMeasure;
  /** 양 팀 합산(대칭 config 용). */
  both: TrapSideMeasure;
  /** 경기당 오프사이드 — **보고 전용**(노이즈 바닥). 팀별로도 나눈다. */
  offsidesPerMatch: number;
  offsidesAgainstHome: number;
  offsidesAgainstAway: number;
  /** 시드별 오프사이드(노이즈 검정용). */
  offsidesPerSeed: number[];
  /** 경기당 1대1 슛(트랩 실패 위험 축) — 팀별. */
  oneOnOneHome: number;
  oneOnOneAway: number;
  /** 볼륨 보고. */
  goalsPerMatch: number;
  goalsHome: number;
  goalsAway: number;
  shotsPerTeam: number;
}

const NB = [0, 1, 2, 3];
/** 방향 반전 판정 크기 하한(m/tick) — 미세 표류를 반전으로 세지 않는다(`jitter.ts` 규율). */
const FLICKER_FLOOR_M = 0.5;
const BURST_M = 0.8;
const FWD_EPS_M = 0.05;

interface Acc {
  defTicks: number;
  caughtSum: number;
  caughtHit: number;
  depth: number[];
  pairs: number;
  burst: number;
  syncFwd: number;
  stepSum: number;
  lineSum: number;
  lineN: number;
  behindHit: number;
  behindGoalDist: number[];
  shoulderHit: number[];
  shoulderSum: number[];
  bTicks: number[];
  bShoulder: number[];
  bCaught: number[];
  bBehind: number[];
  flickN: number;
  flickHit: number;
  stepAbsSum: number;
}
function newAcc(): Acc {
  return {
    defTicks: 0, caughtSum: 0, caughtHit: 0, depth: [], pairs: 0, burst: 0,
    syncFwd: 0, stepSum: 0, lineSum: 0, lineN: 0, behindHit: 0, behindGoalDist: [],
    shoulderHit: SHOULDER_BANDS_M.map(() => 0), shoulderSum: SHOULDER_BANDS_M.map(() => 0),
    bTicks: NB.map(() => 0), bShoulder: NB.map(() => 0), bCaught: NB.map(() => 0), bBehind: NB.map(() => 0),
    flickN: 0, flickHit: 0, stepAbsSum: 0,
  };
}
function quantile(v: readonly number[], q: number): number {
  if (!v.length) return 0;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * q)))]!;
}
function finish(a: Acc): TrapSideMeasure {
  return {
    defTicks: a.defTicks,
    caughtMean: a.defTicks ? a.caughtSum / a.defTicks : 0,
    caughtPct: a.defTicks ? (a.caughtHit / a.defTicks) * 100 : 0,
    caughtDepthM: mean(a.depth),
    burstPct: a.pairs ? (a.burst / a.pairs) * 100 : 0,
    syncFwdPct: a.pairs ? (a.syncFwd / a.pairs) * 100 : 0,
    stepMeanM: a.pairs ? a.stepSum / a.pairs : 0,
    lineMeanM: a.lineN ? a.lineSum / a.lineN : 0,
    behindLineOwnPct: a.defTicks ? (a.behindHit / a.defTicks) * 100 : 0,
    behindLineGoalDistM: quantile(a.behindGoalDist, 0.5),
    lineFlickerPer100: a.flickN ? (a.flickHit / a.flickN) * 100 : 0,
    lineStepAbsM: a.flickN ? a.stepAbsSum / a.flickN : 0,
    shoulderPct: a.shoulderHit.map((h) => (a.defTicks ? (h / a.defTicks) * 100 : 0)),
    shoulderMean: a.shoulderSum.map((h) => (a.defTicks ? h / a.defTicks : 0)),
    byDanger: NB.map((i) => ({
      tickPct: a.defTicks ? (a.bTicks[i]! / a.defTicks) * 100 : 0,
      shoulder4: a.bTicks[i]! ? a.bShoulder[i]! / a.bTicks[i]! : 0,
      caught: a.bTicks[i]! ? a.bCaught[i]! / a.bTicks[i]! : 0,
      behindPct: a.bTicks[i]! ? (a.bBehind[i]! / a.bTicks[i]!) * 100 : 0,
    })),
  };
}
function addAcc(dst: Acc, src: Acc): void {
  dst.defTicks += src.defTicks;
  dst.caughtSum += src.caughtSum;
  dst.caughtHit += src.caughtHit;
  dst.depth.push(...src.depth);
  dst.pairs += src.pairs;
  dst.burst += src.burst;
  dst.syncFwd += src.syncFwd;
  dst.stepSum += src.stepSum;
  dst.lineSum += src.lineSum;
  dst.lineN += src.lineN;
  dst.behindHit += src.behindHit;
  dst.behindGoalDist.push(...src.behindGoalDist);
  for (let i = 0; i < SHOULDER_BANDS_M.length; i++) {
    dst.shoulderHit[i]! += src.shoulderHit[i]!;
    dst.shoulderSum[i]! += src.shoulderSum[i]!;
  }
  dst.flickN += src.flickN;
  dst.flickHit += src.flickHit;
  dst.stepAbsSum += src.stepAbsSum;
  for (const i of NB) {
    dst.bTicks[i]! += src.bTicks[i]!;
    dst.bShoulder[i]! += src.bShoulder[i]!;
    dst.bCaught[i]! += src.bCaught[i]!;
    dst.bBehind[i]! += src.bBehind[i]!;
  }
}

/**
 * 시드 집합을 돌려 트랩 자 후보를 전부 잰다.
 *
 * @param patch 팀 지시 패치. `side` 를 받아 **비대칭**(한 팀만 트랩)으로 줄 수 있다 —
 *   같은 경기 안에서 대조하면 경기 전개 노이즈가 상쇄된다.
 */
export function measureTrap(
  config: EngineConfig,
  seeds: readonly string[],
  patch?: (t: TacticalInput, side: TeamSide) => TacticalInput,
): TrapMeasure {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const tol = config.rules.offside.toleranceM;
  const select = makeSelectData();
  const acc: Record<TeamSide, Acc> = { home: newAcc(), away: newAcc() };
  const both = newAcc();
  let offsides = 0;
  let offHome = 0;
  let offAway = 0;
  let ooHome = 0;
  let ooAway = 0;
  let goals = 0;
  let gHome = 0;
  let gAway = 0;
  let shots = 0;
  const offsidesPerSeed: number[] = [];

  for (const seed of seeds) {
    const h0 = makeTacticalInput("H", seed);
    const a0 = makeTacticalInput("A", seed);
    const h = patch ? patch(h0, "home") : h0;
    const a = patch ? patch(a0, "away") : a0;
    const log: MatchLog = runMatch(seed, h, a, select, config);

    let seedOff = 0;
    for (const e of log.events) {
      if (e.type === "offside") {
        offsides++;
        seedOff++;
        // 오프사이드를 당한 쪽 = 공격팀. 트랩을 건 쪽은 그 반대.
        if (e.team === "home") offAway++;
        else if (e.team === "away") offHome++;
      }
      if (e.type === "goal") {
        goals++;
        if (e.team === "home") gHome++;
        else if (e.team === "away") gAway++;
      }
      if (e.type === "shot") {
        shots++;
        if (e.detail === "one_on_one") {
          if (e.team === "home") ooHome++;
          else if (e.team === "away") ooAway++;
        }
      }
    }
    offsidesPerSeed.push(seedOff);

    const dead = new Set<number>();
    for (const e of log.events) {
      if (!RESTART_TYPES.has(e.type)) continue;
      for (let t = e.tick - DEAD_BEFORE; t <= e.tick + DEAD_AFTER; t++) dead.add(t);
    }

    const prog = (side: TeamSide, x: number): number => (side === "home" ? x : W - x);
    const prevBack: Record<string, { mu: number; each: number[]; t: number; d0: number[] | null }> = {};

    for (const sn of log.tickSnapshots) {
      if (dead.has(sn.tick)) continue;
      const o = sn.ballOwner;
      if (!o) continue;
      const atk = sideOfId(o);
      const def: TeamSide = atk === "home" ? "away" : "home";
      const a = acc[def];

      // 오프사이드 라인 = 수비팀에서 **2번째로 깊지 않은** 선수(GK 포함) — `contest.offsideLineProg`.
      const defProgs = sn.players.filter((p) => p.team === def).map((p) => prog(atk, p.pos.x)).sort((x, y) => y - x);
      if (defProgs.length < 2) continue;
      const line = defProgs[1]!;

      a.defTicks += 1;
      a.lineSum += W - line; // 수비팀 진행도(자기 골 0)로 환산.
      a.lineN += 1;

      let caught = 0;
      const shoulder = SHOULDER_BANDS_M.map(() => 0);
      for (const p of sn.players) {
        if (p.team !== atk) continue;
        if (roleOf(p.playerId) === "GK") continue;
        if (p.playerId === o) continue;
        const pr = prog(atk, p.pos.x);
        if (pr <= W / 2) continue;
        if (pr > line + tol) {
          caught += 1;
          a.depth.push(pr - line);
          continue;
        }
        // 라인 **바로 앞**(온사이드) = 밀어올리면 잡히는 사람.
        for (let i = 0; i < SHOULDER_BANDS_M.length; i++) {
          if (pr > line - SHOULDER_BANDS_M[i]!) shoulder[i]! += 1;
        }
      }
      for (let i = 0; i < SHOULDER_BANDS_M.length; i++) {
        a.shoulderSum[i]! += shoulder[i]!;
        if (shoulder[i]! > 0) a.shoulderHit[i]! += 1;
      }
      a.caughtSum += caught;
      if (caught > 0) a.caughtHit += 1;

      // 위험거리 버킷(공 ↔ 우리 골).
      const ourGoalX = def === "home" ? 0 : W;
      const dGoal = Math.hypot(sn.ball.x - ourGoalX, sn.ball.y - H / 2);
      let bi = DANGER_BUCKETS_M.length;
      for (let i = 0; i < DANGER_BUCKETS_M.length; i++) {
        if (dGoal < DANGER_BUCKETS_M[i]!) { bi = i; break; }
      }
      a.bTicks[bi]! += 1;
      a.bShoulder[bi]! += shoulder[1]!;
      a.bCaught[bi]! += caught;

      // 소유자가 라인 뒤 = 뚫렸다.
      const ownerP = sn.players.find((p) => p.playerId === o);
      if (ownerP && prog(atk, ownerP.pos.x) > line + tol) {
        a.behindHit += 1;
        a.bBehind[bi]! += 1;
        const gx = def === "home" ? 0 : W;
        a.behindGoalDist.push(Math.hypot(ownerP.pos.x - gx, ownerP.pos.y - H / 2));
      }

      // 백4 라인 전진(수비팀 진행도).
      const back = sn.players
        .filter((p) => p.team === def && BACK_FOUR.has(roleOf(p.playerId)))
        .sort((x, y) => (x.playerId < y.playerId ? -1 : 1))
        .map((p) => prog(def, p.pos.x));
      if (back.length === 4) {
        const mu = mean(back);
        const pv = prevBack[def];
        let d1: number[] | null = null;
        if (pv && pv.t === sn.tick - 1) {
          a.pairs += 1;
          const d = mu - pv.mu;
          a.stepSum += d;
          if (d >= BURST_M) a.burst += 1;
          let fwd = 0;
          for (let i = 0; i < 4; i++) if (back[i]! - pv.each[i]! > FWD_EPS_M) fwd++;
          if (fwd === 4) a.syncFwd += 1;
          // 개인별 진행도 변위 — 플리커(#178) 검출용. 두 스텝 모두 하한 위 + 부호 반대일 때만.
          d1 = back.map((v, i) => v - pv.each[i]!);
          for (const v of d1) a.stepAbsSum += Math.abs(v);
          a.flickN += 4;
          if (pv.d0) {
            for (let i = 0; i < 4; i++) {
              const x = pv.d0[i]!;
              const y = d1[i]!;
              if (Math.abs(x) >= FLICKER_FLOOR_M && Math.abs(y) >= FLICKER_FLOOR_M && x * y < 0) a.flickHit += 1;
            }
          }
        }
        prevBack[def] = { mu, each: back, t: sn.tick, d0: d1 };
      }
    }
  }

  addAcc(both, acc.home);
  addAcc(both, acc.away);
  const n = seeds.length;
  return {
    home: finish(acc.home),
    away: finish(acc.away),
    both: finish(both),
    offsidesPerMatch: n ? offsides / n : 0,
    offsidesAgainstHome: n ? offHome / n : 0,
    offsidesAgainstAway: n ? offAway / n : 0,
    offsidesPerSeed,
    oneOnOneHome: n ? ooHome / n : 0,
    oneOnOneAway: n ? ooAway / n : 0,
    goalsPerMatch: n ? goals / n : 0,
    goalsHome: n ? gHome / n : 0,
    goalsAway: n ? gAway / n : 0,
    shotsPerTeam: n ? shots / n / 2 : 0,
  };
}

/* ------------------------------------------------------------------------- *
 * 발화 계측 — **배정한 쪽이 단 라벨**(`DefShapeSample.trapBiasFx`)로만 판정한다
 * ------------------------------------------------------------------------- */

export interface TrapFireReport {
  /** 관측된 수비 팀-틱 수. **트랩이 안 걸린 틱도 분모에 들어간다**(S3-A/B 관용구). */
  lineTicks: number;
  /** 그중 트랩이 걸린 틱 비율(%). */
  firePct: number;
  /** 걸린 틱에서의 전진량 평균(m). */
  biasWhenFiredM: number;
  /** 전 틱 평균 전진량(m) = 라인 평균 높이에 트랩이 기여한 몫. */
  biasAllTicksM: number;
  /** 걸린 틱의 최대 전진량(m) — `stepUpM` 을 넘지 않아야 한다. */
  biasMaxM: number;
  /** 연속 발화 구간 길이 평균(틱) — "잠깐 걸었다 푼다"의 직접 관찰량. */
  runLenMeanTicks: number;
  /** 발화 ↔ 비발화 **전환 횟수** / 100틱 — 플리커(#178) 검출. */
  togglesPer100: number;
}

/** 트랩 발화 계측(엔진 라벨). `patch` 로 트랩을 켠다. */
export function measureTrapFire(
  config: EngineConfig,
  seeds: readonly string[],
  patch?: (t: TacticalInput, side: TeamSide) => TacticalInput,
): TrapFireReport {
  const scale = config.fixedScale;
  const select = makeSelectData();
  let lineTicks = 0;
  let fired = 0;
  let biasFiredSum = 0;
  let biasAllSum = 0;
  let biasMax = 0;
  let toggles = 0;
  const runLens: number[] = [];

  for (const seed of seeds) {
    const samples: DefShapeSample[] = [];
    setDefShapeObserver((s) => {
      if (s.kind === "line") samples.push(s);
    });
    try {
      const h0 = makeTacticalInput("H", seed);
      const a0 = makeTacticalInput("A", seed);
      runMatch(seed, patch ? patch(h0, "home") : h0, patch ? patch(a0, "away") : a0, select, config);
    } finally {
      setDefShapeObserver(null);
    }
    const prev: Record<string, { on: boolean; run: number; tick: number }> = {};
    for (const s of samples) {
      if (s.kind !== "line") continue;
      lineTicks += 1;
      const bias = s.trapBiasFx / scale;
      biasAllSum += bias;
      const on = s.trapBiasFx > 0;
      if (on) {
        fired += 1;
        biasFiredSum += bias;
        if (bias > biasMax) biasMax = bias;
      }
      const pv = prev[s.side];
      // 인접 틱끼리만 비교한다(건너뛴 구간을 전환으로 세면 플리커가 부풀려진다).
      if (pv && pv.tick === s.tick - 1) {
        if (pv.on !== on) {
          toggles += 1;
          if (pv.on) runLens.push(pv.run);
          prev[s.side] = { on, run: 1, tick: s.tick };
          continue;
        }
        prev[s.side] = { on, run: pv.run + 1, tick: s.tick };
        continue;
      }
      if (pv && pv.on) runLens.push(pv.run);
      prev[s.side] = { on, run: 1, tick: s.tick };
    }
    for (const k of Object.keys(prev)) if (prev[k]!.on) runLens.push(prev[k]!.run);
  }

  return {
    lineTicks,
    firePct: lineTicks ? (fired / lineTicks) * 100 : 0,
    biasWhenFiredM: fired ? biasFiredSum / fired : 0,
    biasAllTicksM: lineTicks ? biasAllSum / lineTicks : 0,
    biasMaxM: biasMax,
    runLenMeanTicks: mean(runLens),
    togglesPer100: lineTicks ? (toggles / lineTicks) * 100 : 0,
  };
}

/* ------------------------------------------------------------------------- *
 * 심판 ↔ 패스 생성기 라인 불일치(#377 S3-C T9) — `trapBiasM` 의 잠복 결함
 * ------------------------------------------------------------------------- */

/**
 * **심판만 쓰는 라인과 나머지가 쓰는 라인이 갈린 사례 수**(경기당).
 *
 * `rules.offside.trapBiasM` 은 `contest.ts:checkOffside` **한 곳에서만** 판정선을 옮긴다.
 * 같은 라인을 쓰는 `through.ts:throughPassOptions`(온사이드 게이트)와 `chain.ts` 진단은
 * **보정 없는** `offsideLineProg` 를 쓴다. 그래서 리시버가
 *
 *     라인 + tol − trapBias  <  진행도  ≤  라인 + tol
 *
 * 구간에 있으면 **생성기는 "온사이드"라 믿고 찌르는데 심판은 깃발을 든다.**
 * `trapBiasM = 0`(출하)이면 그 구간은 폭이 0 이라 사례가 **정확히 0** 이어야 한다.
 *
 * 세는 방법: `offside` 이벤트의 리시버를 **직전 틱 스냅샷**에서 찾아(이벤트 틱은 이미 재시작
 * 배치가 섞인다) 보정 없는 2nd-last 라인과 비교한다.
 */
export function measureRefereeLineMismatch(
  config: EngineConfig,
  seeds: readonly string[],
  patch?: (t: TacticalInput, side: TeamSide) => TacticalInput,
): { offsides: number; mismatched: number } {
  const W = config.pitch.width;
  const tol = config.rules.offside.toleranceM;
  const bias = config.rules.offside.trapBiasM;
  const select = makeSelectData();
  let offsides = 0;
  let mismatched = 0;

  for (const seed of seeds) {
    const h0 = makeTacticalInput("H", seed);
    const a0 = makeTacticalInput("A", seed);
    const log = runMatch(seed, patch ? patch(h0, "home") : h0, patch ? patch(a0, "away") : a0, select, config);
    const byTick = new Map<number, (typeof log.tickSnapshots)[number]>();
    for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);

    for (const e of log.events) {
      if (e.type !== "offside" || !e.team || !e.playerId) continue;
      offsides++;
      const sn = byTick.get(e.tick - 1);
      if (!sn) continue;
      const atk = e.team as TeamSide;
      const prog = (x: number): number => (atk === "home" ? x : W - x);
      const rec = sn.players.find((p) => p.playerId === e.playerId && p.team === atk);
      if (!rec) continue;
      const defProgs = sn.players.filter((p) => p.team !== atk).map((p) => prog(p.pos.x)).sort((x, y) => y - x);
      if (defProgs.length < 2) continue;
      const line = defProgs[1]!;
      const pr = prog(rec.pos.x);
      // 생성기 기준으로는 온사이드(라인+tol 이하)인데 깃발이 올랐다 = 심판만 다른 라인을 썼다.
      if (pr <= line + tol && bias > 0) mismatched++;
    }
  }
  const n = seeds.length || 1;
  return { offsides: offsides / n, mismatched: mismatched / n };
}

/** 팀 지시 패치 — 한 팀만 트랩을 켠다(같은 경기 안 대조). */
export function trapOn(target: TeamSide | "both"): (t: TacticalInput, side: TeamSide) => TacticalInput {
  return (t, side) =>
    target === "both" || target === side
      ? { ...t, team: { ...t.team, offsideTrap: true } }
      : t;
}

/** 라인 높이 슬라이더 패치(양 팀). */
export function withLine(v: number): (t: TacticalInput) => TacticalInput {
  return (t) => ({ ...t, team: { ...t.team, defensiveLineHeight: v } });
}

/**
 * **무소유 급정지**(#313 · #399) — `ball-physics.test.ts:unownedDeadStops` 와 **같은 정의**의
 * 복사본이다. 그 함수는 테스트 파일 안에 있어 import 할 수 없고, 그 파일은 #399 소유라
 * 이 웨이브가 손대지 않는다. **갈라지지 않았다는 보증**은 출하 config·같은 8시드에서 두 값이
 * 일치하는지 확인하는 것이다(스코프 실측 27.0 == 27.0). 트랩은 라인을 밀어올리므로 이 축을
 * 반드시 같이 잰다.
 */
export function unownedDeadStops(log: MatchLog): number {
  const S = log.tickSnapshots;
  const cut = new Set<number>();
  for (const e of log.events) {
    const kind = e.type === "kickoff" && e.detail ? e.detail : e.type;
    if (["corner", "goal_kick", "throw_in", "free_kick", "penalty", "kickoff", "goal"].includes(kind)) {
      for (let t = e.tick - 1; t <= e.tick + 1; t++) cut.add(t);
    }
  }
  let n = 0;
  for (let i = 2; i < S.length; i++) {
    const a = S[i - 2]!, b = S[i - 1]!, c = S[i]!;
    if (cut.has(b.tick) || cut.has(c.tick)) continue;
    if (b.ballOwner != null || c.ballOwner != null) continue;
    const d1 = Math.hypot(b.ball.x - a.ball.x, b.ball.y - a.ball.y);
    const d2 = Math.hypot(c.ball.x - b.ball.x, c.ball.y - b.ball.y);
    if (d1 > 3 && d2 < 0.2) n++;
  }
  return n;
}

/** 시드 집합의 무소유 급정지 평균(경기당). */
export function measureDeadStops(
  config: EngineConfig,
  seeds: readonly string[],
  patch?: (t: TacticalInput, side: TeamSide) => TacticalInput,
): number {
  const select = makeSelectData();
  let sum = 0;
  for (const seed of seeds) {
    const h0 = makeTacticalInput("H", seed);
    const a0 = makeTacticalInput("A", seed);
    const log = runMatch(seed, patch ? patch(h0, "home") : h0, patch ? patch(a0, "away") : a0, select, config);
    sum += unownedDeadStops(log);
  }
  return seeds.length ? sum / seeds.length : 0;
}

/** 표본 표준편차(보고용). */
export const sampleSd = sd;
