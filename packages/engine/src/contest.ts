import type { EngineConfig } from "./config";
import type { SimState, SimPlayer, DeferredRestart } from "./simstate";
import type { PossessionReason } from "./simstate";
import { playerKey, playerAt, ballOwnerOf, claimantSideOf, setPossession } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { MatchEvent, TeamSide } from "@hmb/shared";
import { fdist, fclamp, toFixed, isqrt } from "./fixedmath";
import { centerSpot, defendGoal, attackGoal, clampToPitch } from "./pitch";
import { deliverySpeedFx, shotPowerFx } from "./kick";
import { xgAtPoint } from "./decision";

/**
 * contest — 경합 판정(패스/인터셉트/태클/슛).
 * ESMS/xG 참고: 결과는 인자 Rng 의 시드 베르누이로만 결정한다.
 * 모든 함수는 state 를 변경하고 발생한 MatchEvent 를 반환한다.
 */

function attrFactor(v: number): number {
  return 0.6 + 0.8 * (v / 100);
}

/**
 * 공을 player 에게 넘긴다(비행 종료·글루).
 * `reason` 은 소유 전환의 종류 — **재시작(킥오프)에서도 불리므로** 호출부가 반드시 판단해서 넘긴다.
 * (reason 없이 전부 턴오버로 기록하면 S4 의 카운터프레스가 킥오프/재시작마다 발동한다.)
 */
function giveBallTo(state: SimState, player: SimPlayer, reason: PossessionReason): void {
  state.ball.owner = player.id;
  state.ball.ownerSide = player.side;
  state.ball.flight = null;
  state.ball.posFx.x = player.posFx.x;
  state.ball.posFx.y = player.posFx.y;
  setPossession(state, player.side, state.tick, reason);
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
  // 데드볼 재시작 전용 경로 — 오픈플레이 턴오버가 아니다(스로인/프리킥/코너/골킥/페널티).
  setPossession(state, taker.side, state.tick, "restart");
  return d;
}

/**
 * taker 가 dist(fixed) 를 평소 속도로 걸어와 도달하는 데 필요한 정지 틱. base 이상, base+16 상한 클램프.
 * 걷기 속도는 match.ts speedStep 과 동일 공식(pace + 피로) — 도달 보장(순간배치 대신 시간을 준다).
 * 대부분(근거리 스로인/코너/프리킥)은 base 로 수렴, 먼 전환 코너만 연장.
 */
function walkStoppage(config: EngineConfig, taker: SimPlayer, dist: number, base: number, capped = true): number {
  const { minPerTick, maxPerTick, fatigueFloor } = config.speed;
  const paceFrac = taker.attrs.pace / 100;
  const raw = (minPerTick + (maxPerTick - minPerTick) * paceFrac) * (1 - (1 - fatigueFloor) * taker.fatigue);
  // #174: 정지 중엔 taker 도 걷기 속도 상한을 받는다(match.ts 이동 루프와 **동일한 상한**).
  // 여기서 캡을 안 걸면 정지 틱을 평소 속도로 산정해 taker 가 도달하기 전에 재시작돼 #59 가 깨진다.
  // match.ts 이동 루프와 **동일 상한**을 쓴다(코너는 더 느슨) — 안 맞추면 도달 전에 재시작된다.
  const cap = capped ? config.rules.deadBall.walkSpeedM : config.rules.deadBall.cornerWalkSpeedM;
  const perTickM = Math.min(raw, cap);
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
    giveBallTo(state, taker, "kickoff");
  } else {
    state.ball.posFx = { ...c };
    setPossession(state, restartSide, state.tick, "kickoff");
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
    state.stoppage = walkStoppage(config, taker, dist, base, kind !== "corner");
  } else {
    state.ball.posFx = { x: spot.x, y: spot.y };
    state.ball.owner = null;
    state.ball.ownerSide = null;
    state.ball.flight = null;
    setPossession(state, side, state.tick, "restart");
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
  const taker = ballOwnerOf(state) ?? null;
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
  const crossSpeed = deliverySpeedFx(toFixed(config.setPiece.crossSpeed, scale), true, config);
  state.ball.flight = {
    toX: t.x,
    toY: t.y,
    speed: crossSpeed,
    kind: "pass",
    // #306: 코너 크로스는 **띄운 공**이다 — 도착 순간이 공중 경합(헤딩)이 된다.
    delivery: "lofted",
    hangTicks: Math.max(1, Math.ceil(fdist(state.ball.posFx.x, state.ball.posFx.y, t.x, t.y) / Math.max(1, crossSpeed))),
    target: rec ? rec.id : undefined,
    fromSide: taker.side,
    // #313: 발사점이 없으면 `settle()` 이 굴림 방향을 구하지 못해 크로스가 낙하점에 딱 선다
    // (코너 크로스는 이 필드가 없어서 굴리기 대상에서 통째로 빠져 있었다).
    fromX: state.ball.posFx.x,
    fromY: state.ball.posFx.y,
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
    setPossession(state, side, state.tick, "restart");
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
    setPossession(state, side, state.tick, "restart");
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
  state.byId.delete(playerKey(player.side, player.id));
  // #231: 소유 판정도 side 를 함께 본다 — 같은 id 의 반대 팀 선수가 퇴장했다고 소유가 풀리면 안 된다.
  if (state.ball.owner === player.id && state.ball.ownerSide === player.side) {
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

  // #312: 틱당 확률을 공속으로 정규화 — 느린 패스가 오래 난다고 컷 롤을 더 받으면
  // E1 패스 성공률 캘리브레이션이 이중 적용된다(위 `interceptSpeedRefM` 주석).
  const refFx = toFixed(config.contest.interceptSpeedRefM, config.fixedScale);
  const speedNorm = refFx > 0 ? Math.min(1, f.speed / refFx) : 1;
  const prob = fclamp(
    config.contest.interceptBase * attrFactor(cand.attrs.positioning) * speedNorm,
    0.02 * speedNorm,
    0.9,
  );
  if (rng.next() < prob) {
    giveBallTo(state, cand, "turnover");
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
    // 박스 파울 → 페널티 배치(데드볼 재시작). 오픈플레이 턴오버가 아니다.
    setPossession(state, victim.side, tick, "restart");
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
  const owner = ballOwnerOf(state);
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
    giveBallTo(state, tackler, "turnover");
    return [{ tick, minute, type: "tackle", team: tackler.side, playerId: tackler.id }];
  }
  return [];
}

/**
 * 공중 경합(#306 S6) 후보의 점수 — **높이 싸움은 physical 이 결정한다**.
 * 거리는 선형 감점(반경 밖은 애초에 후보가 아니다). 순수 함수·Rng 0.
 */
function aerialScore(p: SimPlayer, distFx: number, config: EngineConfig): number {
  const a = config.contest.aerial;
  const attr = (a.physicalWeight * p.attrs.physical + (1 - a.physicalWeight) * p.attrs.positioning) / 100;
  const distM = distFx / config.fixedScale;
  const reach = Math.max(0.05, 1 - distM / a.distanceRefM);
  return attr * reach * (1 - 0.25 * p.fatigue);
}

/**
 * 공중볼 도착 — **헤딩 경합**(#306 S6).
 *
 * 지상 패스는 "손 닿는 사람이 잡는다"지만 띄운 공은 다르다. 뛰어올라 머리로 맞히는 싸움이고,
 * 반경도 넓고(`aerial.rangeM`), **잡히기보다 떨어진다**(`aerial.controlBase`) — 그 떨어진 공이
 * 세컨볼이다. 여기서 `settle()`(#313 굴림)과 맞물려 "헤더 → 세컨볼 쟁탈"이 나온다.
 *
 * 계획된 패스 결과(`passOutcome`)는 **어느 팀이 이기는지**를 계속 소유한다(벤치 78–85% 캘리브레이션의
 * 근간을 헤딩 기하가 몰래 덮어쓰지 않게). 헤딩이 정하는 것은 **그 팀의 누가**, 그리고
 * **잡느냐 떨궈내느냐**다. 계획이 없는 공(코너 크로스)은 점수로 승자 팀까지 정한다.
 *
 * 반환 `null` = 공중 경합이 성립하지 않음(반경 안에 아무도 없다) → 호출부가 기존 경로로 진행.
 */
function resolveAerial(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
  tick: number,
  minute: number,
): MatchEvent[] | null {
  const f = state.ball.flight;
  const a = config.contest.aerial;
  if (!f || !a.enabled) return null;
  const bx = state.ball.posFx.x;
  const by = state.ball.posFx.y;
  const range = toFixed(a.rangeM, config.fixedScale);

  // 계획이 있으면 **이기는 팀**은 계획이 정한다(성공=차는 팀 / 인터셉트=상대). 없으면 null.
  let winSide: TeamSide | null = null;
  if (config.contest.passOutcomeAuthoritative && f.passOutcome && f.claimant) {
    if (f.passOutcome === "fail_out") return null; // 라인 밖으로 나가는 공은 경합 대상이 아니다.
    winSide = claimantSideOf(f);
  }

  // 후보 수집 + 승자 선정. 동률은 **전순서**(점수 → idHash → id)로만 깬다(§5-3).
  let winner: SimPlayer | null = null;
  let winScore = -Infinity;
  let contested = 0;
  for (const p of state.players) {
    const d = fdist(p.posFx.x, p.posFx.y, bx, by);
    if (d > range) continue;
    contested++;
    if (winSide && p.side !== winSide) continue;
    const sc = aerialScore(p, d, config);
    if (sc < winScore) continue;
    if (sc === winScore && winner) {
      const tie = p.idHash !== winner.idHash ? p.idHash < winner.idHash : p.id < winner.id;
      if (!tie) continue;
    }
    winScore = sc;
    winner = p;
  }
  // **경합이 실제로 있을 때만** 헤딩 판정을 한다(반경 안 2명 이상). 혼자 있는 공중볼은
  // 그냥 받는 것이지 다툼이 아니고, 여기서 잡으면 롱패스 완성률이 헤딩 롤에 통째로 잡아먹혀
  // 벤치 캘리브레이션(78–85%)이 기하로 덮인다.
  if (!winner || contested < 2) return null;

  const opp: TeamSide = f.fromSide === "home" ? "away" : "home";
  const headerDetail = { detail: "header" };

  // --- 헤더 슛: 공격 방향 골 근처에서 이긴 공격수는 머리로 마무리한다. ---
  const goal = attackGoal(pitch, winner.side);
  const goalDist = fdist(winner.posFx.x, winner.posFx.y, goal.x, goal.y);
  if (
    !winner.isGK &&
    winner.side === f.fromSide &&
    goalDist <= toFixed(a.headerShootRangeM, config.fixedScale)
  ) {
    const base = xgAtPoint(winner.side, winner.posFx.x, winner.posFx.y, winner.attrs.shooting, winner.fatigue, config, pitch);
    const xg = fclamp(base.xg * a.headerXgMult, 0.01, 0.9);
    if (xg >= config.contest.shootXgThreshold) {
      state.ball.posFx.x = winner.posFx.x;
      state.ball.posFx.y = winner.posFx.y;
      state.ball.owner = null;
      state.ball.ownerSide = null;
      state.ball.flight = {
        toX: goal.x,
        toY: goal.y,
        speed: shotPowerFx(winner.attrs.shooting, config),
        kind: "shot",
        // 헤더 슛도 공중 산물이다 — 이 플래그로 뷰어·통계가 "머리로 넣은 골"을 구분한다.
        delivery: "lofted",
        target: winner.id,
        fromSide: winner.side,
        xg,
      };
      setPossession(state, winner.side, tick, "turnover");
      return [{ tick, minute, type: "shot", team: winner.side, playerId: winner.id, xg, ...headerDetail }];
    }
  }

  // --- 컨트롤 vs 떨궈내기(세컨볼). ---
  const controlProb = fclamp(a.controlBase * attrFactor(winner.attrs.technical), 0.05, 0.95);
  const ev: MatchEvent =
    winner.side === f.fromSide
      ? { tick, minute, type: "pass", team: f.fromSide, playerId: winner.id, ...headerDetail }
      : { tick, minute, type: "interception", team: opp, playerId: winner.id, ...headerDetail };

  if (rng.next() < controlProb) {
    giveBallTo(state, winner, "turnover");
    return [ev];
  }

  // 떨궈낸다 — 수비수는 자기 골 반대로 걷어내고, 공격수는 상대 골 쪽으로 플릭온한다.
  // 소유는 주지 않는다(세컨볼). 방향만 주고 나머지는 `settle()`(#313)의 굴림·감속이 맡는다.
  const away = winner.side === f.fromSide ? goal : defendGoal(pitch, winner.side);
  const sign = winner.side === f.fromSide ? 1 : -1;
  const dx = (away.x - winner.posFx.x) * sign;
  const dy = (away.y - winner.posFx.y) * sign;
  const len = isqrt(dx * dx + dy * dy);
  const speed = toFixed(a.clearSpeed, config.fixedScale);
  state.ball.posFx.x = winner.posFx.x;
  state.ball.posFx.y = winner.posFx.y;
  state.ball.owner = null;
  state.ball.ownerSide = null;
  const run = speed * config.ball.settleLookaheadTicks;
  state.ball.flight = {
    toX: len > 0 ? winner.posFx.x + Math.round((dx * run) / len) : winner.posFx.x,
    toY: len > 0 ? winner.posFx.y + Math.round((dy * run) / len) : winner.posFx.y,
    speed: len > 0 ? speed : 0,
    kind: "loose",
    delivery: "ground",
    fromSide: winner.side,
    // 굴림 방향의 기준점 = 헤딩 지점(여기서 출발했다). 없으면 settle 이 방향을 못 구한다.
    fromX: winner.posFx.x,
    fromY: winner.posFx.y,
  };
  setPossession(state, winner.side, tick, "turnover");
  return [ev];
}

/**
 * 패스/루즈볼 도착 처리 — 도착점 최근접 선수가 컨트롤.
 * 같은 팀이 받으면 pass 완료, 상대가 잡으면 interception.
 * 띄운 공(#306 `delivery === "lofted"`)은 먼저 **헤딩 경합**으로 간다.
 */
export function resolveArrival(
  state: SimState,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
  tick: number,
  minute: number,
): MatchEvent[] {
  {
    const fl = state.ball.flight;
    if (fl && fl.delivery === "lofted" && fl.kind === "pass") {
      const aerial = resolveAerial(state, rng, config, pitch, tick, minute);
      if (aerial) return aerial;
    }
  }
  const f = state.ball.flight;
  if (!f) return [];
  const fromSide = f.fromSide;
  const bx = state.ball.posFx.x;
  const by = state.ball.posFx.y;

  // 계획된 패스 결과(passOutcome)를 존중: 성공 롤 → 동료(의도 리시버), 실패(fail_intercept) 롤 →
  // 도착점 최근접 상대가 컨트롤(진짜 인터셉트). → 실측 완성률 == 계획 확률(computePassProb) 이라
  // passBase/페널티 config 가 성공률의 실제 노브가 된다(E1). 기존 순수 기하는 실패 롤도 의도 리시버가
  // 우연히 되찾아 "완성"으로 집계되어 성공률이 계획보다 과하게 높던(패스 정확도 과다) 문제가 있었다.
  // 세트피스 크로스/루즈볼(passOutcome 없음)은 항상 기하 판정.
  const longDetail = f.long ? { detail: "long" } : {};

  // #181: **공은 손 닿는 곳에 있는 사람에게만 간다.** 구버전은 도착 처리에서 공을 컨트롤러 위치로
  // 거리 무제한 대입해(p50 5.9m·max 33.7m) "아무도 없는데 공이 스스로 휘는" 궤적을 만들었다.
  // 아무도 못 닿았으면 공은 **떨어진 자리에 그대로 정지**하고(무소유), 비행 객체만 speed 0 으로
  // 살려둬 다음 틱에 다시 판정한다 → 달려온 사람이 controlRange 안에 들어오는 순간 잡는다.
  // (1차 수정은 여기에 "최대 N틱 대기 후 폴백" 을 뒀는데, 그 폴백이 여전히 무제한 순간이동이라
  //  정지→16~20m 워프가 90분 128~169회 남았다 — 독립 QA blocker. 폴백 자체를 없앤다.)
  const reach = toFixed(config.contest.controlRange, config.fixedScale);
  /**
   * 아무도 못 닿음 → **원래 가던 방향 그대로 굴려보낸다**(살짝 오버힛된 패스). 감속(looseDecay)으로
   * 곧 멈추고, 달려온 선수가 주워간다(decideOffBall 루즈볼 쟁탈).
   *  - 순간이동 금지: 공을 사람 위치로 대입하지 않는다(구버전 max 33.7m 워프).
   *  - **재조준 금지**: 사람 쪽으로 방향을 틀며 쫓아가게 하면 공(5m/tick)과 선수(≤7m/tick)가
   *    서로를 지나치며 leapfrog 진동해 경기가 멈춘다(실측: 슛 0.05 로 붕괴).
   *  - 방향을 안 바꾸므로 "빈 공간에서 공이 꺾이는" 현상도 생기지 않는다.
   */
  const settle = (): MatchEvent[] => {
    const dx = f.fromX != null ? bx - f.fromX : 0;
    const dy = f.fromY != null ? by - f.fromY : 0;
    // 방향 길이는 정수 제곱근으로(플랫폼 편차 0). 발사점→현재의 벡터라 공이 그 직선 위를
    // 굴러가는 동안 **방향이 변하지 않는다** — 이것이 leapfrog 진동(#181)이 안 생기는 이유다.
    const len = isqrt(dx * dx + dy * dy);
    // #313: 굴림 속도는 **첫 settle 에서 한 번만** 정한다(도착 속도 × frac, 상한 settleSpeed).
    // 이미 굴러가는 중(kind==="loose")이면 advanceBall 이 looseDecay 로 깎아 둔 속도를 **보존**한다.
    // 매 틱 상수로 되돌리면 감속이 무효가 되어 공이 영원히 같은 속도로 굴러 나간다.
    const wasLoose = f.kind === "loose";
    if (!wasLoose) {
      const cap = toFixed(config.ball.settleSpeed, config.fixedScale);
      const carry = Math.round(f.speed * config.ball.settleSpeedFrac);
      f.speed = Math.min(cap, Math.max(0, carry));
      f.kind = "loose";
    }
    f.waited = (f.waited ?? 0) + 1;
    // 1 fixed unit(=1m/tick) 미만이면 정지 — 여기서 멈춘 공은 직전 틱 이동도 이미 1m 미만이라
    // "날아가다 급정지"로 보이지 않는다(감속으로 자연스럽게 선다).
    if (len > 0 && f.speed >= config.fixedScale) {
      // 목표는 **방향만** 준다(감속으로 그 전에 멈춘다). 피치 안으로 클램프하지 않는다 —
      // 클램프하면 경계 근처에서 구르는 방향이 꺾여 "빈 공간 꺾임"이 다시 생긴다(실측 172건).
      // 경계를 넘으면 advanceBall 의 아웃 판정이 스로인/골킥으로 정상 처리한다(오버힛 패스 그대로).
      const run = f.speed * config.ball.settleLookaheadTicks;
      f.toX = bx + Math.round((dx * run) / len);
      f.toY = by + Math.round((dy * run) / len);
    } else {
      f.speed = 0;
      f.toX = bx;
      f.toY = by;
    }
    state.ball.owner = null;
    state.ball.ownerSide = null;
    return [];
  };
  const inReach = (p: SimPlayer | null | undefined): boolean =>
    !!p && fdist(p.posFx.x, p.posFx.y, bx, by) <= reach;

  // 1) 계획된 결과(passOutcome)를 존중하는 창 — claimant 가 닿으면 계획대로 준다.
  //    아직 못 왔으면 arrivalWaitMaxTicks 동안 공을 세워두고 기다린다(계획 보존).
  if (config.contest.passOutcomeAuthoritative && f.passOutcome && f.claimant) {
    const oppSide: TeamSide = fromSide === "home" ? "away" : "home";
    // #231: claimant 의 팀은 계획된 결과에서 파생된다(인터셉트=상대 / 성공=차는 팀).
    // id 단독 조회면 같은 id 의 반대 팀 선수가 잡혀 엉뚱한 쪽에 공이 간다.
    const claimant = playerAt(state, claimantSideOf(f), f.claimant);
    if (inReach(claimant)) {
      // 성공 패스면 같은 팀 → setPossession 이 no-op(턴오버 아님), 계획된 인터셉트면 상대 → 턴오버.
      giveBallTo(state, claimant!, "turnover");
      if (f.passOutcome === "success") {
        return [{ tick, minute, type: "pass", team: fromSide, playerId: claimant!.id, ...longDetail }];
      }
      return [{ tick, minute, type: "interception", team: oppSide, playerId: claimant!.id, ...longDetail }];
    }
    if ((f.waited ?? 0) < config.contest.arrivalWaitMaxTicks) return settle();
    // 계획 창이 지났다 → 아래 기하 판정(먼저 닿은 사람이 임자)으로 넘어간다.
  }

  // 2) 기하 판정 — 도착점 controlRange 안 최근접 선수. 없으면 공은 정지한 채 기다린다.
  const near = nearestAny(state, bx, by);
  let controller: SimPlayer | null = null;
  if (near && near.dist <= reach) controller = near.p;
  if (!controller) return settle();

  const wasLoose = f.kind === "loose";
  // 기하 판정(먼저 닿은 사람이 임자) — 상대가 잡으면 오픈플레이 턴오버, 우리 편이면 no-op.
  giveBallTo(state, controller, "turnover");
  // 정지해 있던 공(rest)을 주워간 경우에도, 계획된 패스였다면 그 결과를 이벤트로 남긴다
  // (스탯의 패스 완성/가로챔 집계가 비지 않도록).
  if (wasLoose && !f.passOutcome) return [];
  if (controller.side === fromSide) {
    return [{ tick, minute, type: "pass", team: fromSide, playerId: controller.id, ...longDetail }];
  }
  return [{ tick, minute, type: "interception", team: controller.side, playerId: controller.id, ...longDetail }];
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
  // #231: 슈터는 항상 차는 팀(fromSide) 소속이다.
  const shooter = playerAt(state, f.fromSide, f.target) ?? null;
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
    setPossession(state, defSide, tick, "goal");
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
    // 공이 죽고 코너/골킥으로 재시작되는 경로 — 오픈플레이 턴오버가 아니다.
    setPossession(state, defSide, tick, "restart");
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
    giveBallTo(state, gkSaver, "turnover");
  } else {
    state.ball.posFx = { x: keeperSpot.x, y: keeperSpot.y };
    state.ball.flight = null;
    // GK 캐치 = 인플레이 지속(정지 없음) → 오픈플레이 턴오버.
    setPossession(state, defSide, tick, "turnover");
  }
  return [{ tick, minute, type: "shot", team: scorerSide, xg, detail: "saved" }, saveEv];
}
