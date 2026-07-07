import type {
  TacticalInput,
  SelectData,
  MatchLog,
  TickSnapshot,
  MatchEvent,
  TeamSide,
  TeamRoster,
  PlayerCard,
  PlayerAttributes,
} from "@hmb/shared";
import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import { defaultEngineConfig } from "./config";
import { createRng } from "./rng";
import { createPitch, slotToReal, clampToPitch } from "./pitch";
import { toFixed, fromFixed, stepToward } from "./fixedmath";
import { glueBallToOwner, advanceBall } from "./ball";
import { decideBallOwner, decideOffBall, assignPresser } from "./decision";
import {
  tryIntercept,
  tryTackle,
  resolveArrival,
  resolveShot,
  resetKickoff,
  restartThrowIn,
  restartGoalKick,
  restartCorner,
} from "./contest";
import type { OutCross } from "./ball";
import { hashState } from "./hash";

/**
 * match — 결정론 매치 엔진의 핵심 API.
 *  - runMatch: 통짜 90분.
 *  - runFirstHalf / resumeSecondHalf: 하프타임 델타 주입 후 전반 종료 상태(좌표·속도·스코어·RNG)를
 *    이어받아 후반 재개. delta 를 전반과 동일 입력으로 주면 통짜 90분과 완전히 동일하다.
 *
 * 매 틱: perceive → decide → act → resolveContests → applyFatigue → emit.
 */

const DEFAULT_ATTRS: PlayerAttributes = {
  technical: 50,
  mental: 50,
  physical: 50,
  passing: 50,
  shooting: 50,
  tackling: 50,
  pace: 50,
  stamina: 50,
  positioning: 50,
};

function isGoalkeeper(role: string, position: string): boolean {
  return /gk|goalkeep|골키퍼/i.test(role) || /gk|goalkeep|골키퍼/i.test(position);
}

function findCard(roster: TeamRoster, playerId: string): PlayerCard | undefined {
  return roster.players.find((p) => p.playerId === playerId);
}

/** TacticalInput + roster → SimPlayer[]. */
function buildPlayers(
  input: TacticalInput,
  roster: TeamRoster,
  side: TeamSide,
  pitch: Pitch,
): SimPlayer[] {
  return input.players.map((pi) => {
    const card = findCard(roster, pi.playerId);
    const attrs = card ? card.attributes : DEFAULT_ATTRS;
    const base = slotToReal(pitch, pi.basePosition.x, pi.basePosition.y, side);
    const gk = isGoalkeeper(pi.role, card?.position ?? "");
    return {
      id: pi.playerId,
      side,
      role: pi.role,
      duty: pi.duty,
      behavior: pi.behavior,
      markTarget: pi.markTarget,
      mentalModifier: pi.mentalModifier,
      attrs,
      baseFx: { x: base.x, y: base.y },
      posFx: { x: base.x, y: base.y },
      targetFx: { x: base.x, y: base.y },
      fatigue: 0,
      isGK: gk,
    } satisfies SimPlayer;
  });
}

/** 하프타임 델타 적용: 전술/행동/기본위치 갱신, 좌표·피로·RNG 는 유지. */
function applyDelta(
  state: SimState,
  input: TacticalInput,
  side: TeamSide,
  pitch: Pitch,
): void {
  state.teams[side] = input.team;
  for (const pi of input.players) {
    const p = state.byId.get(pi.playerId);
    if (!p) continue;
    p.role = pi.role;
    p.duty = pi.duty;
    p.behavior = pi.behavior;
    p.markTarget = pi.markTarget;
    p.mentalModifier = pi.mentalModifier;
    const base = slotToReal(pitch, pi.basePosition.x, pi.basePosition.y, side);
    p.baseFx = { x: base.x, y: base.y };
  }
}

/** 선수의 이번 틱 이동량(fixed). pace 와 피로 반영. */
function speedStep(p: SimPlayer, config: EngineConfig): number {
  const { minPerTick, maxPerTick, fatigueFloor } = config.speed;
  const paceFrac = p.attrs.pace / 100;
  const base = minPerTick + (maxPerTick - minPerTick) * paceFrac;
  const fatigueMult = 1 - (1 - fatigueFloor) * p.fatigue;
  return toFixed(base * fatigueMult, config.fixedScale);
}

interface Carry {
  state: SimState;
  rng: Rng;
  nextTick: number;
  snapshots: TickSnapshot[];
  events: MatchEvent[];
  seed: string;
  config: EngineConfig;
  pitch: Pitch;
}

/** 총 틱 수. */
function totalTicks(config: EngineConfig): number {
  return Math.round((config.matchMinutes * 60 * 1000) / config.msPerTick);
}

/** 틱 → 경기 분. */
function tickToMinute(tick: number, config: EngineConfig): number {
  return Math.floor((tick * config.msPerTick) / 60000);
}

/** 현재 상태로 TickSnapshot 생성(실좌표 + 해시). */
function snapshot(state: SimState, config: EngineConfig): TickSnapshot {
  const scale = config.fixedScale;
  const round2 = (v: number): number => Math.round(fromFixed(v, scale) * 100) / 100;
  return {
    tick: state.tick,
    minute: tickToMinute(state.tick, config),
    ball: { x: round2(state.ball.posFx.x), y: round2(state.ball.posFx.y) },
    ballOwner: state.ball.owner,
    players: state.players.map((p) => ({
      playerId: p.id,
      team: p.side,
      pos: { x: round2(p.posFx.x), y: round2(p.posFx.y) },
    })),
    hash: hashState(state),
  };
}

/**
 * 공이 경계를 넘었을 때(out) 세트피스 판정.
 *  - 사이드라인 → 스로인(찬 팀 상대).
 *  - 골라인: 공격팀이 냄 → 골킥(수비팀) / 수비팀이 냄 → 코너(공격팀).
 * 슛은 resolveShot 에서 처리되므로 여기 out 은 사실상 패스(fail_out)/루즈볼.
 */
function resolveOut(carry: Carry, out: OutCross, tick: number, minute: number): void {
  const { state, config, pitch } = carry;
  const f = state.ball.flight;
  const fromSide: TeamSide = f?.fromSide ?? state.possession;
  const opp: TeamSide = fromSide === "home" ? "away" : "home";
  state.ball.flight = null;

  if (out.edge === "top" || out.edge === "bottom") {
    // 사이드라인 아웃 → 스로인(상대 볼).
    carry.events.push(restartThrowIn(state, pitch, config, opp, out.x, out.y, tick, minute));
    return;
  }
  // 골라인 아웃. 홈은 오른쪽(right=wFx) 공격, 어웨이는 왼쪽(left=0) 공격.
  const homeAttackLine = out.edge === "right";
  const attackerOfLine: TeamSide = homeAttackLine ? "home" : "away";
  if (fromSide === attackerOfLine) {
    // 공격팀이 냄 → 골킥(수비팀).
    carry.events.push(restartGoalKick(state, pitch, config, opp, tick, minute));
  } else {
    // 수비팀이 냄(클리어 등) → 코너(공격팀).
    carry.events.push(restartCorner(state, pitch, config, fromSide, out.y, tick, minute));
  }
}

/** 한 틱 진행(perceive→decide→act→resolve→fatigue). 이벤트는 carry.events 로 push. */
function stepTick(carry: Carry): void {
  const { state, rng, config, pitch } = carry;
  const minute = tickToMinute(state.tick, config);

  // --- 세트피스 정지(dead ball): 재배치만 하고 결정/경합/공비행 스킵 ---
  if (state.stoppage > 0) {
    state.stoppage--;
    const heldId = state.ball.owner;
    for (const p of state.players) {
      if (p.id === heldId) continue;
      decideOffBall(state, p, config, pitch, null);
    }
    for (const p of state.players) {
      const step = speedStep(p, config);
      const next = stepToward(p.posFx.x, p.posFx.y, p.targetFx.x, p.targetFx.y, step);
      const c = clampToPitch(pitch, next.x, next.y);
      p.posFx.x = c.x;
      p.posFx.y = c.y;
    }
    if (heldId) {
      const o = state.byId.get(heldId);
      if (o) glueBallToOwner(state.ball, o.posFx.x, o.posFx.y);
    }
    if (state.stoppage === 0) state.setPiece = null;
    return;
  }

  // --- 압박 담당 지정(수비팀만) ---
  const defSide: TeamSide = state.possession === "home" ? "away" : "home";
  const presser = assignPresser(state, defSide);

  // --- decide: 오프더볼/수비 목표 ---
  const ownerId = state.ball.owner;
  for (const p of state.players) {
    if (p.id === ownerId) continue;
    const pa = p.side === defSide ? presser : null;
    decideOffBall(state, p, config, pitch, pa);
  }

  // --- decide: 볼 소유자 행동 ---
  if (ownerId && !state.ball.flight) {
    const owner = state.byId.get(ownerId);
    if (owner) {
      const action = decideBallOwner(state, owner, rng, config, pitch);
      switch (action.kind) {
        case "shoot": {
          state.ball.flight = {
            toX: action.toX,
            toY: action.toY,
            speed: toFixed(config.ball.shotSpeed, config.fixedScale),
            kind: "shot",
            target: owner.id,
            fromSide: owner.side,
            xg: action.xg,
          };
          state.ball.owner = null;
          state.ball.ownerSide = null;
          carry.events.push({
            tick: state.tick,
            minute,
            type: "shot",
            team: owner.side,
            playerId: owner.id,
            xg: action.xg,
          });
          owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
          break;
        }
        case "pass": {
          state.ball.flight = {
            toX: action.toX,
            toY: action.toY,
            speed: toFixed(config.ball.passSpeed, config.fixedScale),
            kind: "pass",
            target: action.receiver.id,
            fromSide: owner.side,
            passOutcome: action.outcome,
          };
          state.ball.owner = null;
          state.ball.ownerSide = null;
          owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
          break;
        }
        case "dribble": {
          owner.targetFx = { x: action.toX, y: action.toY };
          break;
        }
        case "hold": {
          owner.targetFx = { x: owner.posFx.x, y: owner.posFx.y };
          break;
        }
      }
    }
  }

  // --- act: 선수 이동 ---
  for (const p of state.players) {
    const step = speedStep(p, config);
    const next = stepToward(p.posFx.x, p.posFx.y, p.targetFx.x, p.targetFx.y, step);
    const c = clampToPitch(pitch, next.x, next.y);
    p.posFx.x = c.x;
    p.posFx.y = c.y;
  }

  // --- act: 공 이동 + 경합 ---
  const curOwnerId = state.ball.owner;
  if (state.ball.flight) {
    const res = advanceBall(state.ball, config, pitch);
    if (res.out) {
      resolveOut(carry, res.out, state.tick, minute);
    } else if (res.arrived) {
      if (state.ball.flight.kind === "shot") {
        for (const e of resolveShot(state, rng, config, pitch, state.tick, minute)) {
          carry.events.push(e);
        }
      } else {
        for (const e of resolveArrival(state, config, pitch, state.tick, minute)) {
          carry.events.push(e);
        }
      }
    } else {
      for (const e of tryIntercept(state, rng, config, state.tick, minute)) {
        carry.events.push(e);
      }
    }
  } else if (curOwnerId) {
    const owner = state.byId.get(curOwnerId);
    if (owner) glueBallToOwner(state.ball, owner.posFx.x, owner.posFx.y);
    for (const e of tryTackle(state, rng, config, state.tick, minute)) {
      carry.events.push(e);
    }
  }

  // --- applyFatigue ---
  for (const p of state.players) {
    const active = p.id === curOwnerId || (presser && p.id === presser.id);
    const exertion = p.isGK ? 0.3 : active ? 1.6 : 1.0;
    p.fatigue = Math.min(1, p.fatigue + config.fatiguePerTick * exertion);
  }
}

/** carry 의 nextTick 부터 endTick(미포함) 까지 시뮬레이션하며 스냅샷/이벤트 수집. */
function simulateRange(carry: Carry, endTick: number): void {
  const { state, config } = carry;
  for (let t = carry.nextTick; t < endTick; t++) {
    state.tick = t;
    stepTick(carry);
    carry.snapshots.push(snapshot(state, config));
  }
  carry.nextTick = endTick;
}

/** 초기 상태 구성 + 킥오프. */
function initCarry(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  select: SelectData,
  config: EngineConfig,
): Carry {
  const pitch = createPitch(config);
  const rng = createRng(seed);
  const homePlayers = buildPlayers(home, select.home, "home", pitch);
  const awayPlayers = buildPlayers(away, select.away, "away", pitch);
  const players = [...homePlayers, ...awayPlayers];
  const byId = new Map<string, SimPlayer>();
  for (const p of players) byId.set(p.id, p);

  const state: SimState = {
    players,
    byId,
    ball: { posFx: { x: 0, y: 0 }, owner: null, ownerSide: null, flight: null },
    score: { home: 0, away: 0 },
    possession: "home",
    tick: 0,
    teams: { home: home.team, away: away.team },
    stoppage: 0,
    setPiece: null,
  };

  const carry: Carry = {
    state,
    rng,
    nextTick: 0,
    snapshots: [],
    events: [],
    seed,
    config,
    pitch,
  };

  // 킥오프: 홈이 센터에서 시작(개시는 정지 없이 바로).
  resetKickoff(state, pitch, "home");
  state.setPiece = null;
  carry.events.push({ tick: 0, minute: 0, type: "kickoff", team: "home" });
  return carry;
}

/** carry → MatchLog. */
function toMatchLog(carry: Carry): MatchLog {
  return {
    configVersion: carry.config.version,
    seed: carry.seed,
    tickSnapshots: carry.snapshots,
    events: carry.events,
    finalScore: { home: carry.state.score.home, away: carry.state.score.away },
  };
}

/**
 * 통짜 90분 매치 실행. (핵심 API)
 */
export function runMatch(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  select: SelectData,
  config: EngineConfig = defaultEngineConfig,
): MatchLog {
  const carry = initCarry(seed, home, away, select, config);
  const total = totalTicks(config);
  const half = Math.floor(total / 2);

  simulateRange(carry, half);
  carry.events.push({
    tick: half,
    minute: tickToMinute(half, config),
    type: "half_whistle",
  });
  simulateRange(carry, total);
  carry.events.push({
    tick: total - 1,
    minute: config.matchMinutes,
    type: "full_whistle",
  });
  return toMatchLog(carry);
}

/** 재개용 carry state(엔진 내부 객체 그대로 관통). */
export type CarryState = Carry;

/**
 * 전반전만 실행하고 재개용 상태 반환. RNG·좌표·스코어·피로가 carry 안에 살아있다.
 */
export function runFirstHalf(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  select: SelectData,
  config: EngineConfig = defaultEngineConfig,
): CarryState {
  const carry = initCarry(seed, home, away, select, config);
  const half = Math.floor(totalTicks(config) / 2);
  simulateRange(carry, half);
  carry.events.push({
    tick: half,
    minute: tickToMinute(half, config),
    type: "half_whistle",
  });
  return carry;
}

/**
 * 하프타임 델타(후반 전술) 주입 후 후반 재개 → 완결 MatchLog.
 * delta 를 전반 입력과 동일하게 주면 runMatch(통짜)와 완전히 동일.
 */
export function resumeSecondHalf(
  carry: CarryState,
  deltaHome: TacticalInput,
  deltaAway: TacticalInput,
): MatchLog {
  const { state, config, pitch } = carry;
  applyDelta(state, deltaHome, "home", pitch);
  applyDelta(state, deltaAway, "away", pitch);
  const total = totalTicks(config);
  simulateRange(carry, total);
  carry.events.push({
    tick: total - 1,
    minute: config.matchMinutes,
    type: "full_whistle",
  });
  return toMatchLog(carry);
}
