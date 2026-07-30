import type { MatchLog, TeamSide, TickSnapshot } from "@hmb/shared";
import type { EngineConfig } from "../config";
import type { SimState, SimPlayer } from "../simstate";
import { runMatch } from "../match";
import { makeTacticalInput, makeSelectData } from "../fixtures";
import { createPitch } from "../pitch";
import { toFixed, fromFixed } from "../fixedmath";
import { passOptions } from "../perception";
import { scoreOption } from "../decision";

/**
 * realism/deepen — **엔진 심화 개편(#279) W1 계량 진단** 전용 분석 유틸.
 *
 * hero 발제 4증상(단조로움 · 수비 이상 · 백패스 과다 · 스루패스/공간 부재)을 "체감"이 아니라
 * 로그에서 재구성한 수치로 확정한다. 기존 `harness.ts`(벤치 대조표)와 역할이 다르다 —
 * 저쪽은 **총량**(슛·골·패스성공률)이고 여기는 **구조**(패스가 어디로 가나 · 수비가 뭘 하나 ·
 * 장면이 반복되나 · 공간으로 찌르나)다. 총량이 전부 밴드 안인데 관전이 단조롭다는 것이
 * 이 에픽의 출발점이므로, 밴드 지표로는 안 보이는 축을 새로 만든다.
 *
 * ## 측정 원칙
 * 1) **로그에서 재구성**한다(엔진 동작 무변경). 스냅샷은 틱마다 전원 좌표 + ballOwner 를 담으므로
 *    소유 이전(=패스)·수비 배치·시퀀스를 사후에 복원할 수 있다.
 * 2) 의사결정 층(옵션이 애초에 몇 개나 생기나)은 **엔진의 함수를 그대로 호출**해 잰다
 *    (`passOptions`·`scoreOption`). 재구현하면 진단이 구현과 같은 실수를 공유한다.
 * 3) 다시드(≥20)만 쓴다 — 단일 시드 인상은 이 프로젝트가 반복해 밟은 함정이다.
 *
 * 이 파일은 순수 분석 유틸(프로덕션 index.ts 에 export 되지 않음).
 */

// ---------------------------------------------------------------------------
// 공통 헬퍼
// ---------------------------------------------------------------------------

/** 4-3-3 슬롯 순서(fixtures.ROLES 와 1:1). id 의 숫자 인덱스로 역할을 복원한다. */
const ROLE_BY_INDEX = ["GK", "LB", "LCB", "RCB", "RB", "LCM", "CM", "RCM", "LW", "ST", "RW"];
/** 역할 → 라인(진단 표기용). */
const LINE_BY_ROLE: Record<string, string> = {
  GK: "GK", LB: "DEF", LCB: "DEF", RCB: "DEF", RB: "DEF",
  LCM: "MID", CM: "MID", RCM: "MID", LW: "FWD", ST: "FWD", RW: "FWD",
};

function roleOf(playerId: string): string {
  const idx = Number(playerId.slice(1));
  return ROLE_BY_INDEX[idx] ?? "?";
}
function sideOfId(playerId: string): TeamSide {
  return playerId.startsWith("H") ? "home" : "away";
}
function otherSideOf(s: TeamSide): TeamSide {
  return s === "home" ? "away" : "home";
}

/** side 팀의 공격 방향 진행도(m). 0 = 자기 골라인, W = 상대 골라인. */
function prog(side: TeamSide, x: number, W: number): number {
  return side === "home" ? x : W - x;
}

function dist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return Math.sqrt(dx * dx + dy * dy);
}

/** 데드볼(재시작) 이벤트 타입 — 이 틱을 낀 소유 이전은 패스가 아니다. */
const RESTART_TYPES = new Set(["free_kick", "penalty", "goal", "offside", "foul", "half_whistle"]);
/** kickoff 이벤트의 detail(스로인/골킥/코너) 또는 detail 없음(킥오프). */
function isRestartEvent(type: string): boolean {
  return RESTART_TYPES.has(type) || type === "kickoff";
}

function mean(v: number[]): number {
  return v.length ? v.reduce((s, x) => s + x, 0) / v.length : 0;
}
function pct(n: number, d: number): number {
  return d > 0 ? (n / d) * 100 : 0;
}
function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * q)));
  return sorted[i]!;
}
/** 샤논 엔트로피(bit). */
function entropyBits(counts: number[]): number {
  const tot = counts.reduce((s, c) => s + c, 0);
  if (tot === 0) return 0;
  let h = 0;
  for (const c of counts) {
    if (c <= 0) continue;
    const p = c / tot;
    h -= p * Math.log2(p);
  }
  return h;
}

// ---------------------------------------------------------------------------
// 1. 소유 이전(=패스) 재구성
// ---------------------------------------------------------------------------

export interface Transfer {
  releaseTick: number;
  recvTick: number;
  fromId: string;
  fromSide: TeamSide;
  toId: string;
  toSide: TeamSide;
  /** 찬 지점 · 잡힌 지점(실좌표 m). */
  relX: number; relY: number; recvX: number; recvY: number;
  /** 찬 팀 공격 방향 전진량(m). 음수 = 백패스. */
  fwdM: number;
  distM: number;
  /** 찬 지점의 존(찬 팀 진행도 기준). */
  zone: "own" | "mid" | "final";
  completed: boolean;
  /** 리시버가 릴리스 시점 위치에서 잡힌 지점까지 이동한 거리(m) = "공을 향해 달려간 양". */
  runOntoM: number;
  /** 잡힌 지점이 상대 오프사이드 라인(릴리스 시점) 뒤인가 = 라인 브레이크. */
  inBehind: boolean;
  toRole: string;
  fromRole: string;
}

/** 스냅샷 t 에서 side 팀의 오프사이드 라인(자기 골 기준 2번째로 가까운 선수 진행도, m). */
function offsideLineProg(sn: TickSnapshot, side: TeamSide, W: number): number {
  const ps: number[] = [];
  for (const p of sn.players) {
    if (p.team !== side) continue;
    ps.push(prog(side, p.pos.x, W));
  }
  ps.sort((a, b) => a - b);
  return ps.length >= 2 ? ps[1]! : (ps[0] ?? 0);
}

/**
 * 소유 이전 재구성. `harness.reconstructPassLengths` 와 같은 원리(마지막 비-null 소유자를
 * 비행 너머로 기억 + 데드볼 재배치를 낀 이전 제외)지만, 방향·역할·라인브레이크까지 남긴다.
 */
export function reconstructTransfers(log: MatchLog, W: number): Transfer[] {
  const restartTicks = new Set<number>();
  for (const e of log.events) if (isRestartEvent(e.type)) restartTicks.add(e.tick);

  const byTick = new Map<number, TickSnapshot>();
  for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);

  const out: Transfer[] = [];
  let lastOwner: string | null = null;
  let relBall: { x: number; y: number } | null = null;
  let relTick = -1;
  let restartBetween = false;

  for (const sn of log.tickSnapshots) {
    if (restartTicks.has(sn.tick)) restartBetween = true;
    const o = sn.ballOwner;
    if (o == null) continue;
    if (lastOwner != null && o !== lastOwner && relBall && !restartBetween) {
      const fromSide = sideOfId(lastOwner);
      const toSide = sideOfId(o);
      const relSn = byTick.get(relTick)!;
      const recvPos = { x: sn.ball.x, y: sn.ball.y };
      // 리시버가 릴리스 시점에 어디 있었나(= 공을 향해 얼마나 달려왔나).
      const rp = relSn.players.find((p) => p.playerId === o && p.team === toSide);
      const runOnto = rp ? dist(rp.pos.x, rp.pos.y, recvPos.x, recvPos.y) : 0;
      const fwd = prog(fromSide, recvPos.x, W) - prog(fromSide, relBall.x, W);
      const relProg = prog(fromSide, relBall.x, W) / W;
      const line = offsideLineProg(relSn, otherSideOf(fromSide), W);
      // 상대 라인은 상대 골 기준 진행도 → 찬 팀 프레임으로 뒤집는다.
      const lineInAttackerFrame = W - line;
      out.push({
        releaseTick: relTick,
        recvTick: sn.tick,
        fromId: lastOwner,
        fromSide,
        toId: o,
        toSide,
        relX: relBall.x, relY: relBall.y,
        recvX: recvPos.x, recvY: recvPos.y,
        fwdM: fwd,
        distM: dist(relBall.x, relBall.y, recvPos.x, recvPos.y),
        zone: relProg < 1 / 3 ? "own" : relProg < 2 / 3 ? "mid" : "final",
        completed: toSide === fromSide,
        runOntoM: runOnto,
        inBehind: prog(fromSide, recvPos.x, W) > lineInAttackerFrame + 0.5,
        toRole: roleOf(o),
        fromRole: roleOf(lastOwner),
      });
    }
    lastOwner = o;
    relBall = { x: sn.ball.x, y: sn.ball.y };
    relTick = sn.tick;
    restartBetween = false;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 2. 소유 시퀀스(단조로움)
// ---------------------------------------------------------------------------

export interface Sequence {
  side: TeamSide;
  startTick: number;
  endTick: number;
  ticks: number;
  /** 데드볼 창을 뺀 인플레이 틱(= 실제 플레이 시간, 초). */
  inPlayTicks: number;
  passes: number;
  /** 시작 볼 위치 → 끝 볼 위치의 공격 방향 전진(m). */
  progressM: number;
  /** 시작 시점 볼의 자기 골로부터 거리(m). */
  startProgM: number;
  startCell: string;
  endCell: string;
  endType: "turnover" | "restart" | "shot" | "end";
}

/** 피치를 3(세로 존)×3(가로 채널)로 나눈 셀 라벨(공격 방향 프레임). */
function cellOf(side: TeamSide, x: number, y: number, W: number, H: number): string {
  const p = prog(side, x, W) / W;
  const z = p < 1 / 3 ? "D" : p < 2 / 3 ? "M" : "A";
  const yy = side === "home" ? y : H - y;
  const c = yy < H / 3 ? "L" : yy < (2 * H) / 3 ? "C" : "R";
  return z + c;
}

export function reconstructSequences(
  log: MatchLog,
  W: number,
  H: number,
  transfers: Transfer[],
  deadTicks: Set<number>,
): Sequence[] {
  const restartTicks = new Set<number>();
  const shotTicks = new Set<number>();
  for (const e of log.events) {
    if (isRestartEvent(e.type)) restartTicks.add(e.tick);
    if (e.type === "shot") shotTicks.add(e.tick);
  }
  const passByTick = new Map<number, number>();
  for (const t of transfers) passByTick.set(t.releaseTick, (passByTick.get(t.releaseTick) ?? 0) + 1);

  const seqs: Sequence[] = [];
  let cur: { side: TeamSide; startTick: number; startBall: { x: number; y: number } } | null = null;
  let lastBall = { x: 0, y: 0 };
  let lastTick = -1;
  let carrySide: TeamSide | null = null;

  const close = (endType: Sequence["endType"]): void => {
    if (!cur) return;
    const ticks = lastTick - cur.startTick + 1;
    let passes = 0;
    let inPlayTicks = 0;
    for (let t = cur.startTick; t <= lastTick; t++) {
      passes += passByTick.get(t) ?? 0;
      if (!deadTicks.has(t)) inPlayTicks++;
    }
    seqs.push({
      side: cur.side,
      startTick: cur.startTick,
      endTick: lastTick,
      ticks,
      inPlayTicks,
      passes,
      progressM: prog(cur.side, lastBall.x, W) - prog(cur.side, cur.startBall.x, W),
      startProgM: prog(cur.side, cur.startBall.x, W),
      startCell: cellOf(cur.side, cur.startBall.x, cur.startBall.y, W, H),
      endCell: cellOf(cur.side, lastBall.x, lastBall.y, W, H),
      endType,
    });
    cur = null;
  };

  for (const sn of log.tickSnapshots) {
    if (restartTicks.has(sn.tick)) {
      lastBall = { x: sn.ball.x, y: sn.ball.y };
      lastTick = sn.tick;
      close(shotTicks.has(sn.tick) ? "shot" : "restart");
      carrySide = null;
      continue;
    }
    const o = sn.ballOwner;
    const side: TeamSide | null = o ? sideOfId(o) : carrySide;
    if (side == null) continue;
    if (o) carrySide = side;
    if (cur && cur.side !== side) {
      close("turnover");
    }
    if (!cur) cur = { side, startTick: sn.tick, startBall: { x: sn.ball.x, y: sn.ball.y } };
    lastBall = { x: sn.ball.x, y: sn.ball.y };
    lastTick = sn.tick;
  }
  close("end");
  return seqs;
}

// ---------------------------------------------------------------------------
// 3. 수비 진단
// ---------------------------------------------------------------------------

export interface CrossCheck {
  /** 실제 이벤트 수(집계 정의 교차검증용). */
  passEvents: number;
  interceptionEvents: number;
  tackleEvents: number;
  foulEvents: number;
  shotEvents: number;
  /** 소유 이전 중 원인별 분류(이벤트와 매칭). */
  transferPass: number;
  transferIntercept: number;
  transferTackle: number;
  transferLoose: number;
  /** 슛 출발점: 골에서 거리 p50 · 중앙에서 횡offset p50/p90(m) · 횡offset SD. */
  shotDistP50: number;
  shotLatP50: number;
  shotLatP90: number;
  shotLatSd: number;
  /** 의도 기준 패스 방향(선택된 옵션의 forwardGain). 결과가 아니라 **결정**을 본다. */
  intentForwardPct: number;
  intentLateralPct: number;
  intentBackwardPct: number;
  intentMatched: number;
  /** 백4(**역할 고정** LB/LCB/RCB/RB) 평균 진행도(m) · 라인 내 산포(m) · 틱간 이동(m/tick). */
  backLineM: number;
  backLineSpreadM: number;
  backLineStepM: number;
  /** 인플레이 틱 비율(%) — 데드볼 창을 뺀 비율. 벤치 ~55–58분/90 = 61–64%. */
  inPlayPct: number;
  /** 파이널서드 볼 캐리어의 중앙(y) 편차 p50(m) — 작을수록 중앙으로 깔때기. */
  carrierLatFinalP50: number;
  /** 상대 진영 40% 이상에서 상대가 시도한 **완결/실패 패스 이벤트** 수(PPDA 분자, 정의 정합). */
  ppdaPassesHigh: number;
}

export interface DefenceMetrics {
  /** 공 소유 상대를 5m/10m 안에서 압박하는 수비수 수(인플레이 틱 평균). */
  pressWithin5: number;
  pressWithin10: number;
  /** 10m 안에 아무도 없는 틱 비율(%) = 무압박. */
  noPressurePct: number;
  /** 수비 시 오프사이드 라인 높이(자기 골에서 m) 평균/SD. */
  lineHeightM: number;
  lineHeightSd: number;
  /** 라인의 틱간 이동량(m/tick) 평균 — 라인이 유닛으로 오르내리는가. */
  lineStepM: number;
  /** 수비 라인 뒤(자기 골 쪽)에 있는 상대 공격수 평균 인원. */
  attackersBehindLine: number;
  /** 수비수 변위의 방향 분해(가중 평균, 합≈1 아님 — 각각 독립 투영). */
  towardBallFrac: number;
  towardOwnGoalFrac: number;
  /** PPDA (상대 공격 60% 구역 패스 / 우리 수비 액션). 벤치 PL ≈ 8-14. */
  ppda: number;
  /** 수비 액션(태클+인터셉트+파울) 총수. */
  defActions: number;
  /** 슛 허용 시 슈터 최근접 수비수 거리(m) 중앙값. */
  shooterNearestDefM: number;
}

// ---------------------------------------------------------------------------
// 4. 팀-경기 리포트
// ---------------------------------------------------------------------------

export interface TeamDeepen {
  side: TeamSide;
  // --- 패스 방향 ---
  passes: number;
  forwardPct: number;
  lateralPct: number;
  backwardPct: number;
  /** 백패스 중 GK 로 가는 비율(%). */
  backToGkPct: number;
  /** 존별 백패스율(%). */
  backPctOwn: number;
  backPctMid: number;
  backPctFinal: number;
  /** 전진 패스 평균 전진량(m). */
  fwdGainM: number;
  /** 프로그레시브 패스(≥10m 전진, 완결) 수. */
  progressive: number;
  /** 수신 역할 분포(%). */
  toDefPct: number;
  toMidPct: number;
  toFwdPct: number;
  toGkPct: number;
  // --- 공간/스루패스 ---
  /** 라인 브레이크(수비 라인 뒤에서 잡은) 완결 패스 수. */
  inBehindPasses: number;
  /** 공을 향해 달려가 잡은 거리 p50/p90(m). */
  runOntoP50: number;
  runOntoP90: number;
  /** 우리 공격 시, 상대 오프사이드 라인 뒤에 있는 우리 선수 평균 인원. */
  runnersBeyondLine: number;
  // --- 시퀀스(단조로움) ---
  sequences: number;
  seqTicks: number;
  /** 데드볼을 뺀 시퀀스 길이(초). Opta 오픈플레이 시퀀스 ~10–16s 와 직접 비교 가능. */
  seqInPlayS: number;
  seqPasses: number;
  seqProgressM: number;
  /** 시퀀스 시작 거리(자기 골에서 m). Opta 벤치 39.5–46.2m. */
  seqStartM: number;
  /** 다이렉트 스피드 = 시퀀스 전진(m) / 인플레이 시간(s). Opta 벤치 1.4–2.1 m/s. */
  directSpeedMs: number;
  /** 시퀀스 (시작셀→끝셀) 토큰 엔트로피(bit) 및 상위 5 토큰 점유율(%). */
  seqEntropyBits: number;
  seqTop5Pct: number;
  /** 슛 출발 셀 엔트로피(bit). */
  shotCellEntropyBits: number;
  // --- 수비 ---
  def: DefenceMetrics;
  // --- 의사결정(옵션 생성) ---
  /** 패스 시점 평균 후보 수 / 그중 전진(+2m 초과) 후보 수. */
  optAll: number;
  optForward: number;
  optBackward: number;
  /** 전진 후보가 0개인 패스 시점 비율(%) = "전진 각이 안 나온다". */
  noForwardOptPct: number;
  /** 엔진 점수 argmax 가 후진 옵션인 시점 비율(%) = "구조적으로 뒤가 이긴다". */
  argmaxBackwardPct: number;
  /** 전진 옵션의 평균 점수 − 후진 옵션의 평균 점수(엔진 scoreOption). 음수 = 뒤가 유리. */
  scoreFwdMinusBack: number;
  /** 교차검증(정의 아티팩트 방지). */
  xc: CrossCheck;
  /** 전술 출현 빈도(#279 W3 — "다양한 전술이 안 나온다"를 숫자로). */
  tac: TacticPresence;
}

/**
 * 전술 출현 빈도 — hero 체감("크로스·롱패스 등 다양한 전략이 안 나온다")을 계량한다.
 * 전부 **완결 패스(소유 이전)에서 기하로 판정**하므로 엔진에 아무 표식이 없어도 센다.
 * 오픈플레이만 본다(데드볼 재시작을 낀 이전은 재구성 단계에서 이미 제외됨).
 */
export interface TacticPresence {
  /** 크로스: 파이널서드 **와이드 채널**(박스 반폭 밖)에서 상대 박스 안으로 들어간 패스. 벤치 팀당 15–20. */
  crosses: number;
  /** 그중 **컷백**(골라인 근처에서 뒤로 빼 박스 안). 실제 축구의 대표 찬스 루트. */
  cutbacks: number;
  /** 사이드 전환: 한 번에 좌우로 ≥25m 이동한 패스. 벤치 팀당 ~10–20. */
  switches: number;
  /** 박스 안에서 잡은 완결 패스(=박스 진입 성공). */
  boxReceptions: number;
  /** 역습: 자기 진영 턴오버 후 ≤12초 안에 나온 슛. */
  counterShots: number;
  /** 와이드 채널에서 공을 잡은 횟수(측면 활용도). */
  wideReceptions: number;
}

/** 옵션 프로브용 그림자 SimState(위치만 스냅샷에서 갈아끼운다). */
interface Shadow {
  state: SimState;
  byId: Map<string, SimPlayer>;
}

function buildShadow(config: EngineConfig): Shadow {
  const select = makeSelectData();
  const pitchW = config.pitch.width;
  const scale = config.fixedScale;
  const players: SimPlayer[] = [];
  const byId = new Map<string, SimPlayer>();
  for (const side of ["home", "away"] as TeamSide[]) {
    const input = makeTacticalInput(side === "home" ? "H" : "A", "0");
    const roster = side === "home" ? select.home : select.away;
    for (const pi of input.players) {
      const card = roster.players.find((c) => c.playerId === pi.playerId)!;
      const p = {
        id: pi.playerId,
        side,
        role: pi.role,
        duty: pi.duty,
        behavior: pi.behavior,
        markTarget: undefined,
        mentalModifier: 0,
        attrs: card.attributes,
        baseFx: { x: 0, y: 0 },
        posFx: { x: 0, y: 0 },
        targetFx: { x: 0, y: 0 },
        fatigue: 0,
        isGK: pi.role === "GK",
        idHash: 0,
        dribbleStreak: 0,
        yellowCards: 0,
        seen: {},
      } as unknown as SimPlayer;
      players.push(p);
      byId.set(`${side}:${pi.playerId}`, p);
    }
  }
  void pitchW; void scale;
  const state = {
    players,
    byId: new Map(),
    ball: { posFx: { x: 0, y: 0 }, owner: null, ownerSide: null, flight: null },
    score: { home: 0, away: 0 },
    possession: "home",
    tick: 0,
    seedHash: 0,
    teams: { home: null, away: null },
    stoppage: 0,
    setPiece: null,
  } as unknown as SimState;
  return { state, byId };
}

/** 스냅샷 좌표를 그림자 상태에 반영. */
function loadShadow(sh: Shadow, sn: TickSnapshot, scale: number): void {
  for (const ps of sn.players) {
    const p = sh.byId.get(`${ps.team}:${ps.playerId}`);
    if (!p) continue;
    p.posFx.x = toFixed(ps.pos.x, scale);
    p.posFx.y = toFixed(ps.pos.y, scale);
    // 리드패스 조준에 쓰이는 targetFx 는 로그에 없다 — 옵션 생성·점수엔 쓰이지 않으므로 현재 위치로 둔다.
    p.targetFx.x = p.posFx.x;
    p.targetFx.y = p.posFx.y;
  }
}

/** 한 경기 분석 → 팀별 리포트. */
export function analyzeMatch(log: MatchLog, config: EngineConfig): Record<TeamSide, TeamDeepen> {
  const W = config.pitch.width;
  const H = config.pitch.height;
  const scale = config.fixedScale;
  const pitch = createPitch(config);
  const transfers = reconstructTransfers(log, W);
  // 데드볼 창(재시작 전후) — 인플레이 측정에서 제외.
  const deadTicks = new Set<number>();
  for (const e of log.events) {
    if (!isRestartEvent(e.type)) continue;
    for (let t = e.tick - 2; t <= e.tick + 14; t++) deadTicks.add(t);
  }
  const sequences = reconstructSequences(log, W, H, transfers, deadTicks);
  const byTick = new Map<number, TickSnapshot>();
  for (const sn of log.tickSnapshots) byTick.set(sn.tick, sn);

  const shadow = buildShadow(config);
  const FWD = 2; // 전진/후진 판정 임계(m)

  const out = {} as Record<TeamSide, TeamDeepen>;

  for (const side of ["home", "away"] as TeamSide[]) {
    const opp = otherSideOf(side);
    const mine = transfers.filter((t) => t.fromSide === side);
    const fwd = mine.filter((t) => t.fwdM > FWD);
    const back = mine.filter((t) => t.fwdM < -FWD);
    const lat = mine.length - fwd.length - back.length;
    const zoneBack = (z: Transfer["zone"]): number => {
      const inZone = mine.filter((t) => t.zone === z);
      return pct(inZone.filter((t) => t.fwdM < -FWD).length, inZone.length);
    };
    const completed = mine.filter((t) => t.completed);
    const runOnto = completed.map((t) => t.runOntoM).sort((a, b) => a - b);

    // --- 시퀀스 ---
    const seqs = sequences.filter((s) => s.side === side);
    const tokenCounts = new Map<string, number>();
    for (const s of seqs) {
      const k = `${s.startCell}>${s.endCell}`;
      tokenCounts.set(k, (tokenCounts.get(k) ?? 0) + 1);
    }
    const tokens = [...tokenCounts.values()].sort((a, b) => b - a);
    const top5 = tokens.slice(0, 5).reduce((s, c) => s + c, 0);

    // 슛 출발 셀
    const shotCells = new Map<string, number>();
    for (const e of log.events) {
      if (e.type !== "shot" || e.team !== side) continue;
      if (e.detail === "saved" || e.detail === "off_target") continue;
      const sn = byTick.get(e.tick);
      if (!sn) continue;
      const c = cellOf(side, sn.ball.x, sn.ball.y, W, H);
      shotCells.set(c, (shotCells.get(c) ?? 0) + 1);
    }

    // --- 수비(우리가 수비할 때 = 상대가 소유) ---
    let press5 = 0, press10 = 0, pressTicks = 0, noPress = 0;
    let lineSum = 0, lineSq = 0, lineN = 0, lineStep = 0, lineStepN = 0, prevLine = NaN, prevLineTick = -99;
    let behindSum = 0, behindN = 0;
    let runnersSum = 0, runnersN = 0;
    let towardBall = 0, towardGoal = 0, moveSum = 0;

    let prevSn: TickSnapshot | null = null;
    for (const sn of log.tickSnapshots) {
      const o = sn.ballOwner;
      const inPlay = !deadTicks.has(sn.tick);
      if (o && sideOfId(o) === opp && inPlay) {
        // 우리가 수비 중.
        let c5 = 0, c10 = 0;
        for (const p of sn.players) {
          if (p.team !== side) continue;
          if (roleOf(p.playerId) === "GK") continue;
          const d = dist(p.pos.x, p.pos.y, sn.ball.x, sn.ball.y);
          if (d <= 5) c5++;
          if (d <= 10) c10++;
        }
        press5 += c5; press10 += c10; pressTicks++;
        if (c10 === 0) noPress++;

        const line = offsideLineProg(sn, side, W);
        lineSum += line; lineSq += line * line; lineN++;
        // ⚠️ 인접 틱끼리만 뺀다. 우리가 공격하는 틱을 건너뛴 뒤 빼면 여러 초의 변위가 1틱 이동으로
        // 집계돼 라인 이동량이 통째로 부풀려진다(초판이 이 함정에 걸려 4.06 m/tick 이 나왔다).
        if (!Number.isNaN(prevLine) && prevLineTick === sn.tick - 1) {
          lineStep += Math.abs(line - prevLine); lineStepN++;
        }
        prevLine = line;
        prevLineTick = sn.tick;

        // 우리 라인 뒤(자기 골 쪽)에 있는 상대 공격수 = 라인 브레이크 상태.
        let behind = 0;
        for (const p of sn.players) {
          if (p.team !== opp) continue;
          if (roleOf(p.playerId) === "GK") continue;
          if (prog(side, p.pos.x, W) < line - 0.5) behind++;
        }
        behindSum += behind; behindN++;

        // 수비수 변위 분해.
        if (prevSn) {
          const prevById = new Map(prevSn.players.map((p) => [`${p.team}:${p.playerId}`, p]));
          for (const p of sn.players) {
            if (p.team !== side) continue;
            const pv = prevById.get(`${p.team}:${p.playerId}`);
            if (!pv) continue;
            const dx = p.pos.x - pv.pos.x;
            const dy = p.pos.y - pv.pos.y;
            const m = Math.sqrt(dx * dx + dy * dy);
            if (m < 0.25 || m > 12) continue;
            const bx = sn.ball.x - pv.pos.x, by = sn.ball.y - pv.pos.y;
            const bl = Math.max(1e-6, Math.sqrt(bx * bx + by * by));
            const gx = (side === "home" ? 0 : W) - pv.pos.x, gy = H / 2 - pv.pos.y;
            const gl = Math.max(1e-6, Math.sqrt(gx * gx + gy * gy));
            towardBall += (dx * bx + dy * by) / bl;
            towardGoal += (dx * gx + dy * gy) / gl;
            moveSum += m;
          }
        }
      } else if (o && sideOfId(o) === side && inPlay) {
        // 우리가 공격 중 — 상대 라인 뒤에 있는 우리 선수(침투 러너).
        const oppLine = offsideLineProg(sn, opp, W);
        let runners = 0;
        for (const p of sn.players) {
          if (p.team !== side) continue;
          if (roleOf(p.playerId) === "GK") continue;
          if (prog(opp, p.pos.x, W) < oppLine - 0.5) runners++;
        }
        runnersSum += runners; runnersN++;
      }
      prevSn = sn;
    }

    // PPDA 분모: 우리 수비 액션(태클·인터셉트·파울). 분자(ppdaHigh)는 아래 교차검증 블록에서
    // **패스 이벤트 정의**로 센다(소유이전 전수를 쓰면 루즈볼/태클까지 "패스"로 세어 분자가 부푼다).
    let defActions = 0;
    for (const e of log.events) {
      if (e.team !== side) continue;
      if (e.type === "tackle" || e.type === "interception" || e.type === "foul") defActions++;
    }

    // 슛 허용 시 슈터 최근접 수비 거리.
    const shooterNear: number[] = [];
    for (const e of log.events) {
      if (e.type !== "shot" || e.team !== opp) continue;
      if (e.detail === "saved" || e.detail === "off_target") continue;
      const sn = byTick.get(e.tick);
      if (!sn) continue;
      let best = Infinity;
      for (const p of sn.players) {
        if (p.team !== side) continue;
        if (roleOf(p.playerId) === "GK") continue;
        best = Math.min(best, dist(p.pos.x, p.pos.y, sn.ball.x, sn.ball.y));
      }
      if (Number.isFinite(best)) shooterNear.push(best);
    }
    shooterNear.sort((a, b) => a - b);

    // 도착 틱 이벤트 색인(원인 분류·프로브 필터에 공용).
    const evAt = new Map<number, { type: string; team?: TeamSide }[]>();
    for (const e of log.events) {
      const arr = evAt.get(e.tick) ?? [];
      arr.push({ type: e.type, team: e.team });
      evAt.set(e.tick, arr);
    }
    /** 이 소유 이전이 **패스 시도**인가(완결 pass 또는 상대 interception). 태클·루즈볼은 제외. */
    const isPassAttempt = (t: Transfer): boolean => {
      const evs = evAt.get(t.recvTick) ?? [];
      return (
        evs.some((e) => e.type === "pass" && e.team === t.fromSide) ||
        evs.some((e) => e.type === "interception" && e.team === t.toSide)
      );
    };

    // --- 의사결정 옵션 프로브(엔진 함수 그대로) ---
    // ⚠️ **패스 시도 시점만** 본다. 태클로 뺏긴 틱까지 넣으면 "그때 전진 옵션이 없었다"가 섞여
    //    "전진 각이 안 난다" 지표가 압박당한 순간 쪽으로 편향된다(선택하지 않은 결정을 세는 셈).
    let optAll = 0, optFwd = 0, optBack = 0, probes = 0, noFwd = 0, argmaxBack = 0;
    let fwdScoreSum = 0, fwdScoreN = 0, backScoreSum = 0, backScoreN = 0;
    // 의도(선택된 옵션의 forwardGain) — 결과(공 변위)가 아니라 **결정**을 본다.
    let intentF = 0, intentL = 0, intentB = 0;
    for (const t of mine) {
      if (!isPassAttempt(t)) continue;
      const sn = byTick.get(t.releaseTick);
      if (!sn) continue;
      loadShadow(shadow, sn, scale);
      const owner = shadow.byId.get(`${side}:${t.fromId}`);
      if (!owner) continue;
      const opts = passOptions(shadow.state, owner, config, pitch);
      if (!opts.length) continue;
      probes++;
      const ownerProg = prog(side, fromFixed(owner.posFx.x, scale), W) / W;
      const inFinal = ownerProg >= config.setPiece.finalThirdLine;
      let f = 0, b = 0;
      let bestScore = -Infinity, bestFwd = 0;
      for (const o of opts) {
        const gainM = fromFixed(o.forwardGain, scale);
        if (gainM > FWD) f++;
        else if (gainM < -FWD) b++;
        const s = scoreOption(o, owner, config, inFinal);
        if (gainM > FWD) { fwdScoreSum += s; fwdScoreN++; }
        else if (gainM < -FWD) { backScoreSum += s; backScoreN++; }
        if (s > bestScore) { bestScore = s; bestFwd = gainM; }
      }
      optAll += opts.length; optFwd += f; optBack += b;
      if (f === 0) noFwd++;
      if (bestFwd < -FWD) argmaxBack++;
      // 완결 패스만 의도 복원 가능(실패 패스는 도착점이 상대 쪽으로 유도되므로 리시버를 못 찾는다).
      if (t.completed) {
        const chosen = opts.find((o) => o.receiver.id === t.toId && o.receiver.side === side);
        if (chosen) {
          const g = fromFixed(chosen.forwardGain, scale);
          if (g > FWD) intentF++;
          else if (g < -FWD) intentB++;
          else intentL++;
        }
      }
    }

    // --- 교차검증: 이벤트 수 · 소유이전 원인 · 슛 기하 · 백4 라인 ---
    let passEvents = 0, interceptionEvents = 0, tackleEvents = 0, foulEvents = 0, shotEvents = 0;
    const shotDist: number[] = [], shotLat: number[] = [];
    for (const e of log.events) {
      if (e.type === "pass" && e.team === side) passEvents++;
      if (e.type === "interception" && e.team === side) interceptionEvents++;
      if (e.type === "tackle" && e.team === side) tackleEvents++;
      if (e.type === "foul" && e.team === side) foulEvents++;
      if (e.type === "shot" && e.team === side && e.detail !== "saved" && e.detail !== "off_target") {
        shotEvents++;
        const sn = byTick.get(e.tick);
        if (sn) {
          shotDist.push(W - prog(side, sn.ball.x, W));
          shotLat.push(Math.abs(sn.ball.y - H / 2));
        }
      }
    }
    shotDist.sort((a, b) => a - b);
    const shotLatSorted = [...shotLat].sort((a, b) => a - b);
    const latMu = mean(shotLat);

    // 소유 이전 원인 분류(도착 틱 이벤트와 매칭 — evAt 은 위에서 만든 색인 재사용).
    let tPass = 0, tInt = 0, tTackle = 0, tLoose = 0;
    for (const t of mine) {
      const evs = evAt.get(t.recvTick) ?? [];
      if (evs.some((e) => e.type === "pass" && e.team === t.fromSide)) tPass++;
      else if (evs.some((e) => e.type === "interception" && e.team === t.toSide)) tInt++;
      else if (evs.some((e) => e.type === "tackle" && e.team === t.toSide)) tTackle++;
      else tLoose++;
    }

    // 백4 라인 — **역할 고정**(LB/LCB/RCB/RB)으로 잡는다. 순서통계("가장 깊은 4명")로 잡으면
    // 구성원이 틱마다 바뀌어 라인 이동량이 부풀려진다(측정 아티팩트).
    let blSum = 0, blN = 0, blSpread = 0, blStep = 0, blStepN = 0, blPrev = NaN, blPrevTick = -99;
    let inPlay = 0, allTicks = 0;
    const carrierLat: number[] = [];
    for (const sn of log.tickSnapshots) {
      allTicks++;
      if (!deadTicks.has(sn.tick)) inPlay++;
      const o = sn.ballOwner;
      if (o && sideOfId(o) === side && !deadTicks.has(sn.tick)) {
        if (prog(side, sn.ball.x, W) / W >= config.setPiece.finalThirdLine) {
          carrierLat.push(Math.abs(sn.ball.y - H / 2));
        }
      }
      if (!o || sideOfId(o) !== opp || deadTicks.has(sn.tick)) continue;
      const back: number[] = [];
      for (const p of sn.players) {
        if (p.team !== side) continue;
        if (LINE_BY_ROLE[roleOf(p.playerId)] !== "DEF") continue;
        back.push(prog(side, p.pos.x, W));
      }
      if (back.length < 4) continue;
      back.sort((a, b) => a - b);
      const mu = mean(back);
      blSum += mu; blN++;
      blSpread += back[back.length - 1]! - back[0]!;
      // 인접 틱끼리만(위 lineStep 과 동일 사유).
      if (!Number.isNaN(blPrev) && blPrevTick === sn.tick - 1) { blStep += Math.abs(mu - blPrev); blStepN++; }
      blPrev = mu;
      blPrevTick = sn.tick;
    }
    carrierLat.sort((a, b) => a - b);
    // PPDA 분자를 이벤트 정의로 재계산(소유이전 전수가 아니라 실제 패스 시도).
    let ppdaHigh = 0;
    for (const t of transfers) {
      if (t.fromSide !== opp) continue;
      const evs = evAt.get(t.recvTick) ?? [];
      const isPassAttempt =
        evs.some((e) => e.type === "pass" && e.team === opp) ||
        evs.some((e) => e.type === "interception" && e.team === side);
      if (!isPassAttempt) continue;
      if (prog(opp, t.relX, W) / W >= 0.4) ppdaHigh++;
    }

    // --- 전술 출현 빈도(기하 판정) ---
    const boxHalfW = config.rules.penalty.boxHalfWidthM;
    const boxDepth = config.rules.penalty.boxDepthM;
    const inOppBox = (t: Transfer, x: number, y: number): boolean =>
      prog(t.fromSide, x, W) >= W - boxDepth && Math.abs(y - H / 2) <= boxHalfW;
    let crosses = 0, cutbacks = 0, switches = 0, boxRec = 0, wideRec = 0;
    for (const t of mine) {
      if (!t.completed) continue;
      const relWide = Math.abs(t.relY - H / 2) > boxHalfW;
      const relFinal = prog(t.fromSide, t.relX, W) / W >= config.setPiece.finalThirdLine;
      const recvBox = inOppBox(t, t.recvX, t.recvY);
      if (relFinal && relWide && recvBox) {
        crosses++;
        // 컷백 = 골라인 가까이서 **뒤로** 빼 박스로.
        if (prog(t.fromSide, t.relX, W) >= W - boxDepth * 0.6 && t.fwdM < 0) cutbacks++;
      }
      if (Math.abs(t.recvY - t.relY) >= 25) switches++;
      if (recvBox) boxRec++;
      if (Math.abs(t.recvY - H / 2) > boxHalfW) wideRec++;
    }
    // 역습: 자기 진영에서 공을 딴 뒤 12틱 안에 나온 슛.
    const winsInOwnHalf: number[] = [];
    for (const t of transfers) {
      if (t.toSide !== side || t.completed) continue; // 상대 패스를 우리가 가로챈 순간
      if (prog(side, t.recvX, W) / W < 0.5) winsInOwnHalf.push(t.recvTick);
    }
    let counterShots = 0;
    for (const e of log.events) {
      if (e.type !== "shot" || e.team !== side) continue;
      if (e.detail === "saved" || e.detail === "off_target") continue;
      if (winsInOwnHalf.some((w) => e.tick - w >= 0 && e.tick - w <= 12)) counterShots++;
    }
    const tac: TacticPresence = {
      crosses, cutbacks, switches, boxReceptions: boxRec, counterShots, wideReceptions: wideRec,
    };

    const xc: CrossCheck = {
      passEvents, interceptionEvents, tackleEvents, foulEvents, shotEvents,
      transferPass: tPass, transferIntercept: tInt, transferTackle: tTackle, transferLoose: tLoose,
      shotDistP50: quantile(shotDist, 0.5),
      shotLatP50: quantile(shotLatSorted, 0.5),
      shotLatP90: quantile(shotLatSorted, 0.9),
      shotLatSd: Math.sqrt(mean(shotLat.map((v) => (v - latMu) ** 2))),
      intentForwardPct: pct(intentF, intentF + intentL + intentB),
      intentLateralPct: pct(intentL, intentF + intentL + intentB),
      intentBackwardPct: pct(intentB, intentF + intentL + intentB),
      intentMatched: intentF + intentL + intentB,
      backLineM: blN ? blSum / blN : 0,
      backLineSpreadM: blN ? blSpread / blN : 0,
      backLineStepM: blStepN ? blStep / blStepN : 0,
      inPlayPct: pct(inPlay, allTicks),
      carrierLatFinalP50: quantile(carrierLat, 0.5),
      ppdaPassesHigh: ppdaHigh,
    };

    const def: DefenceMetrics = {
      pressWithin5: pressTicks ? press5 / pressTicks : 0,
      pressWithin10: pressTicks ? press10 / pressTicks : 0,
      noPressurePct: pct(noPress, pressTicks),
      lineHeightM: lineN ? lineSum / lineN : 0,
      lineHeightSd: lineN ? Math.sqrt(Math.max(0, lineSq / lineN - (lineSum / lineN) ** 2)) : 0,
      lineStepM: lineStepN ? lineStep / lineStepN : 0,
      attackersBehindLine: behindN ? behindSum / behindN : 0,
      towardBallFrac: moveSum ? towardBall / moveSum : 0,
      towardOwnGoalFrac: moveSum ? towardGoal / moveSum : 0,
      ppda: defActions > 0 ? ppdaHigh / defActions : 0,
      defActions,
      shooterNearestDefM: quantile(shooterNear, 0.5),
    };

    out[side] = {
      side,
      passes: mine.length,
      forwardPct: pct(fwd.length, mine.length),
      lateralPct: pct(lat, mine.length),
      backwardPct: pct(back.length, mine.length),
      backToGkPct: pct(back.filter((t) => t.toRole === "GK").length, back.length),
      backPctOwn: zoneBack("own"),
      backPctMid: zoneBack("mid"),
      backPctFinal: zoneBack("final"),
      fwdGainM: mean(fwd.map((t) => t.fwdM)),
      progressive: completed.filter((t) => t.fwdM >= 10).length,
      toDefPct: pct(completed.filter((t) => LINE_BY_ROLE[t.toRole] === "DEF").length, completed.length),
      toMidPct: pct(completed.filter((t) => LINE_BY_ROLE[t.toRole] === "MID").length, completed.length),
      toFwdPct: pct(completed.filter((t) => LINE_BY_ROLE[t.toRole] === "FWD").length, completed.length),
      toGkPct: pct(completed.filter((t) => t.toRole === "GK").length, completed.length),
      inBehindPasses: completed.filter((t) => t.inBehind).length,
      runOntoP50: quantile(runOnto, 0.5),
      runOntoP90: quantile(runOnto, 0.9),
      runnersBeyondLine: runnersN ? runnersSum / runnersN : 0,
      sequences: seqs.length,
      seqTicks: mean(seqs.map((s) => s.ticks)),
      seqInPlayS: mean(seqs.map((s) => s.inPlayTicks)),
      seqPasses: mean(seqs.map((s) => s.passes)),
      seqProgressM: mean(seqs.map((s) => s.progressM)),
      seqStartM: mean(seqs.map((s) => s.startProgM)),
      // Opta 정의와 맞추려 **시퀀스별로** 전진/시간을 낸 뒤 평균한다(합계비율이 아니라).
      directSpeedMs: mean(seqs.filter((s) => s.inPlayTicks > 0).map((s) => s.progressM / s.inPlayTicks)),
      seqEntropyBits: entropyBits(tokens),
      seqTop5Pct: pct(top5, seqs.length),
      shotCellEntropyBits: entropyBits([...shotCells.values()]),
      def,
      optAll: probes ? optAll / probes : 0,
      optForward: probes ? optFwd / probes : 0,
      optBackward: probes ? optBack / probes : 0,
      noForwardOptPct: pct(noFwd, probes),
      argmaxBackwardPct: pct(argmaxBack, probes),
      scoreFwdMinusBack: (fwdScoreN ? fwdScoreSum / fwdScoreN : 0) - (backScoreN ? backScoreSum / backScoreN : 0),
      xc,
      tac,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// 5. 다시드 집계
// ---------------------------------------------------------------------------

export interface DeepenAgg {
  seeds: number;
  teamMatches: number;
  mean: TeamDeepen;
  sd: TeamDeepen;
  lastHash: string;
}

function aggregate(rows: TeamDeepen[]): { mean: TeamDeepen; sd: TeamDeepen } {
  const m = {} as Record<string, unknown>;
  const s = {} as Record<string, unknown>;
  const first = rows[0]!;
  for (const k of Object.keys(first) as (keyof TeamDeepen)[]) {
    const v0 = first[k];
    if (typeof v0 === "number") {
      const vals = rows.map((r) => r[k] as number);
      const mu = mean(vals);
      m[k] = Math.round(mu * 1000) / 1000;
      s[k] = Math.round(Math.sqrt(mean(vals.map((v) => (v - mu) ** 2))) * 1000) / 1000;
    } else if (k === "def" || k === "xc" || k === "tac") {
      const src = first[k] as unknown as Record<string, number>;
      const dm = {} as Record<string, number>;
      const ds = {} as Record<string, number>;
      for (const dk of Object.keys(src)) {
        const vals = rows.map((r) => (r[k] as unknown as Record<string, number>)[dk]!);
        const mu = mean(vals);
        dm[dk] = Math.round(mu * 1000) / 1000;
        ds[dk] = Math.round(Math.sqrt(mean(vals.map((v) => (v - mu) ** 2))) * 1000) / 1000;
      }
      m[k] = dm; s[k] = ds;
    } else {
      m[k] = v0; s[k] = v0;
    }
  }
  return { mean: m as unknown as TeamDeepen, sd: s as unknown as TeamDeepen };
}

/** 리얼 config 다시드 심화 진단. */
export function aggregateDeepen(config: EngineConfig, seeds: string[]): DeepenAgg {
  const select = makeSelectData();
  const rows: TeamDeepen[] = [];
  let lastHash = "";
  for (const seed of seeds) {
    const log = runMatch(seed, makeTacticalInput("H", seed), makeTacticalInput("A", seed), select, config);
    const r = analyzeMatch(log, config);
    rows.push(r.home, r.away);
    lastHash = log.tickSnapshots[log.tickSnapshots.length - 1]?.hash ?? lastHash;
  }
  const { mean: mu, sd: s } = aggregate(rows);
  return { seeds: seeds.length, teamMatches: rows.length, mean: mu, sd: s, lastHash };
}
