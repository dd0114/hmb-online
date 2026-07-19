import type { EngineConfig } from "./config";
import type { SimState, SimPlayer, DeferredRestart } from "./simstate";
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

/**
 * #59: 재시작 taker 를 공에 즉시 순간배치하지 않는다 — 공을 스팟에 두고(정지 stationary), taker 는
 * 소유만 부여받되 posFx 는 **현재 위치 그대로 유지**(순간이동/클램프 없음) + targetFx=스팟 → 정지
 * 루프에서 평소 속도(speedStep)로 공까지 걸어간다. 도달(controlRange) 시 정지 루프가 공을 글루(match.ts).
 * "선수가 공한테 가서 잡는" 자연 무브먼트를 뷰어 트릭 없이 데이터로 방출. taker 가 멀면(전환 코너 등)
 * 위치를 당기지 않고 **정지 시간을 늘려**(walkStoppage) 끝까지 걸어오게 한다 — 그래야 점프가 안 생긴다.
 * 반환값 = taker→스팟 거리(fixed): 호출부가 도달 가능한 정지 틱을 산정하는 데 쓴다.
 */
function assignWalkingTaker(state: SimState, taker: SimPlayer, spotX: number, spotY: number): number {
  const d = fdist(taker.posFx.x, taker.posFx.y, spotX, spotY);
  taker.targetFx = { x: spotX, y: spotY };
  state.ball.owner = taker.id;
  state.ball.ownerSide = taker.side;
  state.ball.flight = null;
  state.ball.posFx.x = spotX;
  state.ball.posFx.y = spotY;
  state.possession = taker.side;
  return d;
}

/**
 * taker 가 dist(fixed) 를 평소 속도로 걸어와 도달하는 데 필요한 정지 틱. base 이상, base+16 상한 클램프.
 * 걷기 속도는 match.ts speedStep 과 동일 공식(pace + 피로) — 도달 보장(순간배치 대신 시간을 준다).
 * 대부분(근거리 스로인/코너/프리킥)은 base 로 수렴, 먼 전환 코너만 연장.
 */
function walkStoppage(config: EngineConfig, taker: SimPlayer, dist: number, base: number): number {
  const { minPerTick, maxPerTick, fatigueFloor } = config.speed;
  const paceFrac = taker.attrs.pace / 100;
  const perTickM = (minPerTick + (maxPerTick - minPerTick) * paceFrac) * (1 - (1 - fatigueFloor) * taker.fatigue);
  const stepFx = toFixed(perTickM, config.fixedScale);
  if (stepFx <= 0) return base;
  const ticks = Math.ceil(dist / stepFx) + 2; // +2 = 도착 후 잡는(글루) 프레임 버퍼.
  return Math.min(Math.max(base, ticks), base + 16);
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

/**
 * 킥오프 리셋(경기 시작·골 후 재시작·후반 시작). 실점/재개 팀이 센터에서 시작.
 * config.setPiece.resetFormationOnKickoff 가 true 면 전 선수를 formation 기본 배치(baseFx)로
 * 되돌린 뒤(골 세리머니 동안 흩어진 상태 → 정렬된 킥오프 포메이션) 테이커만 센터로 옮긴다.
 * stoppage 를 주면 정지 후 재개.
 */
export function resetKickoff(
  state: SimState,
  pitch: Pitch,
  restartSide: TeamSide,
  config: EngineConfig,
  stoppage = 0,
): void {
  // 포메이션 리셋: 모든 선수를 킥오프 기본 배치(baseFx = 역할 슬롯)로. 경기 시작 t0 와 동일 슬롯.
  if (config.setPiece.resetFormationOnKickoff) {
    for (const p of state.players) {
      p.posFx.x = p.baseFx.x;
      p.posFx.y = p.baseFx.y;
      p.targetFx.x = p.baseFx.x;
      p.targetFx.y = p.baseFx.y;
    }
  }
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
  const base = config.setPiece.stoppageTicks;
  if (taker) {
    // #59: 공은 스팟에 두고 taker 가 걸어가 잡게(순간배치 제거). 정지 루프가 도달 시 글루.
    // 정지 시간 = taker 가 걸어와 도달하는 데 필요한 만큼(멀면 연장) → 점프 없이 끝까지 걸어옴.
    const dist = assignWalkingTaker(state, taker, spot.x, spot.y);
    state.stoppage = walkStoppage(config, taker, dist, base);
  } else {
    state.ball.posFx = { x: spot.x, y: spot.y };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = side;
    state.stoppage = base;
  }
  state.setPiece = { kind, side, x: spot.x, y: spot.y };
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
 * 코너 정지 종료 시 taker(공 소유자)가 공을 **박스 중앙으로 크로스**(딜리버리)한다.
 * 페널티가 골로 flight 를 쏘듯, 코너는 박스 낙하점으로 pass flight 를 쏜다 → resolveArrival 이
 * 낙하점 최근접(공/수)에게 컨트롤을 준다(박스 크라우딩과 경합). taker 가 드리블로 몰고 나가는
 * 버그(#31) 제거. 낙하점은 골라인에서 crossDepthM 안쪽, 중앙 ± crossWidthM(시드 산포).
 */
export function launchCornerCross(
  state: SimState,
  pitch: Pitch,
  config: EngineConfig,
  rng: Rng,
): void {
  const taker = state.ball.owner ? state.byId.get(state.ball.owner) : null;
  if (!taker) return;
  const g = attackGoal(pitch, taker.side);
  const center = Math.round(pitch.hFx / 2);
  const inward = taker.side === "home" ? -1 : 1; // 골라인에서 필드 안쪽 방향.
  const scale = config.fixedScale;
  const depth = toFixed(config.setPiece.crossDepthM, scale);
  const spread = Math.round((rng.next() * 2 - 1) * toFixed(config.setPiece.crossWidthM, scale));
  const t = clampToPitch(pitch, g.x + inward * depth, center + spread);
  // 명목 수신자: 낙하점 최근접 공격 아웃필더(resolveArrival 폴백용; 최종 컨트롤은 실제 최근접).
  let rec: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side !== taker.side || p.isGK || p.id === taker.id) continue;
    const d = fdist(p.posFx.x, p.posFx.y, t.x, t.y);
    if (d < bestD) { bestD = d; rec = p; }
  }
  state.ball.flight = {
    toX: t.x,
    toY: t.y,
    speed: toFixed(config.setPiece.crossSpeed, scale),
    kind: "pass",
    target: rec ? rec.id : undefined,
    fromSide: taker.side,
  };
  state.ball.owner = null;
  state.ball.ownerSide = null;
  taker.dribbleStreak = 0;
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
  const base = config.rules.freeKickStoppageTicks;
  if (taker) {
    // #59: 공은 스팟에 두고 taker 가 걸어가 잡게(순간배치 제거). 정지 = 도달까지(멀면 연장).
    const dist = assignWalkingTaker(state, taker, spot.x, spot.y);
    state.stoppage = walkStoppage(config, taker, dist, base);
  } else {
    state.ball.posFx = { x: spot.x, y: spot.y };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = side;
    state.stoppage = base;
  }
  state.setPiece = { kind: "free_kick", side, x: spot.x, y: spot.y };
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
  const base = config.rules.penalty.stoppageTicks;
  if (taker) {
    // #59: 공은 스팟에 두고 taker 가 걸어가 잡게(순간배치 제거). 정지 = 도달까지(멀면 연장).
    const dist = assignWalkingTaker(state, taker, spot.x, spot.y);
    state.stoppage = walkStoppage(config, taker, dist, base);
  } else {
    state.ball.posFx = { x: spot.x, y: spot.y };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = side;
    state.stoppage = base;
  }
  state.setPiece = { kind: "penalty", side, x: spot.x, y: spot.y };
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
    // 2단계 페널티(코너 shot_out 패턴): 파울 순간엔 공을 **접촉 지점**(victim 위치)에 파킹(정지) →
    // 파울 비트 정지 종료 시 페널티 스팟 배치+런업 + penalty 이벤트 emit. 순간이동(오픈플레이 공→스팟)이
    // 장면 전환(캡션·카메라) 뒤로 가려져, 움직이던 공이 선수들에게서 튀어나가 보이던 점프가 사라진다.
    // (기존: 파울 틱에 즉시 스팟 배치 → 접촉 지점에서 스팟으로 4m+ 순간이동이 접촉 줌에 그대로 보임.)
    state.ball.posFx = { x: victim.posFx.x, y: victim.posFx.y };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = victim.side;
    state.stoppage = config.rules.penalty.foulBeatTicks;
    state.setPiece = {
      kind: "shot_out",
      side: victim.side,
      x: victim.posFx.x,
      y: victim.posFx.y,
      restart: { kind: "penalty", side: victim.side },
    };
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

  // 슛 도착점(골문 프레임). 세이브/빗맞음 모두 공은 먼저 여기(골문 근처)에 놓인 뒤,
  // 코너/골킥이 되면 별도 shot_out 정지 → 세트피스 재시작으로만 코너 깃발/골킥 스팟에 놓인다.
  const scale = config.fixedScale;
  const line = attackGoal(pitch, scorerSide); // 공격 골라인(home: wFx, away: 0), y=중앙.
  const halfPost = toFixed(config.pitch.goalWidth / 2, scale);
  // 코너가 되면 어느 쪽(위/아래) 깃발인지: 슈터의 y(횡위치)로 결정 → 매번 아래 코너로만 가던 단조로움 해소.
  const cornerNearY = shooter ? shooter.posFx.y : line.y;

  // 공을 도착 프레임에 두고 짧게 정지(shot_out) → 정지 종료 시 restart 세트피스 실행.
  // x 는 클램프하지 않는다(빗맞은 슛은 골라인을 살짝 넘어 필드 밖으로 나가는 프레임을 보여야 함).
  // y 만 피치 안으로 클램프. 세이브/골킥/코너 스팟은 restart 단계에서 별도로 올바르게 배치된다.
  const parkForRestart = (parkX: number, parkY: number, restart: DeferredRestart): void => {
    const py = fclamp(parkY, 0, pitch.hFx);
    state.ball.posFx = { x: parkX, y: py };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    state.possession = defSide;
    state.stoppage = config.setPiece.shotAftermathStoppageTicks;
    state.setPiece = { kind: "shot_out", side: defSide, x: parkX, y: py, restart };
  };

  // --- 유효슛(on target) 여부: shooting/각도로 가감 ---
  const onTargetProb = fclamp(
    config.contest.onTargetBase * (shooter ? attrFactor(shooter.attrs.shooting) : 1),
    0.1,
    0.9,
  );
  if (rng.next() >= onTargetProb) {
    // 빗맞음(off target): 공이 골포스트 바깥으로 벗어나 골라인을 살짝 넘어 필드 밖으로 나간다
    // → 관중 시점에서 "골대 옆으로 슉 벗어나는" 프레임이 보인 뒤 shot_out 정지, 이후 골킥/코너.
    // 코너로 굴절되는 경우도 shot_out 프레임을 경유(코너 깃발 직행 금지).
    // 골라인 바깥(필드 밖) 방향으로 overrun: home 골라인(wFx)→+, away 골라인(0)→-.
    const outSign = line.x === 0 ? -1 : 1;
    const overrunX = line.x + outSign * toFixed(config.contest.offTargetOverrunM, scale);
    // 좌우/상하 빗맞음 분산: 슈터 y 편향 + 시드 롤(항상 같은 쪽 반복 방지).
    const leanHigh = shooter ? shooter.posFx.y >= line.y : true;
    const pHigh = leanHigh ? config.contest.offTargetSideBias : 1 - config.contest.offTargetSideBias;
    const missDir = rng.next() < pHigh ? 1 : -1;
    const missY = line.y + missDir * (halfPost + toFixed(config.contest.offTargetWideMarginM, scale));
    const toCorner = rng.next() < config.contest.offTargetBlockCornerProb;
    parkForRestart(
      overrunX,
      missY,
      toCorner
        ? { kind: "corner", side: scorerSide, nearY: cornerNearY }
        : { kind: "goal_kick", side: defSide },
    );
    return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "off_target" }];
  }

  // 유효슛 세이브: GK 가 슛을 막는다. 공은 먼저 키퍼(골문 중앙)에 도달(세이브 시각화).
  const gkSaver = goalkeeperOf(state, defSide);
  const saveEv: MatchEvent = { tick, minute, type: "save", team: defSide, playerId: gkSaver?.id };
  // 캐치 지점: 골라인이 아니라 필드 안쪽 saveCatchDepthM 앞(골문 안이면 골로 오인 → V2 #15).
  const keeperGoal = defendGoal(pitch, defSide);
  const catchDepth = toFixed(config.contest.saveCatchDepthM, config.fixedScale);
  const catchX = keeperGoal.x === 0 ? catchDepth : keeperGoal.x - catchDepth;
  const keeperSpot = clampToPitch(pitch, catchX, keeperGoal.y);
  if (gkSaver) {
    gkSaver.posFx.x = keeperSpot.x;
    gkSaver.posFx.y = keeperSpot.y;
  }
  if (rng.next() < config.contest.saveCornerProb) {
    // #91: 세이브 굴절 코너 — 공을 키퍼(라인 앞)에 세워 멈추게(freeze) 하지 말고, 키퍼를 스쳐 **골라인
    // 밖으로 굴절돼 나가는** 지점에 둔다(빗맞은슛 오버런과 동일). 뷰어가 슛→이 지점을 보간하므로 공이
    // 실제로 나가는 게 보이고 "키퍼가 잡아 멈춤" 부자연 freeze 가 사라진다(엔진 데이터 자연화, 뷰어 트릭 X).
    const outSign = keeperGoal.x === 0 ? -1 : 1;
    const overrunX = keeperGoal.x + outSign * toFixed(config.contest.offTargetOverrunM, scale);
    const towardCorner = cornerNearY < line.y ? -1 : 1; // 굴절 코너 쪽(위/아래)으로 라인 밖.
    // 공은 포스트 살짝 밖(saveCornerWideMarginM)으로 나가고, **키퍼는 그 지점 앞(catchX)에서 같은 y 로
    // 다이빙해 쳐낸다** → 키퍼가 공 궤적 위(≈0.5m)에 있어 "키퍼가 공을 건드려 굴절 코너"가 보인다.
    // (hero 지적: 구 — 공이 포스트 3m 밖·키퍼는 중앙(y=34) → 공↔키퍼 9m, 터치 없이 선방처럼 보였음.)
    const deflY = line.y + towardCorner * (halfPost + toFixed(config.contest.saveCornerWideMarginM, scale));
    if (gkSaver) {
      const dive = clampToPitch(pitch, catchX, deflY);
      gkSaver.posFx.x = dive.x;
      gkSaver.posFx.y = dive.y;
    }
    parkForRestart(overrunX, deflY, { kind: "corner", side: scorerSide, nearY: cornerNearY });
    return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }, saveEv];
  }
  // GK 캐치: 키퍼가 공을 잡고 인플레이 지속(정지 없음).
  if (gkSaver) {
    giveBallTo(state, gkSaver);
  } else {
    state.ball.posFx = { x: keeperSpot.x, y: keeperSpot.y };
    state.ball.flight = null;
    state.possession = defSide;
  }
  return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }, saveEv];
}
