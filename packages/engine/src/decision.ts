import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import { playerAt, otherSide, claimantSideOf, isBallOwner } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { PassOption } from "./perception";
import { fromFixed, fclamp, fdist, toFixed, stepToward, isqrt } from "./fixedmath";
import { attackGoal, defendGoal, distToAttackGoal, clampToPitch } from "./pitch";
import { passOptions, nearestOpponent, pressureCount } from "./perception";

/**
 * decision — 행동 선택.
 *  - 볼 소유자: {슛, 최적 패스, 드리블, 홀드} 를 [속성+behavior+ctx+config.decisionWeights]
 *    시드 확률로 선택.
 *  - 오프더볼/수비: 역할 basePosition 기반 이동 목표를 계산(전진 런/폭/라인/마크/압박).
 * 모든 무작위성은 인자로 받은 Rng 인스턴스만 사용(전역 없음).
 */

export type PassOutcome = "success" | "fail_intercept" | "fail_out";

export type Action =
  | { kind: "shoot"; xg: number; toX: number; toY: number; detail?: string }
  | { kind: "pass"; receiver: SimPlayer; toX: number; toY: number; outcome: PassOutcome; long: boolean; claimant: SimPlayer | null }
  | { kind: "dribble"; toX: number; toY: number }
  | { kind: "hold" };

/** 극단 behavior(0/1 근처)에 소프트캡 페널티. 0.5 에서 페널티 0. */
function softCapped(b: number, softCap: number): number {
  const extremeness = Math.abs(2 * b - 1);
  return b * (1 - softCap * extremeness);
}

/** 속성 0..100 → 배수(약 0.6..1.4). */
function attrFactor(v: number): number {
  return 0.6 + 0.8 * (v / 100);
}

/**
 * 무상태 결정론 노이즈 [0,1). (seed, playerId, timeBucket) 해시 → 시퀀셜 Rng 를 소모하지 않고
 * 선수·시간별로 재현 가능한 변주값을 준다(오프더볼 오버랩/로밍용). 재개 시에도 tick 만으로 동일.
 */
export function varietyNoise(a: number, b: number, c: number): number {
  let h = 2166136261 >>> 0;
  h = Math.imul(h ^ (a >>> 0), 16777619);
  h = Math.imul(h ^ (b >>> 0), 16777619);
  h = Math.imul(h ^ (c >>> 0), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489909);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** 슛 xG 계산(거리·각도·슈팅속성). */
function computeXg(
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): { xg: number; distM: number } {
  const g = attackGoal(pitch, owner.side);
  const distFx = distToAttackGoal(pitch, owner.side, owner.posFx.x, owner.posFx.y);
  const distM = fromFixed(distFx, config.fixedScale);
  const lateralM = fromFixed(Math.abs(owner.posFx.y - g.y), config.fixedScale);
  const halfH = config.pitch.height / 2;
  const central = fclamp(1 - config.contest.shootAngleFactor * (lateralM / halfH), 0.15, 1);
  let xg = config.contest.xgBase * attrFactor(owner.attrs.shooting);
  xg *= Math.max(0.05, 1 - config.contest.shootDistanceFactor * distM);
  xg *= central;
  xg *= 1 - 0.3 * owner.fatigue;
  return { xg: fclamp(xg, 0.01, 0.9), distM };
}

/**
 * 패스 옵션 점수: 안전(laneDanger)·전진(forwardGain)·거리 종합.
 * (export 는 진단용 — realism/deepen.ts 가 **엔진과 같은 식**으로 옵션을 채점하기 위해 쓴다.
 *  재구현하면 진단과 구현이 같은 실수를 공유한다. 동작 변경 없음.)
 */
export function scoreOption(
  opt: PassOption,
  owner: SimPlayer,
  config: EngineConfig,
  ownerInFinalThird: boolean,
): number {
  const scale = config.fixedScale;
  const safeM = fromFixed(opt.laneDanger, scale);
  const fwdM = fromFixed(opt.forwardGain, scale);
  const distM = fromFixed(opt.dist, scale);
  const directness = owner.behavior.passDirectness;
  const riskTol = owner.behavior.passRisk;
  // 안전도(위험할수록 감점, passRisk 높으면 관대) + 전진 이득 + 거리 페널티.
  let score: number;
  if (opt.long) {
    // 롱(E2): 원거리 롱볼의 큰 전진값이 선택을 지배하지 않게 forwardGain 캡 + 거리 페널티 강화.
    // 그래서 롱은 argmax 를 자동 독점하지 않고, selectBias(×directness)로 시도율(12-15%)을 튜닝.
    const lp = config.longPass;
    const cappedFwd = Math.min(fwdM, lp.fwdCapM);
    score =
      safeM * (1.2 - riskTol) +
      cappedFwd * (0.4 + directness) -
      distM * lp.distPenalty +
      lp.selectBias * (0.3 + directness) * (0.6 + 0.4 * riskTol);
  } else {
    score = safeM * (1.2 - riskTol) + fwdM * (0.4 + directness) - distM * 0.15;
  }
  // 파이널서드(공격 진영) 후진 패스 페널티: 뒤로(음수 forwardGain) 빼는 패스를 감점 →
  // 전진/횡 패스·슛을 우선. directness 높은 선수일수록 후진을 더 싫어함.
  if (ownerInFinalThird && fwdM < 0) {
    score -= -fwdM * config.decisionWeights.backwardPassPenalty * (0.5 + directness);
  }
  return score;
}

/** 공격 방향 정규화 진행도(0:자기골 라인, 1:상대골 라인). */
function attackProgress(pitch: Pitch, side: SimPlayer["side"], x: number): number {
  const frac = x / pitch.wFx;
  return side === "home" ? frac : 1 - frac;
}

/** side 팀 관점에서 (x,y) 최근접 상대 선수. */
function nearestOpponentTo(
  state: SimState,
  side: SimPlayer["side"],
  x: number,
  y: number,
): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side === side) continue;
    const dx = p.posFx.x - x;
    const dy = p.posFx.y - y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * 패스 성공확률(결정론, 순수). = passBase − 전진/파이널서드/압박/거리 페널티 + passing 가감, clamp.
 * planPass 가 이 값으로 성공/실패를 롤한다. 전진·롱·압박 패스가 숏보다 낮게 나오도록 config 로 제어.
 * (E1: 벤치 78–85% 평균 + 전진/롱 < 숏. 단조성은 pass-prob 단위테스트로 계약 박제.)
 */
export function computePassProb(
  state: SimState,
  owner: SimPlayer,
  opt: PassOption,
  config: EngineConfig,
  pitch: Pitch,
): number {
  const c = config.contest;
  const scale = config.fixedScale;
  const receiver = opt.receiver;

  const fwdM = fromFixed(opt.forwardGain, scale);
  const forwardFrac = fclamp(fwdM / 20, 0, 1);
  const inFinalThird =
    attackProgress(pitch, owner.side, receiver.posFx.x) >= config.setPiece.finalThirdLine;
  // 패스 압박은 근접(passPressureRangeM) 상대만 — pressRange(22m, 압박배정용)는 패스엔 과도.
  const pressers = pressureCount(state, owner, config, c.passPressureRangeM);
  const distM = fromFixed(opt.dist, scale);
  const attrBonus = ((owner.attrs.passing - 50) / 50) * c.passAttrSwing;

  let prob = c.passBase;
  prob -= c.passForwardPenalty * forwardFrac;
  prob -= inFinalThird ? c.passFinalThirdPenalty : 0;
  prob -= c.passPressurePenalty * pressers;
  prob -= c.passDistancePenalty * Math.max(0, distM - c.passBaseDistM);
  prob += attrBonus;
  return fclamp(prob, 0.05, 0.98);
}

/**
 * 패스 결과 계획(결정론). 성공확률 = computePassProb.
 * 실패면 인플레이 턴오버(상대 위치로 유도) 또는 아웃오브바운즈(경계 밖으로 유도)로 목표를 바꾼다.
 * → 성공률·파이널서드 페널티를 config 로 직접 제어하고, 턴오버가 전환·움직임을 유발한다.
 */
/** 선수의 이번 틱 이동량(fixed). pace 와 피로 반영. (match 의 act 단계와 동일 식 — 리드패스 예측에도 쓴다.) */
export function speedStep(p: SimPlayer, config: EngineConfig): number {
  const { minPerTick, maxPerTick, fatigueFloor } = config.speed;
  const paceFrac = p.attrs.pace / 100;
  const base = minPerTick + (maxPerTick - minPerTick) * paceFrac;
  const fatigueMult = 1 - (1 - fatigueFloor) * p.fatigue;
  return toFixed(base * fatigueMult, config.fixedScale);
}

/**
 * #181 리드패스 조준 — **지금 있는 자리**가 아니라 **공이 도착할 때 그가 있을 자리**로 찬다.
 *
 * 구버전은 리시버의 현재 위치를 겨냥했다. 공이 날아가는 동안 리시버는 계속 뛰므로 공은 아무도 없는
 * 지점에 떨어졌고, 도착 처리가 그 간극을 순간이동으로 메워 "빈 공간에서 공이 휘는" 궤적이 됐다.
 * (리시버를 낙하점으로 되돌려 달리게 하는 방식은 전진 런을 취소시켜 공격을 죽인다 — 실측 슛/팀 9.6→4.9.)
 *
 * 예측: 비행틱 k ≈ 거리/공속. 리시버가 targetFx 방향으로 k 틱 이동한 지점을 조준.
 * k 가 조준점에 의존하므로 2회 반복해 수렴시킨다(결정론: 전부 고정소수 산술).
 */
function leadAim(
  from: { x: number; y: number },
  mover: SimPlayer,
  ballSpeed: number,
  config: EngineConfig,
  pitch: Pitch,
): { x: number; y: number } {
  const lead = config.movement.passLeadWeight;
  if (lead <= 0 || ballSpeed <= 0) return { x: mover.posFx.x, y: mover.posFx.y };
  const step = speedStep(mover, config);
  let aim = { x: mover.posFx.x, y: mover.posFx.y };
  for (let iter = 0; iter < 2; iter++) {
    const ticks = Math.ceil(fdist(from.x, from.y, aim.x, aim.y) / ballSpeed);
    const travel = Math.round(step * ticks * lead);
    const p = stepToward(mover.posFx.x, mover.posFx.y, mover.targetFx.x, mover.targetFx.y, travel);
    aim = clampToPitch(pitch, p.x, p.y);
  }
  return aim;
}

export function planPass(
  state: SimState,
  owner: SimPlayer,
  opt: PassOption,
  config: EngineConfig,
  rng: Rng,
  pitch: Pitch,
): { toX: number; toY: number; outcome: PassOutcome; claimant: SimPlayer | null } {
  const c = config.contest;
  const scale = config.fixedScale;
  const receiver = opt.receiver;

  const prob = computePassProb(state, owner, opt, config, pitch);

  if (rng.next() < prob) {
    // 리드패스(#181): 리시버가 **도착 시점에 있을 자리**로 찬다 → 공과 사람이 같은 지점에서 만난다.
    const aim = leadAim(owner.posFx, receiver, toFixed(config.ball.passSpeed, scale), config, pitch);
    return { toX: aim.x, toY: aim.y, outcome: "success", claimant: receiver };
  }

  // 실패: 아웃 vs 인플레이 턴오버.
  if (rng.next() < c.passFailOutProb) {
    // 아웃오브바운즈: 수신자에서 가장 가까운 경계 밖으로 유도.
    const rx = receiver.posFx.x;
    const ry = receiver.posFx.y;
    const margin = Math.round(4 * scale);
    const dLeft = rx;
    const dRight = pitch.wFx - rx;
    const dTop = ry;
    const dBottom = pitch.hFx - ry;
    const min = Math.min(dLeft, dRight, dTop, dBottom);
    let toX = rx;
    let toY = ry;
    if (min === dTop) toY = -margin;
    else if (min === dBottom) toY = pitch.hFx + margin;
    else if (min === dLeft) toX = -margin;
    else toX = pitch.wFx + margin;
    // 아웃으로 나가는 공은 아무도 잡지 않는다(경계에서 resolveOut).
    return { toX, toY, outcome: "fail_out", claimant: null };
  }

  // 인플레이 턴오버: 수신자 근처 상대에게 유도(도착 시 상대 컨트롤 → interception).
  // 실제 소유 판정은 resolveArrival 이 passOutcome 을 존중(authoritative)해 상대에게 준다.
  const thief = nearestOpponentTo(state, owner.side, receiver.posFx.x, receiver.posFx.y);
  if (thief) {
    const aim = leadAim(owner.posFx, thief, toFixed(config.ball.passSpeed, scale), config, pitch);
    return { toX: aim.x, toY: aim.y, outcome: "fail_intercept", claimant: thief };
  }
  return { toX: receiver.posFx.x, toY: receiver.posFx.y, outcome: "success", claimant: receiver };
}

/**
 * 패스 후보 선택. decisionTemperature 와 선수 창의성(technical·passRisk)에 따라
 * 상위 K 후보 중 시드 가중 샘플(flair 변주). 온도 0 또는 후보 1개면 argmax(최적 1개, Rng 미소모).
 * → "최적 1개로 수렴" 대신 상위 후보로 선택이 분산되어 시나리오가 다양해진다.
 */
function selectPassOption(
  opts: PassOption[],
  owner: SimPlayer,
  config: EngineConfig,
  rng: Rng,
  ownerInFinalThird: boolean,
): { opt: PassOption | null; score: number } {
  if (opts.length === 0) return { opt: null, score: -Infinity };
  const scored = opts.map((o) => ({ o, s: scoreOption(o, owner, config, ownerInFinalThird) }));
  // 점수 내림차순(동점은 receiver.id 로 안정 정렬 — 결정론).
  scored.sort((a, b) => b.s - a.s || (a.o.receiver.id < b.o.receiver.id ? -1 : 1));
  const temp = config.variety.decisionTemperature;
  const flair = 0.5 * (owner.attrs.technical / 100) + 0.5 * owner.behavior.passRisk;
  const k =
    temp <= 0
      ? 1
      : Math.max(1, Math.min(scored.length, 1 + Math.round(temp * flair * (scored.length - 1))));
  if (k <= 1) {
    const top = scored[0]!;
    return { opt: top.o, score: top.s };
  }
  // 상위 K 후보 가중 샘플. 가중치 = (score - scoreK + eps) — 최적일수록 큼. Rng 1회 소모.
  const floor = scored[k - 1]!.s;
  const eps = 0.5;
  let total = 0;
  for (let i = 0; i < k; i++) total += scored[i]!.s - floor + eps;
  let rr = rng.next() * total;
  for (let i = 0; i < k; i++) {
    rr -= scored[i]!.s - floor + eps;
    if (rr < 0) return { opt: scored[i]!.o, score: scored[i]!.s };
  }
  const top = scored[0]!;
  return { opt: top.o, score: top.s };
}

/** 볼 소유자의 행동 결정(시드 확률). */
export function decideBallOwner(
  state: SimState,
  owner: SimPlayer,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
): Action {
  const w = config.decisionWeights;
  const sc = config.softCap;
  const goal = attackGoal(pitch, owner.side);
  const ownerInFinalThird =
    attackProgress(pitch, owner.side, owner.posFx.x) >= config.setPiece.finalThirdLine;

  // --- 슛 후보(좋은 위치/각도/찬스일 때만; xG 임계 미만 speculative 억제) ---
  const { xg: rawXg, distM } = computeXg(owner, config, pitch);
  // 1대1(단독) 찬스: 슈터 반경 안에 비-GK 상대가 없고 사거리 안이면 xG 부스트 + 하이라이트 표기.
  let xg = rawXg;
  let shootDetail: string | undefined;
  if (config.contest.oneOnOneXgMult > 1 && distM <= config.contest.shootRange) {
    const clearR = config.contest.oneOnOneClearM * config.fixedScale;
    let nonGkNearD = Infinity;
    for (const p of state.players) {
      if (p.side === owner.side || p.isGK) continue;
      const d = fdist(owner.posFx.x, owner.posFx.y, p.posFx.x, p.posFx.y);
      if (d < nonGkNearD) nonGkNearD = d;
    }
    if (nonGkNearD > clearR) {
      xg = fclamp(rawXg * config.contest.oneOnOneXgMult, 0.01, 0.95);
      shootDetail = "one_on_one";
    }
  }
  let wShoot = 0;
  if (distM <= config.contest.shootRange && xg >= config.contest.shootXgThreshold) {
    // 거리 페널티는 xG 에 이미 반영되므로 여기서는 xG 품질만 가중(이중 페널티 방지).
    const quality = fclamp(xg / config.contest.xgBase, 0.25, 1.8);
    wShoot =
      w.shoot *
      (0.25 + softCapped(owner.behavior.shootTendency, sc)) *
      quality *
      attrFactor(owner.attrs.shooting);
    // 파이널서드(공격 진영)의 사거리 슛은 지배적 선택으로 부스트(후진 패스 억제와 짝).
    if (ownerInFinalThird) {
      wShoot *= w.shootInBox;
      // 중앙(골 정면)에 가까울수록 추가 부스트 → 중앙·사거리에서 후진 리사이클 대신 슛.
      const lateralM = fromFixed(Math.abs(owner.posFx.y - goal.y), config.fixedScale);
      const centralFrac = fclamp(1 - lateralM / config.contest.centralShootHalfM, 0, 1);
      wShoot *= 1 + (w.shootCentralBonus - 1) * centralFrac;
    }
    // 1대1(단독 오픈)이면 거의 강제로 슛 → one_on_one 이벤트가 실제로 찍힌다.
    if (shootDetail === "one_on_one") wShoot *= config.contest.oneOnOneShootBias;
  }

  // --- 패스 후보(상위 후보 중 시드 가중 샘플 = flair 변주) ---
  const opts = passOptions(state, owner, config, pitch);
  const picked = selectPassOption(opts, owner, config, rng, ownerInFinalThird);
  const bestOpt = picked.opt;
  let wPass = 0;
  if (bestOpt) {
    // 최소 품질 보정: 좋은 옵션일수록 가중.
    const quality = fclamp(0.3 + picked.score / 40, 0.1, 1.3);
    wPass = w.pass * (0.4 + softCapped(1 - owner.behavior.passRisk * 0.3, sc)) * quality;
  }

  // --- 드리블 후보(전방 공간) ---
  const near = nearestOpponent(state, owner);
  const spaceM = near ? fromFixed(near.dist, config.fixedScale) : config.perceptionRadius;
  const spaceFactor = fclamp(spaceM / config.perceptionRadius, 0.1, 1);
  let wDribble =
    w.dribble *
    (0.25 + softCapped(owner.behavior.dribbleTendency, sc)) *
    spaceFactor *
    attrFactor(owner.attrs.technical) *
    (1 - 0.4 * owner.fatigue);
  // 드리블 체인 모멘텀: 직전 틱 연속 드리블 중이고 최대 길이 미만이면 가중(짧은 패스로 바로 안 빠짐).
  const vr = config.variety;
  if (owner.dribbleStreak > 0 && owner.dribbleStreak < vr.dribbleChainMaxTicks && vr.dribbleChainProb > 0) {
    // 이미 시작한 드리블 런은 공간이 다소 좁아도 이어가고(플로어), 연속 틱이 쌓일수록 더 강하게 밀어붙임.
    const momentum =
      1 +
      vr.dribbleChainProb *
        vr.dribbleChainBonus *
        (0.4 + 0.6 * spaceFactor) *
        attrFactor(owner.attrs.technical) *
        (1 + 0.3 * owner.dribbleStreak);
    wDribble *= momentum;
  }

  // --- 홀드 후보(압박 심하면 안전하게) ---
  const wHold = w.hold * (0.5 + 0.5 * owner.behavior.supportDepth);

  // --- 시드 확률 샘플링 ---
  const total = wShoot + wPass + wDribble + wHold;
  if (total <= 0) return { kind: "hold" };
  let r = rng.next() * total;

  if ((r -= wShoot) < 0) {
    return { kind: "shoot", xg, toX: goal.x, toY: goal.y, detail: shootDetail };
  }
  if ((r -= wPass) < 0 && bestOpt) {
    const plan = planPass(state, owner, bestOpt, config, rng, pitch);
    return {
      kind: "pass",
      receiver: bestOpt.receiver,
      toX: plan.toX,
      toY: plan.toY,
      outcome: plan.outcome,
      long: bestOpt.long,
      claimant: plan.claimant,
    };
  }
  if ((r -= wDribble) < 0) {
    // 골 방향으로 전진하는 드리블 목표(박스 침투 속도 config).
    const step = config.movement.dribbleReach;
    const tx = owner.posFx.x + Math.round((goal.x - owner.posFx.x) * step);
    const ty = owner.posFx.y + Math.round((goal.y - owner.posFx.y) * step);
    const c = clampToPitch(pitch, tx, ty);
    return { kind: "dribble", toX: c.x, toY: c.y };
  }
  return { kind: "hold" };
}

/** side 팀에서 공에 가장 가까운 선수(압박 담당 지정용). */
function closestToBall(state: SimState, side: SimPlayer["side"]): SimPlayer | null {
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side !== side || p.isGK) continue;
    const dx = p.posFx.x - state.ball.posFx.x;
    const dy = p.posFx.y - state.ball.posFx.y;
    const d = dx * dx + dy * dy;
    if (d < bestD) {
      bestD = d;
      best = p;
    }
  }
  return best;
}

/**
 * 선수가 "코너 때 올라가려는" 성향(0..1). 프롬프트가 만든 behavior 에서 파생한다 —
 * 침투 빈도(forwardRunFreq)와 공격 가담 깊이(supportDepth)가 곧 세트피스 가담 의사다.
 * (전용 필드는 계약 확장 시 여기만 갈아끼우면 된다 — #182 후속.)
 */
function cornerRunTendency(p: SimPlayer): number {
  return 0.5 * p.behavior.forwardRunFreq + 0.5 * p.behavior.supportDepth;
}

/**
 * 팀의 코너 가담도(0=최대한 남긴다 … 1=올인). 수비 기조(라인 높이)·템포에서 파생 —
 * 라인을 낮게 쓰는 팀은 코너에서도 뒤를 더 남기고, 하이라인·고템포 팀은 더 올라간다.
 * 즉 **팀마다 기본값이 다르고, 전술을 바꾸면 코너 배치도 같이 바뀐다**(hero 확정 구조).
 */
function teamCornerCommit(team: SimState["teams"]["home"], cn: EngineConfig["setPiece"]["corner"]): number {
  const v =
    0.5 + (team.defensiveLineHeight - 0.5) * cn.commitLineWeight + (team.tempo - 0.5) * cn.commitTempoWeight;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * 코너 때 "얼마나 올라가고 싶은가" 점수. 클수록 박스로 간다.
 * = 포메이션 슬롯 깊이(자연 순서: ST > 미드 > 풀백 > CB) + 프롬프트 오버라이드.
 * playerOverrideWeight 가 충분히 크면 성향이 슬롯 순서를 **뒤집는다** — 원래 남을 CB 가
 * 올라가고("코너 때 올라가라"), 원래 올라갈 공격수가 남는다("뒤를 봐라").
 */
function cornerGoScore(pitch: Pitch, p: SimPlayer, cn: EngineConfig["setPiece"]["corner"]): number {
  return attackProgress(pitch, p.side, p.baseFx.x) + (cornerRunTendency(p) - 0.5) * cn.playerOverrideWeight;
}

/**
 * 코너 시 박스에 안 들어가고 남는 선수의 **그룹 내 순위**. 남지 않으면 -1.
 *  - 공격팀(attacking=true): cornerGoScore 가 가장 **낮은** N명 = rest defence.
 *  - 수비팀(attacking=false): 가장 **높은** N명 = 하이 아웃렛.
 * N 은 상수가 아니라 팀 가담도에서 매핑된다(teamCornerCommit).
 * 테이커(공 소유자)는 코너 아크에 있으므로 후보에서 제외 → 잔류 인원이 그만큼 줄지 않는다.
 * 결정론: 점수 → idHash → id 의 전순서로만 뽑는다(전역 난수·시각 의존 없음).
 *
 * 순위를 반환하는 이유(#182 폴리시): 호출부가 순위로 깊이를 **균등 배분**해 잔류가 한 줄로
 * 겹치지 않게 한다. idHash 난수 편차로 벌리면 특정 선수쌍이 우연히 충돌해(실측 11/52 코너가
 * 0.5m 미만으로 겹침) 그 팀은 매 코너 일자 정렬이 된다 — 순위 배분은 충돌이 구조적으로 없다.
 */
function cornerHolderRank(
  state: SimState,
  player: SimPlayer,
  pitch: Pitch,
  config: EngineConfig,
  attacking: boolean,
): { rank: number; count: number } {
  const miss = { rank: -1, count: 0 };
  const cn = config.setPiece.corner;
  if (!cn.enabled || player.isGK || isBallOwner(state, player)) return miss;
  const commit = teamCornerCommit(state.teams[player.side], cn);
  // 공격팀: 가담도가 높을수록 적게 남긴다(Max→Min). 수비팀: 높을수록 많이 올려둔다(Min→Max).
  const count = attacking
    ? Math.round(cn.stayBackMax + (cn.stayBackMin - cn.stayBackMax) * commit)
    : Math.round(cn.leaveHighMin + (cn.leaveHighMax - cn.leaveHighMin) * commit);
  if (count <= 0) return miss;
  const mine = cornerGoScore(pitch, player, cn);
  let ahead = 0;
  for (const p of state.players) {
    if (p.side !== player.side || p.isGK || p.id === player.id) continue;
    if (isBallOwner(state, p)) continue;
    const r = cornerGoScore(pitch, p, cn);
    // 동률(예: LCB/RCB 가 슬롯·성향 모두 같음)은 idHash → id 로 안정 정렬.
    const tie = p.idHash !== player.idHash ? p.idHash < player.idHash : p.id < player.id;
    const better = r === mine ? tie : attacking ? r < mine : r > mine;
    if (better && ++ahead >= count) return miss;
  }
  return { rank: ahead, count };
}

/**
 * 오프더볼/수비 이동 목표 계산. player.targetFx 를 설정.
 * (볼 소유자는 match 에서 행동에 따라 별도 처리)
 */
export function decideOffBall(
  state: SimState,
  player: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
  pressAssignee: SimPlayer | null,
): void {
  const scale = config.fixedScale;
  const mv = config.movement;
  const team = state.teams[player.side];
  const sign = player.side === "home" ? 1 : -1;
  const g = attackGoal(pitch, player.side);
  const ownGoal = defendGoal(pitch, player.side);
  const ball = state.ball;
  const center = Math.round(pitch.hFx / 2);

  // GK: 자기 골대 앞에서 공 y 를 살짝 추종.
  if (player.isGK) {
    const gy = fclamp(
      ownGoal.y + Math.round((ball.posFx.y - ownGoal.y) * 0.3),
      Math.round(pitch.hFx * 0.35),
      Math.round(pitch.hFx * 0.65),
    );
    const gx = ownGoal.x + sign * Math.round(pitch.wFx * 0.04);
    player.targetFx = clampToPitch(pitch, gx, gy);
    return;
  }

  // --- 루즈볼 쟁탈(#181): 주인 없이 **멈춰 있는** 공은 가서 주워야 한다 ---
  // 공은 손 닿는 사람에게만 간다(resolveArrival) → 아무도 없으면 떨어진 자리에 정지한다.
  // 그때 아무도 안 가면 경기가 멈춘다(실측: 패스성공 19%·슛 1.7). 계획된 수신자(claimant)와
  // 양 팀 최근접 아웃필더가 공으로 향한다 = 실제 축구의 루즈볼 경합.
  // 패스 **비행 중**(kind="pass")에는 걸리지 않는다 — 날아가는 공을 향해 되돌아 달리면 전진 런이
  // 취소돼 공격이 죽는다(실측 슛/팀 9.6→4.9). 도착 후 굴러가는 국면(kind="loose")에만 적용.
  const loose = ball.flight;
  if (loose && loose.kind === "loose" && ball.owner == null) {
    const mine = closestToBall(state, player.side);
    // #231: claimant 는 상대일 수도 있다 — id 만 비교하면 같은 id 의 우리 팀 선수가 남의 공을 주우러 간다.
    const claimedByMe = loose.claimant === player.id && claimantSideOf(loose) === player.side;
    if (claimedByMe || (!loose.claimant && mine && mine.id === player.id)) {
      player.targetFx = clampToPitch(pitch, ball.posFx.x, ball.posFx.y);
      return;
    }
  }

  // --- 세트피스(코너) 박스 크라우딩: 공수 양팀 모두 해당 골 박스로 몰림 ---
  const sp = state.setPiece;
  if (sp && sp.kind === "corner") {
    const attackingCorner = sp.side === player.side;
    // #182: 전원이 박스로 올라가지 않는다 — 공격팀은 rest defence 로 뒤에, 수비팀은 아웃렛으로
    // 앞에 남는 인원이 있다. 인원은 팀 전략에서, 누가 남는지는 선수 성향(프롬프트)에서 나온다.
    const cn = config.setPiece.corner;
    const hold = cornerHolderRank(state, player, pitch, config, attackingCorner);
    if (hold.rank >= 0) {
      const lineX = attackingCorner ? cn.stayBackLineX : cn.leaveHighLineX;
      // 한 줄로 세우지 않는다(#182 폴리시): ①슬롯 깊이를 일부 보존해 역할 층을 만들고
      // (CB 가 풀백보다 뒤) ②그룹 내 순위로 깊이를 균등 배분해 동일 슬롯끼리도 겹치지 않게.
      const baseProg = attackProgress(pitch, player.side, player.baseFx.x);
      const centered = hold.rank - (hold.count - 1) / 2; // 그룹 중심 기준 ±
      const prog = lineX + (baseProg - lineX) * cn.slotSpread + centered * cn.jitterX;
      const hx = player.side === "home" ? prog : 1 - prog;
      player.targetFx = clampToPitch(pitch, Math.round(hx * pitch.wFx), player.baseFx.y);
      return;
    }
    const boxGoal = attackingCorner ? g : ownGoal;
    const pull = config.setPiece.cornerBoxReach;
    const cx = boxGoal.x + Math.round((player.baseFx.x - boxGoal.x) * (1 - pull));
    // 박스 폭으로 벌려 세움(base y 편차를 절반으로).
    const cy = center + Math.round((player.baseFx.y - center) * 0.6);
    player.targetFx = clampToPitch(pitch, cx, cy);
    return;
  }

  let tx = player.baseFx.x;
  let ty = player.baseFx.y;
  const attacking = state.possession === player.side;

  if (attacking) {
    // 전진 런: 역할 위치에서 골 방향으로.
    const runFrac = mv.forwardRunReach * player.behavior.forwardRunFreq;
    tx += Math.round((g.x - player.baseFx.x) * runFrac);
    // 인포제션 폭 확장: 자기 반쪽 기준 바깥으로 벌림.
    // 정확히 중앙(y=center) 선수(4-3-3 의 ST·CM)는 idHash 패리티로 좌/우 분배 — 구 `<center?-1:1` 은
    // 중앙 선수를 항상 +y(아래)로 밀어 공격이 하프 아래로 쏠렸다(슛 96%·코너 98.6% 편중 → 코너 반복
    // 단조로움, #25). idHash 패리티는 결정론을 유지하며(전역 난수 미사용) 좌우 균형을 회복한다.
    const widthDir = player.baseFx.y < center ? -1 : player.baseFx.y > center ? 1 : ((player.idHash & 1) ? 1 : -1);
    ty += widthDir * Math.round(pitch.hFx * mv.attackWidthReach * player.behavior.widthTendency);
    // 팀 업필드 push: 볼 x 를 따라 라인 전진 → length 압축 + 다이내믹(제자리 방지).
    tx += Math.round((ball.posFx.x - player.baseFx.x) * mv.attackLinePush);
    // 지원: 공 쪽으로 약하게 당김.
    tx += Math.round((ball.posFx.x - tx) * mv.supportPull * player.behavior.supportDepth);
    ty += Math.round((ball.posFx.y - ty) * mv.supportPull * player.behavior.supportDepth);
    // roam: positioningFreedom 이 크면 공쪽으로 더.
    tx += Math.round((ball.posFx.x - tx) * mv.roamFactor * player.behavior.positioningFreedom);
    // 수비/풀백 오버랩: 시드 노이즈가 임계 미만이면 여러 틱 동안 라인 위로 전진(뒤 공간 노출 리스크).
    const vr = config.variety;
    const baseProg = attackProgress(pitch, player.side, player.baseFx.x);
    if (vr.defenderOverlapProb > 0 && baseProg < vr.overlapBaseLine) {
      const obucket = Math.floor(state.tick / Math.max(1, vr.overlapPeriodTicks));
      const on = varietyNoise((state.seedHash ^ 0x9e3779b9) >>> 0, player.idHash, obucket);
      const drive = 0.5 * team.tempo + 0.5 * team.defensiveLineHeight;
      const thresh = vr.defenderOverlapProb * (0.5 + player.behavior.widthTendency) * (0.5 + drive);
      if (on < thresh) {
        tx += Math.round((g.x - player.baseFx.x) * vr.overlapReach);
        ty += widthDir * Math.round(pitch.hFx * mv.attackWidthReach * (0.5 + player.behavior.widthTendency));
      }
    }
  } else {
    // 수비 블록: 볼 x 뒤쪽(자기 골 방향)을 중심으로 팀 전체를 압축(미드블록).
    const lineShift = (team.defensiveLineHeight - 0.5) * pitch.wFx * 0.2;
    const blockCenterX = ball.posFx.x - sign * Math.round(pitch.wFx * 0.06) + sign * Math.round(lineShift);
    const compact = 0.5 + team.compactness;
    tx += Math.round((blockCenterX - player.baseFx.x) * mv.defendCompactX * compact);
    // 폭: 블록으로 좁힘(볼 y 쪽으로 수축).
    const widthDir = player.baseFx.y < center ? -1 : player.baseFx.y > center ? 1 : ((player.idHash & 1) ? 1 : -1);
    ty += widthDir * Math.round(pitch.hFx * mv.defendWidthReach * player.behavior.widthTendency);
    ty += Math.round((ball.posFx.y - ty) * mv.defendCompactY * compact);

    // 마크: 시야 계층이 켜져 있으면 아래에서 가치 기반으로 처리한다(#147 W3) — markTarget 은
    // 하드 오버라이드가 아니라 **강한 가산**(vision.markTargetBias)으로만 작용한다.
    // 시야가 꺼져 있으면(롤백) 레거시 하드 오버라이드를 그대로 쓴다 — 안 그러면 롤백 스위치가
    // markTarget(정식 AI 마킹 지시 경로)을 **완전 무음 no-op** 으로 만들어 "롤백" 이 아니게 된다.
    if (!config.vision.enabled && player.markTarget) {
      // #231: 마킹 대상은 **상대**다. id 단독 조회면 같은 id 의 우리 팀 선수를 마크하게 된다.
      const mark = playerAt(state, otherSide(player.side), player.markTarget);
      if (mark) {
        const gap = mv.markGap * scale;
        const dx = ownGoal.x - mark.posFx.x;
        const dy = ownGoal.y - mark.posFx.y;
        const len = Math.max(1, Math.round(Math.sqrt(dx * dx + dy * dy)));
        tx = mark.posFx.x + Math.round((dx * gap) / len);
        ty = mark.posFx.y + Math.round((dy * gap) / len);
      }
    }

    // 압박: 지정된 최근접 수비수이고 압박 성향이면 공으로 돌진.
    if (
      pressAssignee &&
      pressAssignee.id === player.id &&
      player.behavior.pressAggression * team.pressingScheme.intensity > 0.15
    ) {
      tx = ball.posFx.x;
      ty = ball.posFx.y;
    }
  }

  // --- 시야 기반 인지·판단 (#147 W3) ---
  // 인지: 주의 예산만큼만 정밀 추적(기억 갱신), 나머지는 마지막 본 위치로 판단하고 오래되면 잊는다.
  // 판단: 수비 시 아는 상대 전원에게 끌리지 않고, 위협도−도달비용이 가장 큰 **한 명만** 고른다.
  const vis = config.vision;
  if (vis.enabled) {
    const known = perceiveOpponents(state, player, config);
    let px = 0;
    let py = 0;
    if (attacking) {
      // 공격: 아는 상대들에게서 밀려나 공간을 찾는다(가까울수록 강하게).
      const radFx = vis.radiusM * scale;
      for (const k of known) {
        const w = Math.round(vis.spaceReach * scale * (1 - k.dist / radFx));
        if (w <= 0) continue;
        px += Math.round(((player.posFx.x - k.x) * w) / k.dist);
        py += Math.round(((player.posFx.y - k.y) * w) / k.dist);
      }
    } else {
      // 수비: 붙을 가치가 가장 큰 상대 하나만.
      const target = chooseMarkTarget(known, player, config, ownGoal);
      if (target) {
        const radFx = vis.radiusM * scale;
        // 당김은 **고정 길이 스텝**이라 그대로 두면 이미 붙어 있는 마크를 지나쳐 반대편을 목표로
        // 잡는다 → 다음 틱엔 방향이 뒤집혀 매 틱 ±markReach 왕복(제자리 진동, #178). 게다가
        // w 는 가까울수록 커져서(1 − dist/rad) 진동을 키운다. 그래서 **마크 간격(markGap)까지만**
        // 당긴다 — 이미 그 안이면 당기지 않는다(스탠드오프). 시야 판단은 그대로 유지된다.
        //
        // ⚠️ 잔여(독립 QA 발견, QA #25 후속): 이 클램프는 진폭을 3~5m → ~1.1m 로 줄이지만
        // markGap 경계에서 **주기-2 리밋사이클**이 남는다(링 밖=당김, 링 위=당김 0 → 블록 목표가
        // 도로 밀어냄). 근본 해소는 마킹을 "당김 델타" 가 아니라 **위치 목표**(마크의 자기골 쪽
        // markGap 지점)로 재정식화해야 한다 — 결과 목표를 링 위로 미는 방식은 시도했으나
        // (tx − mark) 방향이 이미 마크를 지나쳐 있어 원래 오버슛을 재현했다(bigReversal 43.5로 복귀).
        const standoff = Math.max(0, target.dist - Math.round(mv.markGap * scale));
        const w = Math.min(Math.round(vis.markReach * scale * (1 - target.dist / radFx)), standoff);
        if (w > 0) {
          px -= Math.round(((player.posFx.x - target.x) * w) / target.dist);
          py -= Math.round(((player.posFx.y - target.y) * w) / target.dist);
        }
      }
    }
    tx += px;
    ty += py;
  }

  // --- 포지셔널 로밍: 시드 노이즈로 목표 위치에 시간가변 오프셋(슬롯 고착 방지, 팀 형태는 유지) ---
  const rn = config.variety.roamNoiseAmp;
  if (rn > 0) {
    const bucket = Math.floor(state.tick / Math.max(1, config.variety.roamPeriodTicks));
    const nx = varietyNoise(state.seedHash, player.idHash, bucket * 2 + 1);
    const ny = varietyNoise(state.seedHash, player.idHash, bucket * 2 + 2);
    const ampFx = Math.round(rn * scale * player.behavior.positioningFreedom);
    tx += Math.round((nx * 2 - 1) * ampFx);
    ty += Math.round((ny * 2 - 1) * ampFx);
  }

  player.targetFx = clampToPitch(pitch, tx, ty);
}

/** 시야 기억에서 복원한 "이 선수가 아는 상대" 하나. 위치는 마지막으로 본 값(정확하지만 낡을 수 있음). */
export interface KnownOpponent {
  id: string;
  /** 마지막으로 본 위치(fixed). */
  x: number;
  y: number;
  /** 자기 위치에서 그 기억 위치까지 거리(fixed). */
  dist: number;
  /** 그 기억이 몇 틱 낡았는지(0 = 이번 틱에 봄). */
  age: number;
}

/**
 * 이 선수의 주의 예산(1틱에 정밀 추적할 상대 수). 인지 속성(positioning·mental)으로 가감한다.
 * 스탯이 **시야 반경을 넓히는 게 아니라 주의를 늘린다** — 반경은 실측상 몰림/동조의 레버가 아니었고,
 * 조사에서도 능력치는 콘 길이가 아니라 스캔 예산·기억 유지에 거는 것이 권장됐다.
 */
function attentionBudget(player: SimPlayer, config: EngineConfig): number {
  const v = config.vision;
  const aware = fclamp((player.attrs.positioning + player.attrs.mental) / 200, 0, 1);
  const n = Math.round(v.attentionBase + v.attentionAttrSwing * (aware * 2 - 1));
  return Math.max(1, n);
}

/**
 * 인지 단계. 반경 안 상대를 가까운 순으로 **주의 예산만큼만** 정밀 추적해 기억을 갱신하고,
 * 판단에는 **기억만** 쓴다(정밀 추적 못 한 상대는 마지막 본 위치 = 낡은 정보). memoryTicks 를
 * 넘긴 기억은 버린다. 이 구조 때문에 같은 상황에서도 선수마다 아는 것이 달라진다.
 *
 * 결정론: state.players 순회 순서 + id 안정 정렬만 사용(Map 순회 의존 없음), 전역 난수 없음.
 */
export function perceiveOpponents(
  state: SimState,
  player: SimPlayer,
  config: EngineConfig,
): KnownOpponent[] {
  const v = config.vision;
  const scale = config.fixedScale;
  const radFx = v.radiusM * scale;

  // 반경 안 상대를 거리순(동률은 id)으로 — 결정론 안정 정렬.
  const inRange: { p: SimPlayer; d: number }[] = [];
  for (const o of state.players) {
    if (o.side === player.side) continue;
    const d = fdist(player.posFx.x, player.posFx.y, o.posFx.x, o.posFx.y);
    if (d === 0 || d > radFx) continue;
    inRange.push({ p: o, d });
  }
  inRange.sort((a, b) => a.d - b.d || (a.p.id < b.p.id ? -1 : 1));

  // 주의 예산 안 = 정밀 인지 → 기억 갱신.
  // 방어: 소비자가 스키마에 seen 을 선언하지 않으면 undefined 로 들어온다(zod strip). 크래시 대신
  // 빈 기억으로 복구하되, **이 경로를 타면 재개 동일성이 깨진다**(기억 유실 = 무음 desync).
  // 표현은 Record 라 JSON 왕복 자체는 안전하므로, 남은 건 소비자 스키마 선언뿐이다(#154).
  if (!player.seen) player.seen = {};
  const budget = attentionBudget(player, config);
  for (let i = 0; i < inRange.length && i < budget; i++) {
    const r = inRange[i]!;
    player.seen[r.p.id] = { x: r.p.posFx.x, y: r.p.posFx.y, tick: state.tick };
  }

  // 판단 입력 = 기억. 낡은 기억은 폐기하고, 반경 밖으로 기억된 상대도 제외.
  const known: KnownOpponent[] = [];
  for (const o of state.players) {
    if (o.side === player.side) continue;
    const m = player.seen[o.id];
    if (!m) continue;
    const age = state.tick - m.tick;
    if (age > v.memoryTicks) continue;
    const d = fdist(player.posFx.x, player.posFx.y, m.x, m.y);
    if (d === 0 || d > radFx) continue;
    known.push({ id: o.id, x: m.x, y: m.y, dist: d, age });
  }
  return known;
}

/**
 * 판단 단계. "붙는 게 이득인가" 를 물어 **한 명만** 고른다(아는 상대 전원에게 끌리지 않는다).
 *   가치 = 위협도(내 골에 가까울수록 큼) − 도달비용(멀수록 큼) + markTarget 가산
 * markTarget(AI 전담 지시)은 하드 오버라이드가 아니라 이 가산으로만 작용한다 — 지시는 먹히되
 * 도달비용이 과하면 붙지 않는다. 아무 대상도 가치가 없으면 null(자기 위치를 지킨다).
 */
export function chooseMarkTarget(
  known: KnownOpponent[],
  player: SimPlayer,
  config: EngineConfig,
  ownGoal: { x: number; y: number },
): KnownOpponent | null {
  const v = config.vision;
  const scale = config.fixedScale;
  let best: KnownOpponent | null = null;
  let bestVal = 0; // 0 이하면 붙을 가치 없음 → 자리 지킴
  for (const k of known) {
    const threatFx = -fdist(k.x, k.y, ownGoal.x, ownGoal.y); // 내 골에 가까울수록 큼(음수, 덜 음수가 위협)
    const costFx = k.dist * v.markCostWeight;
    const biasFx = player.markTarget === k.id ? v.markTargetBias * scale : 0;
    // 피치 대각(≈125m) 기준으로 위협을 양수화해 비교 가능하게.
    const val = threatFx - costFx + biasFx + v.markValueBaseM * scale;
    if (val > bestVal) {
      bestVal = val;
      best = k;
    }
  }
  return best;
}

/** side 팀의 압박 담당(공 최근접) 지정. */
export function assignPresser(state: SimState, side: SimPlayer["side"]): SimPlayer | null {
  return closestToBall(state, side);
}
