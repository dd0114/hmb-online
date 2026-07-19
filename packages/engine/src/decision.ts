import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { PassOption } from "./perception";
import { fromFixed, fclamp, fdist } from "./fixedmath";
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
  | { kind: "pass"; receiver: SimPlayer; toX: number; toY: number; outcome: PassOutcome; long: boolean }
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
function varietyNoise(a: number, b: number, c: number): number {
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

/** 패스 옵션 점수: 안전(laneDanger)·전진(forwardGain)·거리 종합. */
function scoreOption(
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
export function planPass(
  state: SimState,
  owner: SimPlayer,
  opt: PassOption,
  config: EngineConfig,
  rng: Rng,
  pitch: Pitch,
): { toX: number; toY: number; outcome: PassOutcome } {
  const c = config.contest;
  const scale = config.fixedScale;
  const receiver = opt.receiver;

  const prob = computePassProb(state, owner, opt, config, pitch);

  if (rng.next() < prob) {
    return { toX: receiver.posFx.x, toY: receiver.posFx.y, outcome: "success" };
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
    return { toX, toY, outcome: "fail_out" };
  }

  // 인플레이 턴오버: 수신자 근처 상대에게 유도(도착 시 상대 컨트롤 → interception).
  // 실제 소유 판정은 resolveArrival 이 passOutcome 을 존중(authoritative)해 상대에게 준다.
  const thief = nearestOpponentTo(state, owner.side, receiver.posFx.x, receiver.posFx.y);
  if (thief) {
    return { toX: thief.posFx.x, toY: thief.posFx.y, outcome: "fail_intercept" };
  }
  return { toX: receiver.posFx.x, toY: receiver.posFx.y, outcome: "success" };
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

  // --- 세트피스(코너) 박스 크라우딩: 공수 양팀 모두 해당 골 박스로 몰림 ---
  const sp = state.setPiece;
  if (sp && sp.kind === "corner") {
    const attackingCorner = sp.side === player.side;
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
    const widthDir = player.baseFx.y < center ? -1 : 1;
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
    const widthDir = player.baseFx.y < center ? -1 : 1;
    ty += widthDir * Math.round(pitch.hFx * mv.defendWidthReach * player.behavior.widthTendency);
    ty += Math.round((ball.posFx.y - ty) * mv.defendCompactY * compact);

    // 마크: 지정 상대 뒤(자기 골 쪽)에 붙는다.
    if (player.markTarget) {
      const mark = state.byId.get(player.markTarget);
      if (mark) {
        const gap = mv.markGap * scale;
        // 상대와 자기 골 사이.
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

/** side 팀의 압박 담당(공 최근접) 지정. */
export function assignPresser(state: SimState, side: SimPlayer["side"]): SimPlayer | null {
  return closestToBall(state, side);
}
