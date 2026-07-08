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

/** 공격 방향 정규화 진행도(0:자기골 라인, 1:상대골 라인). */
function attackProgressX(pitch: Pitch, side: TeamSide, x: number): number {
  const frac = x / pitch.wFx;
  return side === "home" ? frac : 1 - frac;
}

/**
 * 프리킥 재시작(파울/오프사이드). side 팀이 (x,y) 에서 재개. dead-ball 정지.
 */
export function restartFreeKick(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  side: TeamSide,
  x: number,
  y: number,
  tick: number,
  minute: number,
  detail?: string,
): MatchEvent {
  const spot = clampToPitch(pitch, x, y);
  const taker = nearestOfSide(state, side, spot.x, spot.y) ?? goalkeeperOf(state, side);
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
  state.setPiece = { kind: "free_kick", side, x: spot.x, y: spot.y };
  state.stoppage = config.rules.freeKickStoppageTicks;
  return { tick, minute, type: "free_kick", team: side, playerId: taker?.id, detail };
}

/**
 * 페널티 재시작(수비 박스 내 파울). 공격팀 테이커를 페널티 스팟에 세우고 dead-ball 정지.
 * 정지가 끝나면 match(launchPenaltyShot)가 고xG 슛을 발사한다.
 */
export function restartPenalty(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  side: TeamSide,
  tick: number,
  minute: number,
): void {
  const g = attackGoal(pitch, side);
  const sign = side === "home" ? 1 : -1;
  const spotX = g.x - sign * toFixed(config.rules.penalty.spotM, config.fixedScale);
  const spot = clampToPitch(pitch, spotX, g.y);
  const taker = nearestOfSide(state, side, spot.x, spot.y) ?? goalkeeperOf(state, side);
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
  state.setPiece = { kind: "penalty", side, x: spot.x, y: spot.y };
  state.stoppage = config.rules.penalty.stoppageTicks;
  void tick;
  void minute;
}

/** 선수 퇴장(레드카드): 코트에서 제거(인원 감소). 소유 중이면 공은 루즈볼 처리. */
function sendOff(state: SimState, player: SimPlayer): void {
  const idx = state.players.indexOf(player);
  if (idx >= 0) state.players.splice(idx, 1);
  state.byId.delete(player.id);
  if (state.ball.owner === player.id) {
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
  }
}

/**
 * 오프사이드 판정(전진 패스 순간). 리시버가 공격 진영에서 2nd-last 수비수보다
 * 앞(상대 골 쪽)이면 오프사이드. 수비팀 offsideTrap on 이면 라인을 높여 더 자주 유도.
 */
export function checkOffside(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
  owner: SimPlayer,
  receiver: SimPlayer,
): boolean {
  const o = config.rules.offside;
  if (!o.enabled) return false;
  const side = owner.side;
  const recProg = attackProgressX(pitch, side, receiver.posFx.x);
  // 공격 진영(상대 하프)에서만 + 전진 패스(리시버가 소유자보다 앞)일 때만.
  if (recProg < 0.5) return false;
  if (recProg <= attackProgressX(pitch, side, owner.posFx.x)) return false;

  const defSide: TeamSide = side === "home" ? "away" : "home";
  // 수비팀 선수들의 진행도(공격자 관점). 큰 값일수록 자기 골에 가까움(=마지막 수비수).
  const progs: number[] = [];
  for (const p of state.players) {
    if (p.side !== defSide) continue;
    progs.push(attackProgressX(pitch, side, p.posFx.x));
  }
  if (progs.length < 2) return false;
  progs.sort((a, b) => b - a);
  let lineProg = progs[1]!; // 2nd-last defender.
  const tolNorm = o.toleranceM / config.pitch.width;
  const trap = state.teams[defSide].offsideTrap;
  // offsideTrap on 이면 라인을 하프웨이 쪽으로 끌어올림 → 더 많은 리시버가 라인 앞.
  if (trap) lineProg -= o.trapBiasM / config.pitch.width;
  if (!(recProg > lineProg + tolNorm)) return false;
  // 호출 게이트: 기하학적 오프사이드 중 실제 깃발이 오르는 비율(온사이드 런 타이밍 미모델링 보정).
  const callProb = trap ? fclamp(o.callProb * o.trapCallMult, 0, 1) : o.callProb;
  return rng.next() < callProb;
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

/** 피파울 지점(victim 위치)이 태클러의 수비 박스(victim 의 공격 골 박스) 안인지. */
function victimInAttackBox(pitch: Pitch, config: EngineConfig, victim: SimPlayer): boolean {
  const g = attackGoal(pitch, victim.side);
  const scale = config.fixedScale;
  const depth = toFixed(config.rules.penalty.boxDepthM, scale);
  const halfW = toFixed(config.rules.penalty.boxHalfWidthM, scale);
  const nearLine = Math.abs(victim.posFx.x - g.x) <= depth;
  const inWidth = Math.abs(victim.posFx.y - g.y) <= halfW;
  return nearLine && inWidth;
}

/**
 * 파울 처리: foul 이벤트 + 카드(옐로/레드, 2옐로=퇴장) + 박스 내면 페널티, 아니면 프리킥.
 */
function commitFoul(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
  tackler: SimPlayer,
  victim: SimPlayer,
  tick: number,
  minute: number,
): MatchEvent[] {
  const events: MatchEvent[] = [];
  events.push({ tick, minute, type: "foul", team: tackler.side, playerId: tackler.id });

  // 카드 심각도(시드 롤). 직접 레드 < redProb, 옐로 < redProb+yellowProb.
  const cr = config.rules.card;
  const roll = rng.next();
  let sentOff = false;
  if (roll < cr.redProb) {
    events.push({ tick, minute, type: "card", team: tackler.side, playerId: tackler.id, detail: "red" });
    sentOff = true;
  } else if (roll < cr.redProb + cr.yellowProb) {
    tackler.yellowCards += 1;
    events.push({ tick, minute, type: "card", team: tackler.side, playerId: tackler.id, detail: "yellow" });
    if (tackler.yellowCards >= 2) {
      events.push({ tick, minute, type: "card", team: tackler.side, playerId: tackler.id, detail: "red" });
      sentOff = true;
    }
  }

  const inBox = victimInAttackBox(pitch, config, victim);
  if (sentOff) sendOff(state, tackler);

  if (inBox) {
    events.push({ tick, minute, type: "penalty", team: victim.side });
    restartPenalty(state, pitch, config, victim.side, tick, minute);
  } else {
    events.push(
      restartFreeKick(state, pitch, config, victim.side, victim.posFx.x, victim.posFx.y, tick, minute, "foul"),
    );
  }
  return events;
}

/**
 * 볼 주인이 상대 태클에 뺏기는지(매 틱). 파울 확률 선판정 → 파울이면 프리킥/페널티/카드,
 * 아니면 시드 베르누이 태클 경합. 성공 시 소유 이전.
 */
export function tryTackle(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
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

  // --- 파울 판정(태클 시도당) ---
  const fr = config.rules.foul;
  const boxMult = victimInAttackBox(pitch, config, owner) ? fr.boxFoulMult : 1;
  const bookedMult = tackler.yellowCards > 0 ? fr.bookedRelief : 1;
  const foulProb = fclamp(
    fr.base *
      (0.5 + tackler.behavior.pressAggression * fr.aggressionWeight) *
      (1 + fr.tacklingRelief * (1 - tackler.attrs.tackling / 100)) *
      boxMult *
      bookedMult,
    0,
    0.9,
  );
  if (rng.next() < foulProb) {
    return commitFoul(state, rng, config, pitch, tackler, owner, tick, minute);
  }

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
  const gkSaver = goalkeeperOf(state, defSide);
  const saveEv: MatchEvent = { tick, minute, type: "save", team: defSide, playerId: gkSaver?.id };
  if (rng.next() < config.contest.saveCornerProb) {
    const cornerEv = restartCorner(state, pitch, config, scorerSide, ballY, tick, minute);
    return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }, saveEv, cornerEv];
  }
  if (gkSaver) {
    const goal = defendGoal(pitch, defSide);
    const c = clampToPitch(pitch, goal.x, goal.y);
    gkSaver.posFx.x = c.x;
    gkSaver.posFx.y = c.y;
    giveBallTo(state, gkSaver);
  } else {
    state.ball.flight = null;
    state.possession = defSide;
  }
  return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }, saveEv];
}
