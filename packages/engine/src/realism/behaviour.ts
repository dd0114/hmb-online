import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";

/**
 * realism/behaviour — **행동·의도 계층**(#314)의 계량.
 *
 * hero 실관전 제보 3건을 수치로 되돌려 받기 위한 진단 모듈이다:
 *  ⓐ "공도 안 걷어낸다"          → `clearances`(팀·경기)
 *  ⓑ "차면 찰 때부터 뛰어들어간다" → `fwdRunnersAtPass` · `runnerMarkDistM` · `passerForwardPct`
 *  ⓒ "레드만 움직이고 블루는 가만" → `nonPossStillPct` · 데드볼 비대칭
 *
 * 순수 분석 유틸이다(엔진 프로덕션 빌드에 export 되지 않는다). MatchLog 만 읽고 시뮬을
 * 다시 돌리지 않으므로 결정론에 영향이 0 이다.
 */

function sideOfId(playerId: string): TeamSide {
  return playerId.startsWith("H") ? "home" : "away";
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** side 팀 공격 방향 진행도(m). 0 = 자기 골라인, W = 상대 골라인. */
function prog(side: TeamSide, x: number, W: number): number {
  return side === "home" ? x : W - x;
}

/** 재시작 계열 이벤트 — 이 틱 주변은 "데드볼 창"으로 본다(h3-ablate 와 같은 정의). */
const RESTART_EVENTS = new Set([
  "kickoff",
  "free_kick",
  "penalty",
  "goal",
  "foul",
  "offside",
  "half_whistle",
]);

export interface BehaviourMetrics {
  /* --- A. 걷어내기 --- */
  clearances: number;
  throwIns: number;
  fouls: number;
  /* --- C. 비소유 정지 --- */
  /** 오픈플레이 틱에서 **비소유팀** 선수의 <0.3 m/tick 비율(%). hero ⓒ 의 직접 지표. */
  nonPossStillPct: number;
  /** 같은 정의의 소유팀 비율(%) — 비대칭의 반대편. */
  possStillPct: number;
  nonPossStepM: number;
  possStepM: number;
  /* --- C2. 데드볼 비대칭 --- */
  deadTakerStepM: number;
  deadOtherStepM: number;
  /** |taker − other| / max(taker, other). 0 = 대칭. */
  deadAsymmetry: number;
  /* --- B. 침투와 반응 --- */
  /** 패스 발사 틱에 **전방으로 1.5m 이상** 움직인 같은 팀 동료 수(패서 제외) 평균. */
  fwdRunnersAtPass: number;
  /** 그 러너들 중 가장 앞선 사람의 최근접 수비수 거리(m) 평균 — 작을수록 "보고 막는다". */
  runnerMarkDistM: number;
  /** 패스 발사 틱에 패서 본인이 전방으로 움직인 비율(%) — "차면 찰 때부터". */
  passerForwardPct: number;
  /** 표본 수(패스 발사 틱). */
  passLaunches: number;
}

interface Acc {
  n: number;
  sum: number;
}
const acc = (): Acc => ({ n: 0, sum: 0 });
const add = (a: Acc, v: number): void => {
  a.n++;
  a.sum += v;
};
const avg = (a: Acc): number => (a.n === 0 ? 0 : a.sum / a.n);

/**
 * 한 경기의 행동 지표. 팀·경기 단위(2팀 합을 2로 나눈 값)로 돌려준다.
 * `W` 는 피치 길이(m).
 */
export function measureBehaviour(log: MatchLog, W: number): BehaviourMetrics {
  const snaps = log.tickSnapshots;
  const byTick = new Map<number, TickSnapshot>();
  for (const s of snaps) byTick.set(s.tick, s);

  // --- 이벤트 카운트(팀·경기) ---
  let clearances = 0;
  let throwIns = 0;
  let fouls = 0;
  const shotTicks = new Set<number>();
  const dead = new Set<number>();
  const takerSideAt = new Map<number, TeamSide>();
  for (const e of log.events) {
    if (e.type === "clearance") clearances++;
    if (e.type === "foul") fouls++;
    if (e.type === "kickoff" && e.detail === "throw_in") throwIns++;
    if (e.type === "shot") shotTicks.add(e.tick);
    if (RESTART_EVENTS.has(e.type) || e.type === "kickoff") {
      for (let t = e.tick - 2; t <= e.tick + 16; t++) {
        dead.add(t);
        if (e.team) takerSideAt.set(t, e.team);
      }
    }
  }

  // --- 틱별 소유팀(오픈플레이) ---
  // ballOwner 가 null 인 비행/루즈볼 구간은 **마지막 소유팀**을 유지한다 — hero ⓒ 는 "공이
  // 레드에게 있는데 블루가 안 움직인다"이므로 비행 중도 같은 국면으로 봐야 한다.
  const possAt = new Map<number, TeamSide>();
  let last: TeamSide | null = null;
  for (const s of snaps) {
    if (s.ballOwner) last = sideOfId(s.ballOwner);
    if (last) possAt.set(s.tick, last);
  }

  // --- C: 오픈플레이 변위 ---
  const possStep = acc();
  const nonPossStep = acc();
  let possStill = 0;
  let possN = 0;
  let nonPossStill = 0;
  let nonPossN = 0;
  const deadTaker = acc();
  const deadOther = acc();

  for (let i = 1; i < snaps.length; i++) {
    const cur = snaps[i]!;
    const prev = snaps[i - 1]!;
    if (cur.tick !== prev.tick + 1) continue;
    const prevPos = new Map(prev.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
    const inDead = dead.has(cur.tick);
    const poss = possAt.get(cur.tick);
    const taker = takerSideAt.get(cur.tick);
    for (const p of cur.players) {
      const q = prevPos.get(`${p.team}:${p.playerId}`);
      if (!q) continue;
      const d = dist(p.pos.x, p.pos.y, q.x, q.y);
      // 12m 초과 = 세트피스 순간 재배치(킥오프 리셋 등) — 변위가 아니다.
      if (d > 12) continue;
      if (inDead) {
        if (!taker) continue;
        if (p.team === taker) add(deadTaker, d);
        else add(deadOther, d);
        continue;
      }
      if (!poss) continue;
      if (p.team === poss) {
        add(possStep, d);
        possN++;
        if (d < 0.3) possStill++;
      } else {
        add(nonPossStep, d);
        nonPossN++;
        if (d < 0.3) nonPossStill++;
      }
    }
  }

  // --- B: 패스 발사 틱 ---
  // 소유자 P(팀 S) 가 있던 틱 t 에서 t+1 에 소유가 사라지고 슛 이벤트가 없으면 = 패스 발사.
  const fwdRunners = acc();
  const runnerMark = acc();
  let passerFwd = 0;
  let passLaunches = 0;
  for (let i = 0; i + 1 < snaps.length; i++) {
    const cur = snaps[i]!;
    const nxt = snaps[i + 1]!;
    if (nxt.tick !== cur.tick + 1) continue;
    if (!cur.ballOwner || nxt.ballOwner) continue;
    if (shotTicks.has(cur.tick)) continue;
    if (dead.has(cur.tick)) continue;
    const passerId = cur.ballOwner;
    const side = sideOfId(passerId);
    const curPos = new Map(cur.players.map((p) => [`${p.team}:${p.playerId}`, p.pos]));
    passLaunches++;
    let runners = 0;
    let leadProg = -Infinity;
    let leadPos: { x: number; y: number } | null = null;
    for (const p of nxt.players) {
      const q = curPos.get(`${p.team}:${p.playerId}`);
      if (!q) continue;
      const step = dist(p.pos.x, p.pos.y, q.x, q.y);
      if (step > 12) continue;
      const gain = prog(p.team, p.pos.x, W) - prog(p.team, q.x, W);
      if (p.team !== side) continue;
      if (p.playerId === passerId) {
        if (gain > 0.5) passerFwd++;
        continue;
      }
      if (gain >= 1.5) {
        runners++;
        const pr = prog(p.team, p.pos.x, W);
        if (pr > leadProg) {
          leadProg = pr;
          leadPos = p.pos;
        }
      }
    }
    add(fwdRunners, runners);
    if (leadPos) {
      let best = Infinity;
      for (const p of nxt.players) {
        if (p.team === side) continue;
        const d = dist(p.pos.x, p.pos.y, leadPos.x, leadPos.y);
        if (d < best) best = d;
      }
      if (best < Infinity) add(runnerMark, best);
    }
  }

  return {
    clearances: clearances / 2,
    throwIns: throwIns / 2,
    fouls: fouls / 2,
    nonPossStillPct: nonPossN === 0 ? 0 : (nonPossStill / nonPossN) * 100,
    possStillPct: possN === 0 ? 0 : (possStill / possN) * 100,
    nonPossStepM: avg(nonPossStep),
    possStepM: avg(possStep),
    deadTakerStepM: avg(deadTaker),
    deadOtherStepM: avg(deadOther),
    deadAsymmetry:
      Math.max(avg(deadTaker), avg(deadOther)) === 0
        ? 0
        : Math.abs(avg(deadTaker) - avg(deadOther)) / Math.max(avg(deadTaker), avg(deadOther)),
    fwdRunnersAtPass: avg(fwdRunners),
    runnerMarkDistM: avg(runnerMark),
    passerForwardPct: passLaunches === 0 ? 0 : (passerFwd / passLaunches) * 100,
    passLaunches,
  };
}

/** 여러 경기 평균. */
export function aggregateBehaviour(list: BehaviourMetrics[]): BehaviourMetrics {
  const keys = Object.keys(list[0] ?? {}) as (keyof BehaviourMetrics)[];
  const out = {} as BehaviourMetrics;
  for (const k of keys) {
    out[k] = list.reduce((s, m) => s + m[k], 0) / Math.max(1, list.length);
  }
  return out;
}
