import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { MatchEvent, TeamSide } from "@hmb/shared";
import { fdist, fclamp, toFixed } from "./fixedmath";
import { centerSpot, defendGoal, attackGoal, clampToPitch } from "./pitch";

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

/** 골 후 킥오프 리셋(실점팀이 센터에서 시작). stoppage 를 주면 정지 후 재개. */
export function resetKickoff(
  state: SimState,
  pitch: Pitch,
  restartSide: TeamSide,
  stoppage = 0,
): void {
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
  state.setPiece = { kind: "kickoff", side: restartSide, x: c.x, y: c.y };
  state.stoppage = stoppage;
}

/** side 팀 GK. */
function goalkeeperOf(state: SimState, side: TeamSide): SimPlayer | null {
  return state.players.find((p) => p.side === side && p.isGK) ?? null;
}

/**
 * 세트피스 재시작 공통: (x,y) 에 taker 를 세우고 공을 준다. 정지 + setPiece 컨텍스트 설정.
 * kind 가 goal_kick 이면 GK 가, 그 외엔 (x,y) 최근접 아웃필드가 taker.
 */
function placeRestart(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  side: TeamSide,
  x: number,
  y: number,
  kind: "corner" | "throw_in" | "goal_kick",
): SimPlayer | null {
  const spot = clampToPitch(pitch, x, y);
  const taker =
    kind === "goal_kick"
      ? goalkeeperOf(state, side)
      : (nearestOfSide(state, side, spot.x, spot.y) ?? goalkeeperOf(state, side));
  if (taker) {
    taker.posFx.x = spot.x;
    taker.posFx.y = spot.y;
    giveBallTo(state, taker);
  } else {
    state.ball.posFx = { x: spot.x, y: spot.y };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = side;
  }
  state.setPiece = { kind, side, x: spot.x, y: spot.y };
  state.stoppage = config.setPiece.stoppageTicks;
  return taker;
}

/** 스로인 재시작(사이드라인 아웃 → 상대 볼). */
export function restartThrowIn(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  side: TeamSide,
  x: number,
  y: number,
  tick: number,
  minute: number,
): MatchEvent {
  const taker = placeRestart(state, pitch, config, side, x, y, "throw_in");
  return { tick, minute, type: "kickoff", team: side, playerId: taker?.id, detail: "throw_in" };
}

/** 골킥 재시작(공격팀이 골라인 아웃 → 수비팀 GK). */
export function restartGoalKick(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  side: TeamSide,
  tick: number,
  minute: number,
): MatchEvent {
  const own = defendGoal(pitch, side);
  const sign = side === "home" ? 1 : -1;
  const gx = own.x + sign * Math.round(pitch.wFx * 0.05);
  const taker = placeRestart(state, pitch, config, side, gx, own.y, "goal_kick");
  return { tick, minute, type: "kickoff", team: side, playerId: taker?.id, detail: "goal_kick" };
}

/** 코너 재시작(수비팀이 골라인 아웃/세이브 굴절 → 공격팀). nearY 로 위/아래 코너 결정. */
export function restartCorner(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  side: TeamSide,
  nearY: number,
  tick: number,
  minute: number,
): MatchEvent {
  const g = attackGoal(pitch, side); // 공격 골라인 x.
  const cornerY = nearY < Math.round(pitch.hFx / 2) ? 0 : pitch.hFx;
  const taker = placeRestart(state, pitch, config, side, g.x, cornerY, "corner");
  return { tick, minute, type: "kickoff", team: side, playerId: taker?.id, detail: "corner" };
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
  // 패스만 비행 중 인터셉트. 슛은 골문에서 resolveShot 이 처리(중간 차단 없음).
  if (!f || f.kind !== "pass") return [];
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

  // --- 득점 ---
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

    // 공을 골라인 바로 안쪽(네트)에 안착시킨다. 센터 리셋 금지 —
    // goalStoppageTicks 동안 네트에 머문 뒤(세리머니) 킥오프에서 센터로 리셋한다.
    const line = attackGoal(pitch, scorerSide); // 득점팀이 공격하는 골라인(home: wFx, away: 0).
    const scale = config.fixedScale;
    const depth = toFixed(config.setPiece.goalNetDepthM, scale);
    const netX = line.x === 0 ? depth : line.x - depth; // x≈0.5m 또는 (width-0.5)m.
    const halfPost = toFixed(config.pitch.goalWidth / 2, scale);
    // 공이 도착한 y 를 골포스트 사이로 클램프(네트 안).
    const netY = fclamp(state.ball.posFx.y, line.y - halfPost, line.y + halfPost);
    state.ball.posFx = { x: netX, y: netY };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = defSide;
    // 세리머니 정지: kind "goal" 로 표시 → 정지 종료 시 match 가 센터 킥오프(defSide) 수행.
    state.stoppage = config.setPiece.goalStoppageTicks;
    state.setPiece = { kind: "goal", side: defSide, x: netX, y: netY };
    return [ev];
  }

  // --- 유효슛(on target) 여부: shooting/각도로 가감 ---
  const onTargetProb = fclamp(
    config.contest.onTargetBase * (shooter ? attrFactor(shooter.attrs.shooting) : 1),
    0.1,
    0.9,
  );
  const ballY = state.ball.posFx.y;
  if (rng.next() >= onTargetProb) {
    // 빗맞음(off target): 수비 블록에 맞아 코너 굴절 또는 골라인 아웃 → 골킥.
    const restart =
      rng.next() < config.contest.offTargetBlockCornerProb
        ? restartCorner(state, pitch, config, scorerSide, ballY, tick, minute)
        : restartGoalKick(state, pitch, config, defSide, tick, minute);
    return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "off_target" }, restart];
  }

  // 유효슛 세이브: GK 캐치 또는 코너로 굴절.
  if (rng.next() < config.contest.saveCornerProb) {
    const cornerEv = restartCorner(state, pitch, config, scorerSide, ballY, tick, minute);
    return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }, cornerEv];
  }
  const gk = goalkeeperOf(state, defSide);
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
