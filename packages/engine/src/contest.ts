import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { MatchEvent, TeamSide } from "@hmb/shared";
import { fdist, fclamp } from "./fixedmath";
import { centerSpot, defendGoal, clampToPitch } from "./pitch";

/**
 * contest — 경합 판정(패스/인터셉트/태클/슛).
 * ESMS/xG 참고: 결과는 인자 Rng 의 시드 베르누이로만 결정한다.
 * 모든 함수는 state 를 변경하고 발생한 MatchEvent 를 반환한다.
 */

function attrFactor(v: number): number {
  return 0.6 + 0.8 * (v / 100);
}

/** 공을 player 에게 넘긴다(비행 종료·글루). */
function giveBallTo(state: SimState, player: SimPlayer): void {
  state.ball.owner = player.id;
  state.ball.ownerSide = player.side;
  state.ball.flight = null;
  state.ball.posFx.x = player.posFx.x;
  state.ball.posFx.y = player.posFx.y;
  state.possession = player.side;
}

/** side 팀에서 (x,y) 에 가장 가까운 비-GK 선수. */
function nearestOfSide(state: SimState, side: TeamSide, x: number, y: number): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side !== side || p.isGK) continue;
    const d = fdist(p.posFx.x, p.posFx.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/** (x,y) 최근접 선수(양팀). */
function nearestAny(state: SimState, x: number, y: number): { p: SimPlayer; dist: number } | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    const d = fdist(p.posFx.x, p.posFx.y, x, y);
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best ? { p: best, dist: bestD } : null;
}

/** 골 후 킥오프 리셋(실점팀이 센터에서 시작). */
export function resetKickoff(state: SimState, pitch: Pitch, restartSide: TeamSide): void {
  const c = centerSpot(pitch);
  const taker = nearestOfSide(state, restartSide, c.x, c.y);
  if (taker) {
    taker.posFx.x = c.x;
    taker.posFx.y = c.y;
    giveBallTo(state, taker);
  } else {
    state.ball.posFx = { ...c };
    state.possession = restartSide;
  }
}

/**
 * 비행 중 패스/슛을 상대가 가로채는지(매 틱). 성공 시 소유 이전.
 */
export function tryIntercept(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  tick: number,
  minute: number,
): MatchEvent[] {
  const f = state.ball.flight;
  if (!f || f.kind === "loose") return [];
  const range = config.contest.interceptRange * config.fixedScale;
  const defSide: TeamSide = f.fromSide === "home" ? "away" : "home";

  let cand: SimPlayer | null = null;
  let candD = Infinity;
  for (const p of state.players) {
    if (p.side !== defSide) continue;
    const d = fdist(p.posFx.x, p.posFx.y, state.ball.posFx.x, state.ball.posFx.y);
    if (d <= range && d < candD) {
      candD = d;
      cand = p;
    }
  }
  if (!cand) return [];

  const prob = fclamp(config.contest.interceptBase * attrFactor(cand.attrs.positioning), 0.02, 0.9);
  if (rng.next() < prob) {
    giveBallTo(state, cand);
    return [
      { tick, minute, type: "interception", team: cand.side, playerId: cand.id, detail: "cut out" },
    ];
  }
  return [];
}

/**
 * 볼 주인이 상대 태클에 뺏기는지(매 틱). 성공 시 소유 이전.
 */
export function tryTackle(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  tick: number,
  minute: number,
): MatchEvent[] {
  const ball = state.ball;
  if (ball.flight || !ball.owner) return [];
  const owner = state.byId.get(ball.owner);
  if (!owner) return [];
  const range = config.contest.tackleRange * config.fixedScale;

  let tackler: SimPlayer | null = null;
  let tackD = Infinity;
  for (const p of state.players) {
    if (p.side === owner.side) continue;
    const d = fdist(p.posFx.x, p.posFx.y, owner.posFx.x, owner.posFx.y);
    if (d <= range && d < tackD) {
      tackD = d;
      tackler = p;
    }
  }
  if (!tackler) return [];

  const off = attrFactor(owner.attrs.technical) * (1 + owner.behavior.dribbleTendency * 0.3);
  const def = attrFactor(tackler.attrs.tackling) * (0.7 + tackler.behavior.pressAggression * 0.6);
  const prob = fclamp((config.contest.tackleBase * def) / off, 0.03, 0.85);
  if (rng.next() < prob) {
    giveBallTo(state, tackler);
    return [{ tick, minute, type: "tackle", team: tackler.side, playerId: tackler.id }];
  }
  return [];
}

/**
 * 패스/루즈볼 도착 처리 — 도착점 최근접 선수가 컨트롤.
 * 같은 팀이 받으면 pass 완료, 상대가 잡으면 interception.
 */
export function resolveArrival(
  state: SimState,
  config: EngineConfig,
  pitch: Pitch,
  tick: number,
  minute: number,
): MatchEvent[] {
  const f = state.ball.flight;
  if (!f) return [];
  const fromSide = f.fromSide;

  // 도착점 최근접 선수(양팀). controlRange 안이면 그가, 아니면 의도 수신자.
  const near = nearestAny(state, state.ball.posFx.x, state.ball.posFx.y);
  let controller: SimPlayer | null = null;
  if (near && near.dist <= config.contest.controlRange * config.fixedScale) {
    controller = near.p;
  } else if (f.target) {
    controller = state.byId.get(f.target) ?? null;
  }
  if (!controller) controller = near ? near.p : null;
  if (!controller) {
    // 아무도 없으면 루즈볼로 방치(정지).
    state.ball.flight = null;
    return [];
  }

  giveBallTo(state, controller);
  if (f.kind === "loose") return [];
  if (controller.side === fromSide) {
    return [{ tick, minute, type: "pass", team: fromSide, playerId: controller.id }];
  }
  return [{ tick, minute, type: "interception", team: controller.side, playerId: controller.id }];
}

/**
 * 슛 도착 처리 — 시드 베르누이(xG)로 득점/선방 결정.
 * 득점: 스코어 증가 + 실점팀 킥오프. 선방/빗맞음: 수비팀 GK 소유.
 */
export function resolveShot(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
  tick: number,
  minute: number,
): MatchEvent[] {
  const f = state.ball.flight;
  if (!f || f.kind !== "shot") return [];
  const shooter = f.target ? state.byId.get(f.target) : null;
  const scorerSide = f.fromSide;
  const xg = f.xg ?? config.contest.xgBase;
  const defSide: TeamSide = scorerSide === "home" ? "away" : "home";

  if (rng.next() < xg) {
    state.score[scorerSide] += 1;
    const ev: MatchEvent = {
      tick,
      minute,
      type: "goal",
      team: scorerSide,
      xg,
    };
    if (shooter) ev.playerId = shooter.id;
    resetKickoff(state, pitch, defSide);
    return [ev];
  }

  // 선방 — 수비 GK 소유.
  const gk = state.players.find((p) => p.side === defSide && p.isGK);
  if (gk) {
    const goal = defendGoal(pitch, defSide);
    const c = clampToPitch(pitch, goal.x, goal.y);
    gk.posFx.x = c.x;
    gk.posFx.y = c.y;
    giveBallTo(state, gk);
  } else {
    state.ball.flight = null;
    state.possession = defSide;
  }
  return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }];
}
