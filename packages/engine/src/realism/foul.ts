import type { EngineConfig } from "../config";
import type { SimState, SimPlayer } from "../simstate";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { setDecisionObserver } from "../action";
import { setTackleObserver, type TackleObservation } from "../contest";

/**
 * realism/foul — **파울 붕괴 분해 계측**(#358).
 *
 * ## 무엇을 가르는가
 * `rules.foul.base` 는 **태클 시도당** 확률이라
 *   `파울 수 = 태클 시도 수 × 시도당 파울률`
 * 이다. 이벤트 로그에는 **분자(파울)만** 있어서, 파울이 12.63 → 2.15 로 떨어졌을 때
 * "기회(분모)가 사라진 것"인지 "판정(분자율)이 약해진 것"인지 로그만으로는 못 가른다.
 * 여기서 두 축을 따로 센다:
 *  - **분모** = `tryTackle` 이 실제로 호출된 틱(= 소유·인플레이 틱) 중 `tackleRange` 안에
 *    상대가 있었던 틱 수. 관측자(`contest.setTackleObserver`)가 흘려보내는 값을 그대로 쓴다.
 *  - **분자율** = 그 시도 중 파울로 판정된 비율.
 *
 * ## 왜 재계산하지 않나
 * 진단이 기하를 다시 계산하면 구현과 **같은 실수를 공유한다**(one-on-one.ts 와 같은 규율).
 * 그래서 `tryTackle` **안**에서 관측한다 — 시도 판정·파울 확률·롤 결과 전부 엔진이 쓴 그 값이다.
 *
 * ## #358 가설의 직접 검증
 * 결정 관측자(`action.setDecisionObserver`)와 **같은 틱 키**로 조인해
 * "hold 를 고른 틱 vs 움직이는 행동을 고른 틱"의 **시도율**을 따로 낸다.
 * 가설("소유자가 서 있지 않게 되면서 태클 기회가 사라졌다")이 맞다면
 * hold 틱의 시도율이 carry/pass 틱보다 뚜렷이 높아야 한다.
 *
 * ## #349 (프리킥을 안 차고 드리블한다)
 * 프리킥 세트피스가 **살아 있는 동안**(`state.setPiece.kind === "free_kick"`) taker 가 고른
 * **첫 행동**을 센다. `match.ts` 는 `action.kind !== "hold"` 인 순간 `setPiece` 를 지우므로,
 * 이 창에서 관측되는 첫 non-hold 행동이 곧 "프리킥을 어떻게 재개했나"다.
 *
 * 순수 분석 유틸(프로덕션 `index.ts` 에 export 되지 않는다).
 */

export type DecisionKind = "shoot" | "pass" | "dribble" | "clearance" | "hold";
const KINDS: DecisionKind[] = ["shoot", "pass", "dribble", "clearance", "hold"];

export interface KindCounts {
  shoot: number;
  pass: number;
  dribble: number;
  clearance: number;
  hold: number;
}
function zeroKinds(): KindCounts {
  return { shoot: 0, pass: 0, dribble: 0, clearance: 0, hold: 0 };
}
function kindTotal(k: KindCounts): number {
  return KINDS.reduce((s, key) => s + k[key], 0);
}

export interface FoulBreakdown {
  matches: number;
  /** `tryTackle` 호출 틱 수(= 소유·인플레이·세트피스아님 틱). 분모의 분모. */
  ownedTicks: number;
  /** 그중 `tackleRange` 안에 상대가 있던 틱 = **태클 시도**(분모). */
  attempts: number;
  /** 파울 판정 수(분자). */
  fouls: number;
  /** 태클 성공(소유 이전) 수. */
  tackles: number;
  /** 박스 안 시도 수(페널티 경로 분모). */
  attemptsInBox: number;
  /** 박스 안 파울 수(= PK). */
  foulsInBox: number;
  /** 시도 틱의 `foulProb` 합 — 기대 파울 수(롤 노이즈 제거). */
  foulProbSum: number;
  /** 최근접 상대 거리(m) 합 / 표본(소유 틱 전체, Infinity 제외). */
  nearestSum: number;
  nearestN: number;
  /** 소유 틱 중 최근접 상대가 2·3·5m 안이었던 수(임계 민감도). */
  within: Record<string, number>;

  /** 소유자 결정 분포(전체). */
  byKind: KindCounts;
  /** 결정 종류별 — 그 틱의 태클 시도 수(#358 가설 검증). */
  attemptsByKind: KindCounts;
  /** 결정 종류별 — 그 틱의 파울 수. */
  foulsByKind: KindCounts;

  /** 이벤트 로그 기준 집계(교차 검증용). */
  ev: {
    foul: number;
    tackle: number;
    card: number;
    penalty: number;
    freeKick: number;
    yellow: number;
    red: number;
  };

  /** #349 — 프리킥 재시작 창에서 taker 가 고른 첫 non-hold 행동. */
  fkFirst: KindCounts;
  /** 프리킥 세트피스가 살아 있던 동안의 결정 전체(hold 포함). */
  fkAll: KindCounts;

  /**
   * **추격 수렴** — 연속된 두 소유 틱(같은 소유자, tick+1)에서 최근접 상대 거리의 변화.
   * 이전 틱의 결정 종류별로 나눈다. `압박 담당은 공의 현재 위치를 목표로 삼는다`
   * (`decision.ts` decideOffBall) — 순수 추격이라 같은 속도의 도망자에게는 원리상 못 붙는다.
   * 그 성질이 실제로 나타나는지 여기서 본다: dribble 이전 틱에서 Δ 가 0 이상이면 못 좁힌 것.
   */
  chase: Record<DecisionKind, { n: number; sumDelta: number; closed: number; startSum: number }>;

  /**
   * **소유 런 구조** — 한 선수가 공을 잡고 있는 연속 틱(런)을, 런 시작으로부터의 경과 틱 index 별로
   * 본다. 추격이 매 틱 좁혀도 **런이 짧으면 수비수는 도착할 시간을 못 받는다** —
   * 그러면 파울의 분모가 사라진 원인은 "추격 실패"가 아니라 "체류 시간 소멸"이다.
   * 두 원인은 처방이 정반대라 반드시 갈라야 한다.
   */
  runLen: number[];
  /** index 별 [표본, 최근접거리 합, 시도 수]. index 4 = 4틱 이상 전부. */
  byAge: Array<{ n: number; nearSum: number; attempts: number; fouls: number }>;

  /**
   * **스윕(틱 중 최근접) vs 끝점** — `tryTackle` 은 틱 **끝 좌표**만 본다. 선수는 한 틱에
   * 3~7m 를 움직이므로, 틱 중간에 스쳐 지나간 접촉은 끝점 표본에서 통째로 빠진다.
   * 엔진은 **공에 대해서는 이미 이 문제를 인정하고 있다**(`BallFlight.fromX/fromY` +
   * `ball.nearestOnSweep` = 스윕 접촉 판정). 선수-선수만 끝점 판정으로 남아 있다.
   *
   * 여기서는 스냅샷 두 장(t−1, t)으로 두 선수의 이동 **선분끼리** 최소거리를 재
   * "스윕으로 재면 시도가 얼마나 되는가"를 **구현 전에** 확인한다.
   */
  sweep: { n: number; endWithin: number; sweepWithin: number; endSum: number; sweepSum: number };

  /**
   * **교전(engagement) 재집계** — 지금 모델은 파울을 *틱당* 롤한다. 즉 파울 수가
   * `수비수가 캐리어 곁에 머문 초` 에 비례한다 = **체류 시간 과금**. 템포·hold 비율·패스 빈도가
   * 바뀌면 체류 시간이 바뀌고, `foul.base` 를 한 번도 안 건드려도 파울 수가 움직인다(#358 의 정체).
   *
   * 여기서는 같은 표본을 **교전 단위**로 다시 센다: 같은 (태클러, 캐리어) 쌍의 연속 시도는
   * 한 번의 교전이고, 재도전은 `k` 틱 쿨다운 뒤부터다. `k`(=0 이면 현행 틱당 과금).
   */
  engagements: Record<string, number>;
  /** 시도가 한 번이라도 있었던 소유 런 수(= "붙어 본" 장면 수). */
  runsWithAttempt: number;
}

function zeroChase(): FoulBreakdown["chase"] {
  const o = {} as FoulBreakdown["chase"];
  for (const k of KINDS) o[k] = { n: 0, sumDelta: 0, closed: 0, startSum: 0 };
  return o;
}

function zero(): FoulBreakdown {
  return {
    matches: 0, ownedTicks: 0, attempts: 0, fouls: 0, tackles: 0,
    attemptsInBox: 0, foulsInBox: 0, foulProbSum: 0, nearestSum: 0, nearestN: 0,
    within: { "2": 0, "3": 0, "5": 0 },
    byKind: zeroKinds(), attemptsByKind: zeroKinds(), foulsByKind: zeroKinds(),
    ev: { foul: 0, tackle: 0, card: 0, penalty: 0, freeKick: 0, yellow: 0, red: 0 },
    fkFirst: zeroKinds(), fkAll: zeroKinds(), chase: zeroChase(),
    runLen: [],
    byAge: Array.from({ length: 5 }, () => ({ n: 0, nearSum: 0, attempts: 0, fouls: 0 })),
    sweep: { n: 0, endWithin: 0, sweepWithin: 0, endSum: 0, sweepSum: 0 },
    engagements: { "1": 0, "2": 0, "3": 0, "5": 0, "99": 0 },
    runsWithAttempt: 0,
  };
}

/** 쿨다운 k 틱 기준 교전 수(같은 태클러·같은 캐리어의 연속 시도를 한 번으로 접는다). */
const COOLDOWNS = [1, 2, 3, 5, 99];

/** 두 선분(각각 a0→a1, b0→b1) 사이 최소거리. 상대운동으로 환원해 1차원 최소화(분석 전용, float). */
function segMinDist(
  a0: { x: number; y: number }, a1: { x: number; y: number },
  b0: { x: number; y: number }, b1: { x: number; y: number },
): number {
  // r(t) = (a0−b0) + t·((a1−a0) − (b1−b0)), t∈[0,1]
  const rx = a0.x - b0.x, ry = a0.y - b0.y;
  const vx = (a1.x - a0.x) - (b1.x - b0.x);
  const vy = (a1.y - a0.y) - (b1.y - b0.y);
  const vv = vx * vx + vy * vy;
  let t = 0;
  if (vv > 0) t = Math.max(0, Math.min(1, -(rx * vx + ry * vy) / vv));
  const dx = rx + t * vx, dy = ry + t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 다시드 파울 분해 수집. config 를 바꿔 호출하면 그대로 대조군이 된다. */
export function collectFoul(config: EngineConfig, seeds: string[]): FoulBreakdown {
  const acc = zero();
  const select = makeSelectData();

  for (const seed of seeds) {
    // 틱 → 그 틱에 소유자가 고른 행동. 결정(decide)이 태클(act)보다 먼저라 같은 틱 키로 조인된다.
    const kindAtTick = new Map<number, DecisionKind>();
    // 프리킥 세트피스가 살아 있는 동안 관측된 결정.
    let fkWindowOpen = false;

    setDecisionObserver((raw, _owner: SimPlayer, kind) => {
      const st = raw as SimState;
      const k = kind as DecisionKind;
      kindAtTick.set(st.tick, k);
      const sp = st.setPiece;
      if (sp && sp.kind === "free_kick") {
        acc.fkAll[k] += 1;
        if (!fkWindowOpen) fkWindowOpen = true;
        if (k !== "hold") {
          // 이 결정으로 setPiece 가 지워진다 = 프리킥을 이렇게 재개했다.
          acc.fkFirst[k] += 1;
          fkWindowOpen = false;
        }
      } else {
        fkWindowOpen = false;
      }
    });

    const obsBuf: TackleObservation[] = [];
    setTackleObserver((o) => obsBuf.push(o));

    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);

    setTackleObserver(null);
    setDecisionObserver(null);

    acc.matches += 1;
    for (let i = 0; i < obsBuf.length; i++) {
      const o = obsBuf[i]!;
      const nx = obsBuf[i + 1];
      if (
        nx && nx.tick === o.tick + 1 && nx.ownerId === o.ownerId && nx.ownerSide === o.ownerSide &&
        Number.isFinite(o.nearestOppM) && Number.isFinite(nx.nearestOppM)
      ) {
        const k = kindAtTick.get(o.tick);
        if (k) {
          const c = acc.chase[k];
          c.n += 1;
          c.sumDelta += nx.nearestOppM - o.nearestOppM;
          c.startSum += o.nearestOppM;
          if (nx.nearestOppM < o.nearestOppM) c.closed += 1;
        }
      }
    }
    // --- 스윕 대조: 같은 틱을 끝점 / 선분 두 방식으로 잰다 ---
    {
      const range = config.contest.tackleRange;
      const snapAt = new Map(log.tickSnapshots.map((s) => [s.tick, s]));
      for (const o of obsBuf) {
        const cur = snapAt.get(o.tick);
        const prv = snapAt.get(o.tick - 1);
        if (!cur || !prv) continue;
        const side = o.ownerSide;
        const key = (t: string, id: string): string => `${t}:${id}`;
        const prevPos = new Map(prv.players.map((p) => [key(p.team, p.playerId), p.pos]));
        const own = cur.players.find((p) => p.team === side && p.playerId === o.ownerId);
        const ownPrev = prevPos.get(key(side, o.ownerId));
        if (!own || !ownPrev) continue;
        let bestEnd = Infinity;
        let bestSweep = Infinity;
        for (const q of cur.players) {
          if (q.team === side) continue;
          const qPrev = prevPos.get(key(q.team, q.playerId));
          if (!qPrev) continue;
          const de = Math.hypot(q.pos.x - own.pos.x, q.pos.y - own.pos.y);
          if (de < bestEnd) bestEnd = de;
          const ds = segMinDist(ownPrev, own.pos, qPrev, q.pos);
          if (ds < bestSweep) bestSweep = ds;
        }
        if (!Number.isFinite(bestEnd) || !Number.isFinite(bestSweep)) continue;
        acc.sweep.n += 1;
        acc.sweep.endSum += bestEnd;
        acc.sweep.sweepSum += bestSweep;
        if (bestEnd <= range) acc.sweep.endWithin += 1;
        if (bestSweep <= range) acc.sweep.sweepWithin += 1;
      }
    }

    // 소유 런 = 연속 틱 · 같은 소유자.
    let runStart = 0;
    for (let i = 0; i < obsBuf.length; i++) {
      const o = obsBuf[i]!;
      const prev = obsBuf[i - 1];
      const isNew = !prev || prev.tick !== o.tick - 1 || prev.ownerId !== o.ownerId || prev.ownerSide !== o.ownerSide;
      if (isNew) runStart = o.tick;
      const age = Math.min(4, o.tick - runStart);
      const b = acc.byAge[age]!;
      b.n += 1;
      if (Number.isFinite(o.nearestOppM)) b.nearSum += o.nearestOppM;
      if (o.attempt) b.attempts += 1;
      if (o.fouled) b.fouls += 1;
      const nx = obsBuf[i + 1];
      const isEnd = !nx || nx.tick !== o.tick + 1 || nx.ownerId !== o.ownerId || nx.ownerSide !== o.ownerSide;
      if (isEnd) acc.runLen.push(o.tick - runStart + 1);
    }
    // 교전 재집계: (태클러, 캐리어) 쌍별 마지막 과금 틱을 들고, 쿨다운을 넘겼을 때만 새 교전으로 센다.
    for (const k of COOLDOWNS) {
      const last = new Map<string, number>();
      for (const o of obsBuf) {
        if (!o.attempt || !o.tacklerId) continue;
        const key = `${o.ownerSide}:${o.ownerId}|${o.tacklerId}`;
        const prev = last.get(key);
        if (prev === undefined || o.tick - prev >= k) {
          acc.engagements[String(k)]! += 1;
          last.set(key, o.tick);
        }
      }
    }
    {
      let runHasAttempt = false;
      for (let i = 0; i < obsBuf.length; i++) {
        const o = obsBuf[i]!;
        const prev = obsBuf[i - 1];
        const isNew = !prev || prev.tick !== o.tick - 1 || prev.ownerId !== o.ownerId || prev.ownerSide !== o.ownerSide;
        if (isNew) runHasAttempt = false;
        if (o.attempt && !runHasAttempt) {
          runHasAttempt = true;
          acc.runsWithAttempt += 1;
        }
      }
    }
    for (const o of obsBuf) {
      acc.ownedTicks += 1;
      if (Number.isFinite(o.nearestOppM)) {
        acc.nearestSum += o.nearestOppM;
        acc.nearestN += 1;
        if (o.nearestOppM <= 2) acc.within["2"]! += 1;
        if (o.nearestOppM <= 3) acc.within["3"]! += 1;
        if (o.nearestOppM <= 5) acc.within["5"]! += 1;
      }
      const k = kindAtTick.get(o.tick);
      if (k) acc.byKind[k] += 1;
      if (!o.attempt) continue;
      acc.attempts += 1;
      acc.foulProbSum += o.foulProb;
      if (o.inBox) acc.attemptsInBox += 1;
      if (k) acc.attemptsByKind[k] += 1;
      if (o.fouled) {
        acc.fouls += 1;
        if (o.inBox) acc.foulsInBox += 1;
        if (k) acc.foulsByKind[k] += 1;
      }
      if (o.tackled) acc.tackles += 1;
    }

    for (const e of log.events) {
      if (e.type === "foul") acc.ev.foul += 1;
      else if (e.type === "tackle") acc.ev.tackle += 1;
      else if (e.type === "penalty") acc.ev.penalty += 1;
      else if (e.type === "free_kick") acc.ev.freeKick += 1;
      else if (e.type === "card") {
        acc.ev.card += 1;
        if (e.detail === "yellow") acc.ev.yellow += 1;
        else if (e.detail === "red") acc.ev.red += 1;
      }
    }
  }
  return acc;
}

function pct(n: number, d: number): string {
  return d === 0 ? "  n/a" : `${((n / d) * 100).toFixed(2)}%`;
}

/** 한 셀(= 하나의 config)의 리포트 블록. 팀-경기 단위는 `/2` 로 낸다. */
export function renderFoul(label: string, r: FoulBreakdown): string {
  const m = r.matches;
  const L: string[] = [];
  L.push(`── ${label} (${m} 경기) ──`);
  L.push(
    `  파울/팀 ${(r.ev.foul / m / 2).toFixed(2)} · 태클/팀 ${(r.ev.tackle / m / 2).toFixed(2)} · ` +
      `옐로/팀 ${(r.ev.yellow / m / 2).toFixed(2)} · 레드 ${r.ev.red} · PK ${(r.ev.penalty / m).toFixed(3)}/경기 · ` +
      `프리킥 ${(r.ev.freeKick / m).toFixed(2)}/경기`,
  );
  L.push(
    `  [분모] 소유틱 ${(r.ownedTicks / m).toFixed(1)}/경기 · ` +
      `**태클시도 ${(r.attempts / m).toFixed(1)}/경기** (소유틱의 ${pct(r.attempts, r.ownedTicks)})`,
  );
  L.push(
    `  [분자율] 시도당 파울 ${pct(r.fouls, r.attempts)} · 기대(foulProb 평균) ` +
      `${r.attempts ? (r.foulProbSum / r.attempts * 100).toFixed(2) : "n/a"}% · ` +
      `시도당 태클성공 ${pct(r.tackles, r.attempts)}`,
  );
  L.push(
    `  [박스] 시도 ${(r.attemptsInBox / m).toFixed(2)}/경기 · 파울 ${(r.foulsInBox / m).toFixed(3)}/경기`,
  );
  L.push(
    `  [근접] 소유틱 최근접상대 평균 ${r.nearestN ? (r.nearestSum / r.nearestN).toFixed(2) : "n/a"}m · ` +
      `≤2m ${pct(r.within["2"]!, r.ownedTicks)} · ≤3m ${pct(r.within["3"]!, r.ownedTicks)} · ≤5m ${pct(r.within["5"]!, r.ownedTicks)}`,
  );
  const tot = kindTotal(r.byKind);
  L.push(
    `  [결정] ${KINDS.map((k) => `${k} ${pct(r.byKind[k], tot)}`).join(" · ")}`,
  );
  L.push(
    `  [결정별 시도율] ${KINDS.map((k) => `${k} ${pct(r.attemptsByKind[k], r.byKind[k])}`).join(" · ")}`,
  );
  L.push(
    `  [교전] 쿨다운별 교전/경기 ${COOLDOWNS.map((k) => `k=${k === 99 ? "∞" : k} ${(r.engagements[String(k)]! / m).toFixed(1)}`).join(" · ")} · ` +
      `시도 있던 소유런 ${(r.runsWithAttempt / m).toFixed(1)}/경기`,
  );
  const sw = r.sweep;
  L.push(
    `  [스윕대조] n=${sw.n} · 끝점 평균 ${(sw.endSum / sw.n).toFixed(2)}m ≤range ${pct(sw.endWithin, sw.n)} · ` +
      `**선분 평균 ${(sw.sweepSum / sw.n).toFixed(2)}m ≤range ${pct(sw.sweepWithin, sw.n)}** · ` +
      `배율 ×${(sw.sweepWithin / Math.max(1, sw.endWithin)).toFixed(2)}`,
  );
  const runs = r.runLen;
  const runMean = runs.length ? runs.reduce((s, v) => s + v, 0) / runs.length : 0;
  const sorted = [...runs].sort((a, b) => a - b);
  const p = (q: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]! : 0);
  L.push(
    `  [소유런] ${(runs.length / m).toFixed(1)}회/경기 · 평균 ${runMean.toFixed(2)}틱 · p50 ${p(0.5)} · p90 ${p(0.9)} · ` +
      `1틱짜리 ${pct(runs.filter((v) => v === 1).length, runs.length)}`,
  );
  L.push(
    `  [런 경과별] ${r.byAge
      .map((b, i) => `t+${i}${i === 4 ? "+" : " "} n=${(b.n / m).toFixed(0)} 근접 ${b.n ? (b.nearSum / b.n).toFixed(2) : "n/a"}m 시도 ${pct(b.attempts, b.n)}`)
      .join(" · ")}`,
  );
  L.push(
    `  [추격] ${KINDS.filter((k) => r.chase[k].n > 0)
      .map((k) => {
        const c = r.chase[k];
        return `${k} n=${c.n} 시작 ${(c.startSum / c.n).toFixed(2)}m Δ ${(c.sumDelta / c.n >= 0 ? "+" : "")}${(c.sumDelta / c.n).toFixed(3)}m 좁힘 ${pct(c.closed, c.n)}`;
      })
      .join(" · ")}`,
  );
  L.push(
    `  [#349 프리킥 첫행동] ${KINDS.map((k) => `${k} ${r.fkFirst[k]}`).join(" · ")} · ` +
      `carry 비율 ${pct(r.fkFirst.dribble, kindTotal(r.fkFirst))}`,
  );
  return L.join("\n");
}
