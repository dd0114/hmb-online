import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import { playerAt, otherSide, claimantSideOf, isBallOwner, restartRequiresKick } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { PassOption } from "./perception";
import { fromFixed, fclamp, fdist, toFixed, stepToward, isqrt } from "./fixedmath";
import { attackGoal, attackProgressX, defendGoal, distToAttackGoal, clampToPitch } from "./pitch";
import { passOptions, nearestOpponent, pressureCount, pressureCountAt } from "./perception";
import { aimErrorDeg, aimWithError, deliverySpeedFx, isLofted, overhitOut, passPowerFx, shotPowerFx } from "./kick";
import { planReadObserver } from "./action";

/**
 * decision — 행동 선택.
 *  - 볼 소유자: {슛, 최적 패스, 드리블, 홀드} 를 [속성+behavior+ctx+config.decisionWeights]
 *    시드 확률로 선택.
 *  - 오프더볼/수비: 역할 basePosition 기반 이동 목표를 계산(전진 런/폭/라인/마크/압박).
 * 모든 무작위성은 인자로 받은 Rng 인스턴스만 사용(전역 없음).
 */

export type PassOutcome = "success" | "fail_intercept" | "fail_out";

/**
 * 볼 소유자의 행동. `speedFx`/`lofted` 는 #312/#306 에서 추가됐다 —
 * **행동이 공의 물리를 결정한다**(구버전은 match.ts 가 config 상수를 대입했다).
 */
/**
 * 캐리어가 **아직 안 찼을 때** 사슬이 계산해 둔 최상위 패스 후보(#369).
 * `hold`/`dribble` 에만 붙는다 — 찬 행동은 그 자체가 의도다.
 * 이걸 `match.ts` 가 `intents` 에 예고로 올리고, 동료가 능력만큼 읽는다.
 */
export interface PassForecast {
  receiverId: string;
  toX: number;
  toY: number;
  speedFx: number;
}

export type Action =
  | { kind: "shoot"; xg: number; toX: number; toY: number; speedFx: number; detail?: string }
  | {
      kind: "pass";
      receiver: SimPlayer;
      toX: number;
      toY: number;
      outcome: PassOutcome;
      long: boolean;
      claimant: SimPlayer | null;
      /** #312: 이 패스의 세기(fixed m/tick). */
      speedFx: number;
      /** #306: 띄운 공인가(도착 시 헤딩 경합). */
      lofted: boolean;
    }
  | { kind: "dribble"; toX: number; toY: number; forecast?: PassForecast }
  /**
   * 걷어내기(#314 A) — hero ⓐ. **의도 수신자가 없다**: `passOutcome`/`claimant` 를 달지 않고
   * 도착은 순수 기하(양 팀 루즈볼·헤딩 경합)로 간다. 그래서 패스 성공률 캘리브레이션
   * (`passOutcomeAuthoritative`, 벤치 78–85%)을 건드리지 않는다.
   */
  | { kind: "clearance"; toX: number; toY: number; speedFx: number; lofted: boolean }
  | { kind: "hold"; forecast?: PassForecast };

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

/**
 * 임의의 지점에서의 슛 xG(순수 기하 + 슈팅속성 + 피로). computeXg 가 이 함수를 호출하므로
 * 기존 동작과 bit-identical 이며, 사슬 탐색(chain.ts)이 "이 지점까지 가면 얼마나 위협적인가"를
 * **엔진과 같은 식으로** 평가하는 데 재사용한다(재구현 금지 — 진단이 구현과 같은 실수를 공유한다).
 */
export function xgAtPoint(
  side: SimPlayer["side"],
  xFx: number,
  yFx: number,
  shooting: number,
  fatigue: number,
  config: EngineConfig,
  pitch: Pitch,
): { xg: number; distM: number } {
  const g = attackGoal(pitch, side);
  const distFx = distToAttackGoal(pitch, side, xFx, yFx);
  const distM = fromFixed(distFx, config.fixedScale);
  const lateralM = fromFixed(Math.abs(yFx - g.y), config.fixedScale);
  const halfH = config.pitch.height / 2;
  const central = fclamp(1 - config.contest.shootAngleFactor * (lateralM / halfH), 0.15, 1);
  let xg = config.contest.xgBase * attrFactor(shooting);
  xg *= Math.max(0.05, 1 - config.contest.shootDistanceFactor * distM);
  xg *= central;
  xg *= 1 - 0.3 * fatigue;
  return { xg: fclamp(xg, 0.01, 0.9), distM };
}

/**
 * 1대1(단독) 찬스 판정 — 슈터 반경(`contest.oneOnOneClearM`) 안에 비-GK 상대가 없고 사거리
 * (`contest.shootRange`) 안이면 xG 부스트(`oneOnOneXgMult`) + 하이라이트 표기(`detail="one_on_one"`).
 *
 * **두 코어(weighted / chain)가 같은 함수를 쓴다** — 재구현하면 기하가 갈린다. 산술은 구
 * `decideBallOwner` 인라인 판정과 **bit-identical**(추출만 했다).
 *
 * ⚠️ **실제 상태의 슈터 자리에서만** 부를 것(#316). `chain.ts` 의 생성기는 `bestEvAt`/`arrivalHypo`
 * 를 통해 **가상 도착 지점**에서도 돌기 때문에, 거기서 1v1 기하를 재면 "상대가 그때까지 안
 * 움직인다"는 가정이 EV 에 심긴다. 그래서 chain 은 루트에서 한 번만 부른다.
 */
export function oneOnOneShot(
  state: SimState,
  owner: SimPlayer,
  rawXg: number,
  distM: number,
  config: EngineConfig,
): { xg: number; detail?: string } {
  if (!(config.contest.oneOnOneXgMult > 1) || distM > config.contest.shootRange) return { xg: rawXg };
  const clearR = config.contest.oneOnOneClearM * config.fixedScale;
  let nonGkNearD = Infinity;
  for (const p of state.players) {
    if (p.side === owner.side || p.isGK) continue;
    const d = fdist(owner.posFx.x, owner.posFx.y, p.posFx.x, p.posFx.y);
    if (d < nonGkNearD) nonGkNearD = d;
  }
  if (nonGkNearD > clearR) {
    return { xg: fclamp(rawXg * config.contest.oneOnOneXgMult, 0.01, 0.95), detail: "one_on_one" };
  }
  return { xg: rawXg };
}

/**
 * 압박 아래 슛의 **질 저하**(#353) — 실행되는 슛의 xG 에 근접 압박 1명당 `shotPressureXgMult`.
 *
 * `oneOnOneShot` 과 **같은 축의 반대편**이다(완전 자유 → 부스트 / 붙음 → 감산). 그래서 같은 규율을
 * 따른다: **실제 상태의 슈터 자리에서, 루트에서 한 번만** 부르고 **EV(선택)에는 넣지 않는다**.
 * 가상 도착 지점에서 압박을 재면 "상대가 그때까지 안 움직인다"를 EV 에 심는 것이라 #316 이
 * 이미 기각한 함정이다. 두 코어(weighted/chain)가 같은 함수를 쓴다 — 재구현하면 기하가 갈린다.
 */
export function shotPressureXg(
  state: SimState,
  owner: SimPlayer,
  xg: number,
  config: EngineConfig,
): number {
  const c = config.contest;
  if (!(c.shotPressureXgMult < 1)) return xg;
  const pressers = pressureCount(state, owner, config, c.passPressureRangeM);
  if (pressers <= 0) return xg;
  let v = xg;
  // 정수 지수 반복곱 — `Math.pow` 는 명세상 구현 근사라 결정론 계약에서 금지(§2-5).
  for (let i = 0; i < pressers; i++) v *= c.shotPressureXgMult;
  return fclamp(v, 0.01, 0.95);
}

/**
 * 슛 실행 계획(#312 S5-B) — 세기와 조준점.
 *
 * 구버전은 **속도 상수(`shotBallSpeed` 14) + 골 중앙 정조준**이었다. 슛도 패스와 같은 축을 탄다:
 * shooting 능력치가 세기를 정하고, 조준은 각도 오차만큼 흔들린다.
 *
 * 조준점의 y 는 **골포스트 안쪽으로 클램프**한다 — 유효/빗나감 판정은 `resolveShot` 의 xG·
 * onTarget 롤이 소유하고 있고(그게 밸런스 노브다), 여기서 조준을 골문 밖으로 내보내면 그 판정을
 * 기하가 몰래 덮어써 캘리브레이션이 이중이 된다. 지금 바꾸는 것은 "골문 어디로 가는가"뿐이다.
 * (슛 **출발 지점**의 분산은 S5 소관 — `contest.shotAimSpreadM`.)
 */
export function planShot(
  state: SimState,
  owner: SimPlayer,
  config: EngineConfig,
  rng: Rng,
  pitch: Pitch,
): { toX: number; toY: number; speedFx: number } {
  const c = config.contest;
  const scale = config.fixedScale;
  const g = attackGoal(pitch, owner.side);
  const speedFx = shotPowerFx(owner.attrs.shooting, config);
  // #353: 슛도 패스와 같은 축으로 압박에 흔들린다(`passPressureAimPenalty` 관용구).
  // ⚠️ 이건 **연출**이다 — 아래 클램프가 조준점을 골포스트 안으로 되돌리고, 유효슛/골은
  // `resolveShot` 의 롤이 정한다. 압박의 **결과** 반영은 `shotPressureXg` 가 한다.
  const pressers = pressureCount(state, owner, config, c.passPressureRangeM);
  const deg = aimErrorDeg(
    c.shotAimErrorDeg,
    owner.attrs.shooting,
    c.passAimAttrSwing,
    pressers,
    c.shotPressureAimPenalty,
  );
  const hit = aimWithError(owner.posFx.x, owner.posFx.y, g.x, g.y, { errDeg: deg, powerErrFrac: 0 }, rng);
  const halfPost = toFixed(config.pitch.goalWidth / 2, scale);
  return {
    toX: g.x,
    toY: fclamp(hit.y, g.y - halfPost, g.y + halfPost),
    speedFx,
  };
}

/**
 * 임의 지점이 side 팀의 **자기 페널티박스** 안인가. 기하는 IFAB 박스(config `rules.penalty`)에서
 * 파생하고 `inOwnBox` 가 이 함수를 호출하므로 기존 동작과 bit-identical 이다.
 */
export function pointInOwnBox(
  pitch: Pitch,
  config: EngineConfig,
  side: SimPlayer["side"],
  xFx: number,
  yFx: number,
): boolean {
  const g = defendGoal(pitch, side);
  const scale = config.fixedScale;
  return (
    Math.abs(xFx - g.x) <= toFixed(config.rules.penalty.boxDepthM, scale) &&
    Math.abs(yFx - g.y) <= toFixed(config.rules.penalty.boxHalfWidthM, scale)
  );
}

/** 자기 페널티박스 안인가(걷어내기 가중용). `contest.ts:victimInAttackBox` 와 같은 기하, 반대 골. */
export function inOwnBox(pitch: Pitch, config: EngineConfig, p: SimPlayer): boolean {
  return pointInOwnBox(pitch, config, p.side, p.posFx.x, p.posFx.y);
}

/**
 * 걷어내기 실행 계획(#314 A) — **어디로, 얼마나 세게**.
 *
 * 축구의 걷어내기는 "전방 + 측면 + 위험지역 밖"이다. 정면으로 길게 차면 상대 중앙 수비에게
 * 그대로 돌려주고, 옆으로만 차면 라인 밖(스로인)이 된다. 그래서 **전방 `distM` · 가까운
 * 터치라인 쪽 `touchlineBias`** 로 조준하고, 터치라인에서 `touchlineMarginM` 를 남긴다.
 *
 * 정확도는 낮다(`aimErrorDeg` 가 패스의 여러 배) — 걷어내기는 조준이 아니라 처리다.
 * Rng 소비는 `aimWithError` 의 2회로 고정(패스 성공 경로와 같은 규율).
 */
export function clearanceAim(
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): { x: number; y: number } {
  const c = config.clearance;
  const scale = config.fixedScale;
  const g = attackGoal(pitch, owner.side);
  const sign = g.x >= owner.posFx.x ? 1 : -1;
  const center = Math.round(pitch.hFx / 2);
  const marginFx = Math.round(c.touchlineMarginM * scale);
  // 가까운 터치라인 = 위험지역(중앙)에서 가장 빨리 벗어나는 방향.
  const touchY = owner.posFx.y < center ? 0 : pitch.hFx;
  return {
    x: fclamp(owner.posFx.x + sign * Math.round(c.distM * scale), marginFx, pitch.wFx - marginFx),
    y: fclamp(
      owner.posFx.y + Math.round((touchY - owner.posFx.y) * c.touchlineBias),
      marginFx,
      pitch.hFx - marginFx,
    ),
  };
}

/** 걷어내기 세기(fixed m/tick). physical 로 ±`powerAttrSwing`. 생성기·실행이 공유. */
export function clearancePowerFx(owner: SimPlayer, config: EngineConfig): number {
  const c = config.clearance;
  const power = c.speedM * (1 + c.powerAttrSwing * ((owner.attrs.physical - 50) / 50));
  return deliverySpeedFx(toFixed(Math.max(1, power), config.fixedScale), c.lofted, config);
}

/** 걷어내기 **실행**(조준 오차 포함). Rng 를 `aimWithError` 2회로만 소비한다. */
export function planClearance(
  owner: SimPlayer,
  config: EngineConfig,
  rng: Rng,
  pitch: Pitch,
): { toX: number; toY: number; speedFx: number; lofted: boolean } {
  const c = config.clearance;
  const scale = config.fixedScale;
  const aim = clearanceAim(owner, config, pitch);
  const deg = aimErrorDeg(c.aimErrorDeg, owner.attrs.physical, config.contest.passAimAttrSwing, 0, 0);
  const hit = aimWithError(
    owner.posFx.x,
    owner.posFx.y,
    aim.x,
    aim.y,
    { errDeg: deg, powerErrFrac: c.powerErrorFrac },
    rng,
  );
  // 라인에서 margin 을 남긴 안쪽으로 클램프 — 걷어내기가 곧바로 스로인이 되지 않게(게이트 조건).
  const marginFx = Math.round(c.touchlineMarginM * scale);
  return {
    toX: fclamp(hit.x, marginFx, pitch.wFx - marginFx),
    toY: fclamp(hit.y, marginFx, pitch.hFx - marginFx),
    speedFx: clearancePowerFx(owner, config),
    lofted: c.lofted,
  };
}

/**
 * 걷어내기가 **후보로 생길 수 있는 상황인가**(#314 A). 사슬 코어와 롤백 경로가 **같은 함수**를
 * 쓴다 — 두 코어가 서로 다른 조건으로 걷어내면 그건 두 개의 엔진이다.
 *
 * 조건: 자기 진영(진행도 ≤ `maxProgress`) ∧ 압박 ≥ `minPressers`.
 * "좋은 패스가 있으면 안 한다"는 **코어마다 표현이 다르다** — 사슬은 EV 비교가 그 역할을
 * 자동으로 하고(패스 EV 가 높으면 안 뽑힌다), 가중 추첨은 EV 가 없으니 명시 게이트가 필요하다
 * (`clearanceWeight` 의 `passScoreCeil`).
 */
export function clearanceEligible(
  state: SimState,
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): boolean {
  const c = config.clearance;
  if (!c.enabled) return false;
  if (attackProgressX(pitch, owner.side, owner.posFx.x) > c.maxProgress) return false;
  return pressureCount(state, owner, config, config.contest.passPressureRangeM) >= c.minPressers;
}

/**
 * 롤백 경로(`decideBallOwner`)의 걷어내기 가중. 0 이면 후보가 생성되지 않는다.
 * 여기서만 `passScoreCeil`("좋은 패스가 있으면 안 한다")을 본다 — 가중 추첨에는 EV 비교가 없어
 * 명시 게이트가 없으면 좋은 옵션이 있어도 확률적으로 걷어내게 된다.
 */
export function clearanceWeight(
  state: SimState,
  owner: SimPlayer,
  bestPassScore: number,
  config: EngineConfig,
  pitch: Pitch,
): number {
  const c = config.clearance;
  const base = config.decisionWeights.clearance;
  if (base <= 0) return 0;
  if (bestPassScore >= c.passScoreCeil) return 0;
  if (!clearanceEligible(state, owner, config, pitch)) return 0;
  const progress = attackProgressX(pitch, owner.side, owner.posFx.x);
  const pressers = pressureCount(state, owner, config, config.contest.passPressureRangeM);
  const depth = fclamp(1 - progress / Math.max(0.01, c.maxProgress), 0, 1);
  const press = fclamp(pressers / Math.max(1, c.minPressers), 1, 3);
  let w = base * (0.4 + 0.6 * depth) * press;
  if (inOwnBox(pitch, config, owner)) w *= c.boxWeightMult;
  return w;
}

/** 슛 xG 계산(거리·각도·슈팅속성). */
function computeXg(
  owner: SimPlayer,
  config: EngineConfig,
  pitch: Pitch,
): { xg: number; distM: number } {
  return xgAtPoint(
    owner.side,
    owner.posFx.x,
    owner.posFx.y,
    owner.attrs.shooting,
    owner.fatigue,
    config,
    pitch,
  );
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
    if (d > bestD) continue;
    // 동률은 전순서(거리² → idHash → id)로. 배열 순서에 기대면 퇴장 splice 가 승자를 바꾼다(§5-3).
    if (d === bestD && best) {
      const tie = p.idHash !== best.idHash ? p.idHash < best.idHash : p.id < best.id;
      if (!tie) continue;
    }
    bestD = d;
    best = p;
  }
  return best;
}

/**
 * 이 패스가 **실제로 나갈 세기·궤도**(#312) — 세기는 거리·passing·압박이 정한다.
 *
 * `planPass`(실행) · `computePassProb`(확률) · `chain.candidateSpeedFx`(후보 생성)가 **같은 함수**를
 * 부른다. 세 곳이 각자 계산하면 "후보가 예측한 비행"과 "실제 비행"이 갈리고, 그러면
 * 리시버 도착 예측(아래 `receiverArrival`)도 실행과 다른 지점을 본다.
 */
export function passDelivery(
  state: SimState,
  owner: SimPlayer,
  opt: PassOption,
  config: EngineConfig,
): { pressers: number; speedFx: number; lofted: boolean } {
  const c = config.contest;
  const pressers = pressureCount(state, owner, config, c.passPressureRangeM);
  const lofted = isLofted(opt.dist, opt.long, config);
  const speedFx = deliverySpeedFx(
    passPowerFx(opt.dist, owner.attrs.passing, pressers, config),
    lofted,
    config,
  );
  return { pressers, speedFx, lofted };
}

/**
 * 리시버가 **공이 도착할 때 있을 자리**(#353) — `planPass` 가 실제로 조준하는 지점과 같은 함수
 * (`leadAim`, #181)다. "지금 붙어 있는가"가 아니라 "도착할 때 떨어져 있는가"를 묻기 위한 좌표다.
 *
 * ⚠️ **수비수의 미래는 추정하지 않는다.** 리시버 예측 위치 vs 수비수 **현재** 위치로만 잰다 —
 * 상대의 미래 좌표를 EV 에 심는 것은 `chain.ts` 의 #316 설계 판단이 이미 기각한 함정이고,
 * 이 조합이 **보수적**이다(수비가 따라붙는 만큼은 계산에 안 들어간다).
 */
export function receiverArrival(
  state: SimState,
  owner: SimPlayer,
  opt: PassOption,
  config: EngineConfig,
  pitch: Pitch,
): { x: number; y: number } {
  // #377 M3-C: 공간 타깃(스루패스)은 조준점이 **이미 정해져 있다** — 리시버의 미래 위치가 아니라
  // 라인 뒤 그 지점이다. `planPass` 도 같은 분기를 타므로 확률·실행이 같은 점을 본다.
  if (opt.aimFx) return { x: opt.aimFx.x, y: opt.aimFx.y };
  const { speedFx } = passDelivery(state, owner, opt, config);
  return leadAim(owner.posFx, opt.receiver, speedFx, config, pitch);
}

/**
 * 패스 성공확률(결정론, 순수). = passBase − 전진/파이널서드/압박/거리 페널티 + passing 가감, clamp.
 * planPass 가 이 값으로 성공/실패를 롤한다. 전진·롱·압박 패스가 숏보다 낮게 나오도록 config 로 제어.
 * (E1: 벤치 78–85% 평균 + 전진/롱 < 숏. 단조성은 pass-prob 단위테스트로 계약 박제.)
 *
 * ## #353 — 받는 쪽도 본다
 * 구 식은 압박을 **주는 쪽만** 봤다(`pressureCount(state, owner, ...)`). 즉 리시버가 마크에
 * 물려 있든 완전히 비어 있든 성공 확률이 같았다. `PassOption.laneDanger` 는 **길목**까지의
 * 최소거리이지 "받는 사람이 붙잡혀 있는가"가 아니다 — 다른 축이다.
 * 이제 리시버 항이 붙고, 그 판정은 **도착 예측 지점**(`receiverArrival`)에서 한다. 그래서
 * "지금은 붙어 있지만 뛰어 나가는 중이라 도착할 땐 자유로운" 리시버가 제값을 받는다
 * = 스루패스·뒷공간 패스가 EV(사슬은 이 확률을 그대로 쓴다)에서 살아난다.
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
    attackProgressX(pitch, owner.side, receiver.posFx.x) >= config.setPiece.finalThirdLine;
  // 패스 압박은 근접(passPressureRangeM) 상대만 — pressRange(22m, 압박배정용)는 패스엔 과도.
  const pressers = pressureCount(state, owner, config, c.passPressureRangeM);
  // #353: 받는 쪽 압박 — **도착 예측 지점** 기준. 노브가 주는 쪽과 별개인 이유는
  // 두 축의 크기가 같을 이유가 없어서다(주는 쪽은 조준·세기가 흔들리고, 받는 쪽은 경합이다).
  const recvPressers =
    c.passReceiverPressurePenalty > 0
      ? (() => {
          const at = receiverArrival(state, owner, opt, config, pitch);
          return pressureCountAt(state, owner.side, at.x, at.y, config, c.passReceiverPressureRangeM);
        })()
      : 0;
  const distM = fromFixed(opt.dist, scale);
  const attrBonus = ((owner.attrs.passing - 50) / 50) * c.passAttrSwing;

  let prob = c.passBase;
  prob -= c.passForwardPenalty * forwardFrac;
  prob -= inFinalThird ? c.passFinalThirdPenalty : 0;
  prob -= c.passPressurePenalty * pressers;
  prob -= c.passReceiverPressurePenalty * recvPressers;
  prob -= c.passDistancePenalty * Math.max(0, distM - c.passBaseDistM);
  prob += attrBonus;
  // #377 M3-C: **경주 계수**. 공간 타깃(스루패스)만 이 항을 갖는다 — "러너가 먼저 닿나"가
  // 성공확률의 실체이기 때문이다. `undefined` 인 발밑 패스는 곱이 없어 벤치 78–85% 캘리브레이션
  // (E1)이 그대로 유지된다(= 이 줄이 기존 패스에 대해 no-op 임이 타입으로 보인다).
  if (opt.raceFrac !== undefined) prob *= opt.raceFrac;
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

export interface PassPlan {
  toX: number;
  toY: number;
  outcome: PassOutcome;
  claimant: SimPlayer | null;
  /** #312: 이 패스의 **세기**(fixed m/tick). 상수가 아니라 선수가 정한 값이다. */
  speedFx: number;
  /** #306: 띄워 보내는가(공중볼 → 도착 시 헤딩 경합). */
  lofted: boolean;
}

/**
 * 패스 실행 계획(#312 S5-B 재작성).
 *
 * **무엇이 바뀌었나**: 구버전은 성공/실패를 굴린 뒤 성공이면 리시버를 **정조준**, 실패면
 * 다른 목표(최근접 상대 / 경계 밖)를 **정조준**했다. 즉 "빗나감 = 다른 목표를 정확히 맞히는 것"
 * 이고 각도·세기 오차가 하나도 없었다(hero H1).
 *
 * 이제는:
 *  1. 선수가 **세기**를 정한다(`passPowerFx`: 거리·passing·압박).
 *  2. 그 세기로 리드조준한 지점에 **조준 오차**를 얹는다(`aimWithError`: 각도 + 세기 흔들림).
 *  3. 도달점은 그 오차의 결과다. 실패 롤이면 오차가 크고(`passFailAimErrorMult`), 회수자는
 *     리시버 근처가 아니라 **실제 도달점** 최근접 상대다.
 *
 * ⚠️ 성공/실패 롤 자체(`computePassProb`)는 **그대로 둔다** — 벤치 78–85% 캘리브레이션의 근간이고
 * (`passOutcomeAuthoritative`), 오차만으로 성공률을 만들면 그 노브가 사라진다. 바뀐 것은
 * **결과의 기하**이지 성공률의 정의가 아니다.
 */
export function planPass(
  state: SimState,
  owner: SimPlayer,
  opt: PassOption,
  config: EngineConfig,
  rng: Rng,
  pitch: Pitch,
): PassPlan {
  const c = config.contest;
  const scale = config.fixedScale;
  const receiver = opt.receiver;

  const prob = computePassProb(state, owner, opt, config, pitch);

  // --- 세기: 선수가 정한다(거리·능력치·압박). 확률·후보 생성과 **같은 함수**(#353). ---
  const { pressers, speedFx, lofted } = passDelivery(state, owner, opt, config);

  // --- 조준 오차: 능력치로 줄고 압박으로 커진다. ---
  const baseDeg = aimErrorDeg(
    c.passAimErrorDeg,
    owner.attrs.passing,
    c.passAimAttrSwing,
    pressers,
    c.passPressureAimPenalty,
  );
  // 리드패스(#181): 리시버가 **도착 시점에 있을 자리**로 찬다 → 공과 사람이 같은 지점에서 만난다.
  // 예측에 쓰는 공속은 이제 상수가 아니라 **이 패스의 실제 세기**다(느린 패스는 더 앞을 본다).
  // #377 M3-C: 공간 타깃이면 그 좌표가 조준점이다. `receiverArrival` 과 **같은 분기**를 타야
  // 확률이 본 지점과 공이 가는 지점이 갈리지 않는다.
  const intended = receiverArrival(state, owner, opt, config, pitch);

  if (rng.next() < prob) {
    const hit = aimWithError(
      owner.posFx.x,
      owner.posFx.y,
      intended.x,
      intended.y,
      { errDeg: baseDeg, powerErrFrac: c.passPowerErrorFrac },
      rng,
    );
    // 성공 롤이 난 패스는 인플레이로 유지한다(오차가 라인 밖까지 밀지 않게 클램프).
    const aim = clampToPitch(pitch, hit.x, hit.y);
    return { toX: aim.x, toY: aim.y, outcome: "success", claimant: receiver, speedFx, lofted };
  }

  const failErr = { errDeg: baseDeg * c.passFailAimErrorMult, powerErrFrac: c.passPowerErrorFrac * c.passFailAimErrorMult };

  // 실패: 아웃 vs 인플레이 턴오버.
  if (rng.next() < c.passFailOutProb) {
    // 오버힛 — **같은 방향으로 너무 세게** 차서 라인을 넘긴다(구버전: 최근접 경계를 정조준).
    // rng 소비를 성공 경로와 맞추기 위해 오차를 먼저 굴리고, 그 방향으로 밖까지 밀어낸다.
    const hit = aimWithError(owner.posFx.x, owner.posFx.y, intended.x, intended.y, failErr, rng);
    const out = overhitOut(owner.posFx.x, owner.posFx.y, hit.x, hit.y, pitch, Math.round(4 * scale));
    // 아웃으로 나가는 공은 아무도 잡지 않는다(경계에서 resolveOut).
    return { toX: out.x, toY: out.y, outcome: "fail_out", claimant: null, speedFx, lofted };
  }

  // 인플레이 턴오버 — 크게 빗나간 지점에 떨어지고, **그 지점** 최근접 상대가 회수한다.
  // (구버전은 "최근접 상대를 정조준"이라, 빗나간 패스가 상대 발밑으로 정확히 배달됐다.)
  const hit = aimWithError(owner.posFx.x, owner.posFx.y, intended.x, intended.y, failErr, rng);
  const drop = clampToPitch(pitch, hit.x, hit.y);
  const thief = nearestOpponentTo(state, owner.side, drop.x, drop.y);
  if (thief) {
    return { toX: drop.x, toY: drop.y, outcome: "fail_intercept", claimant: thief, speedFx, lofted };
  }
  return { toX: drop.x, toY: drop.y, outcome: "success", claimant: receiver, speedFx, lofted };
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

/**
 * 볼 소유자의 행동 결정(시드 확률) — **기존 코어**(즉시 점수 가중 추첨).
 *
 * `config.chain.mode === "chain"` 이면 match.ts 가 대신 `chain.ts` 의 사슬 탐색 코어를 부른다(#279 W2).
 * 분기를 match.ts 에 둔 이유는 순환 import 회피다(chain.ts 가 여기의 computePassProb/planPass 를 쓴다).
 * **이 함수 본문은 한 줄도 바뀌지 않았다** — 골든이 곧 롤백 보장이다.
 */
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
    attackProgressX(pitch, owner.side, owner.posFx.x) >= config.setPiece.finalThirdLine;
  // #349: 재시작 틱은 **킥만**(Law 8/13/15/16). 롤백 코어에도 같은 제약을 건다 — 규칙이 코어마다
  // 다르면 그건 두 개의 엔진이다. 실측상 이 코어의 재시작 드리블은 18~20% 로 사슬(78.5%)보다
  // 낮았을 뿐 0 이 아니었다.
  const mustKick = restartRequiresKick(state, config);

  // --- 슛 후보(좋은 위치/각도/찬스일 때만; xG 임계 미만 speculative 억제) ---
  const { xg: rawXg, distM } = computeXg(owner, config, pitch);
  // 1대1(단독) 찬스: 슈터 반경 안에 비-GK 상대가 없고 사거리 안이면 xG 부스트 + 하이라이트 표기.
  // (#316: 판정 본체는 `oneOnOneShot` 으로 추출 — chain 코어와 **같은 함수**를 쓴다. 산술 무변경.)
  const { xg, detail: shootDetail } = oneOnOneShot(state, owner, rawXg, distM, config);
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
    (mustKick ? 0 : w.dribble) *
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
  // #349: 재시작에서 hold 를 남기면 드리블만 막아도 "안 차고 서 있는" 데드락이 된다.
  const wHold = mustKick ? 0 : w.hold * (0.5 + 0.5 * owner.behavior.supportDepth);

  // --- 걷어내기 후보(#314 A) — 자기 진영 + 압박 + 좋은 패스 없음 ---
  let wClear = clearanceWeight(
    state,
    owner,
    bestOpt ? picked.score : -Infinity,
    config,
    pitch,
  );
  // #349 폴백: 재시작인데 킥 후보가 하나도 없으면(슛 사거리 밖 + 패스 옵션 0 + 걷어내기 부적격)
  // 적격 판정을 건너뛰고 걷어내기를 연다. 사슬 코어의 `pushClear(force)` 와 **같은 자리**의 장치다.
  if (mustKick && config.rules.restart.fallbackKick && wShoot + wPass + wClear <= 0) {
    wClear = Math.max(config.decisionWeights.clearance, 1);
  }

  // --- 시드 확률 샘플링 ---
  const total = wShoot + wPass + wDribble + wHold + wClear;
  if (total <= 0) return { kind: "hold" };
  let r = rng.next() * total;

  if ((r -= wShoot) < 0) {
    const sp = planShot(state, owner, config, rng, pitch);
    // #353: 압박 감산은 **실행되는 슛의 xg 에만**(선택 가중 `wShoot` 은 손대지 않는다 —
    // 이 코어는 롤백 경로이고, 선택까지 바꾸면 "롤백"이 다른 엔진이 된다).
    return {
      kind: "shoot",
      xg: shotPressureXg(state, owner, xg, config),
      toX: sp.toX,
      toY: sp.toY,
      speedFx: sp.speedFx,
      detail: shootDetail,
    };
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
      speedFx: plan.speedFx,
      lofted: plan.lofted,
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
  if ((r -= wClear) < 0) {
    const cp = planClearance(owner, config, rng, pitch);
    return { kind: "clearance", toX: cp.toX, toY: cp.toY, speedFx: cp.speedFx, lofted: cp.lofted };
  }
  return { kind: "hold" };
}

/**
 * side 팀에서 공에 가장 가까운 아웃필더(루즈볼 쟁탈 지정용).
 *
 * 동률은 **전순서**(거리² → idHash → id)로 깬다(§5-3). 구버전은 `d < bestD` 뿐이라 완전 동률에서
 * `state.players` 배열 순서가 승자를 정했는데, 퇴장이 splice 로 그 순서를 바꾼다 → 같은 상태에서
 * 다른 사람이 공을 주우러 가는 무음 비결정이 된다.
 */
function closestToBall(
  state: SimState,
  side: SimPlayer["side"],
  pitch: Pitch | null = null,
  config: EngineConfig | null = null,
): SimPlayer | null {
  // #239: GK 는 원래 후보가 아니다(골문을 비우면 안 되니까). 하지만 **자기 박스 안 루즈볼**은
  // GK 가 잡는 게 실축이고, 그 구멍이 곧 데드엔드다 — GK 클램프 밴드(gk.baseDepth+sweepReach)와
  // `contest.controlRange` 사이에 아무도 못 닿는 띠가 남아 골에어리어 앞 공이 회수되지 않는다.
  // pitch/config 가 없으면(호출부가 기하를 모르면) 구동작 그대로 GK 를 제외한다.
  const gkEligible =
    pitch != null &&
    config != null &&
    pointInOwnBox(pitch, config, side, state.ball.posFx.x, state.ball.posFx.y);
  let best: SimPlayer | null = null;
  let bestD = Infinity;
  for (const p of state.players) {
    if (p.side !== side) continue;
    if (p.isGK && !gkEligible) continue;
    const dx = p.posFx.x - state.ball.posFx.x;
    const dy = p.posFx.y - state.ball.posFx.y;
    const d = dx * dx + dy * dy;
    if (d > bestD) continue;
    if (d === bestD && best) {
      const tie = p.idHash !== best.idHash ? p.idHash < best.idHash : p.id < best.id;
      if (!tie) continue;
    }
    bestD = d;
    best = p;
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
  return attackProgressX(pitch, p.side, p.baseFx.x) + (cornerRunTendency(p) - 0.5) * cn.playerOverrideWeight;
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
 * **예고 패스 읽기**(#369) — 팀 게시판에 올라온 `pass_plan` 중 나를 지목한 것을 **능력만큼**
 * 읽고, 읽었으면 도착 예정 지점 쪽으로 목표를 당긴다.
 *
 * ## 왜 확률인가
 * 전원이 항상 읽으면 **텔레파시**다. hero 의 *"훈련을 했기 때문에"* 를 능력치로 계량한다 —
 * `mental`(판단) + `positioning`(상황 인지)의 평균이 높을수록 자주 읽는다.
 * **팀 케미스트리를 새 축으로 만들지 않았다**: 데이터·UI·프롬프트·계약까지 파급되고
 * (#363 이 그 비용의 실례다), 능력치로 먼저 해 보고 부족하면 그때 만드는 것이 싸다.
 *
 * ## 왜 RNG 가 아니라 시드 노이즈인가
 * `Rng` 를 쓰면 소비량이 **게시 수에 비례**해 스트림이 요동치고, 재개(resume) 계약이 취약해진다
 * (#369 가 명시적으로 경고한 함정). `varietyNoise(seedHash, idHash, bucket)` 는 상태의 순수
 * 함수라 **스트림을 한 번도 건드리지 않으면서** 선수마다·틱마다 다른 값을 준다.
 *
 * ## 왜 **값을 돌려주나**(직접 `targetFx` 를 안 쓰나)
 * 오프더볼 공격 분기는 목표를 `tx`/`ty` **로컬**로 쌓아 맨 끝에서 한 번 대입한다.
 * 그래서 중간에 `player.targetFx` 를 써 봐야 **덮어써진다**(첫 구현이 정확히 그 no-op 이었다).
 * 순수 조회로 두고 **대입 직전에** 섞는다.
 *
 * ## 아군만
 * `intent.side !== player.side` 는 아예 보지 않는다. 상대의 예측은 #379 의 몫이고 그건
 * 게시판이 아니라 **기하**로 한다 — 정보 출처가 다른 것이 텔레파시를 막는 유일한 방법이다.
 */
function readPassPlan(state: SimState, player: SimPlayer, config: EngineConfig): { x: number; y: number } | null {
  const pp = config.movement.passPlan;
  if (!pp.enabled || pp.pull <= 0) return null;
  // ⚠️ **가장 오래된 살아 있는 예고**를 읽는다(= 배열 순서 첫 건). 직관은 반대였다 — "캐리어의
  // 지금 생각이 최신 예고"라고 보고 `it.tick` 최대를 읽게 바꿔 봤는데, **두 축이 다 나빠졌다**
  // (아블레이션, seed 1618033988 · 전원 읽기 팔): 발사 전 좁힌 거리 pull 0.8 에서
  // +0.42m/44.2% → **−0.77m/33.1%**, 마크 진동 nearOwner 26.18 → **27.9**.
  // 이유는 최신 예고가 **매 틱 새로 계산돼 목표가 계속 움직이기** 때문이다 — 리시버가 어느
  // 지점에도 수렴하지 못한다. 오래된 예고는 여러 틱 같은 지점을 가리켜 리시버가 실제로 도달한다.
  // (수명 `expireTicks` 가 그 안정성의 상한이다.) 그래서 되돌렸다.
  for (const it of state.intents) {
    if (it.kind !== "pass_plan") continue;
    if (it.side !== player.side) continue; // 아군만 — 텔레파시 방지
    if (it.forId !== player.id) continue;
    if (it.expiresTick < state.tick) continue;
    // 읽기 판정: 능력 비례 + 시드 노이즈(스트림 소비 0). 버킷을 게시 틱으로 잡아
    // **한 예고에 대해 판정이 매 틱 뒤집히지 않게** 한다(뒤집히면 그게 곧 #185 진동이다).
    const attr = (player.attrs.mental + player.attrs.positioning) / 2;
    const prob = pp.readBase + pp.readAttrSwing * ((attr - 50) / 50);
    const read = varietyNoise(state.seedHash, player.idHash, it.tick) < prob;
    // 진단 훅(옵트인·결정론 영향 0) — 읽기 여부는 로그 어디에도 안 나오므로, 계약이 출하 config
    // 그대로 "읽은 쪽 vs 안 읽은 쪽"을 가르려면 창이 하나 필요하다(독립검증 m1).
    const obs = planReadObserver();
    if (obs) obs({ tick: state.tick, side: player.side, forId: player.id, planTick: it.tick, xFx: it.xFx, yFx: it.yFx, read });
    // ⚠️ 읽기에 실패하면 **그 틱엔 다른 예고도 안 본다**(첫 건에서 return). 의도다 —
    // 판정 버킷이 게시 틱이라, 실패한 예고를 건너뛰고 다음 예고를 보면 "이번 틱엔 안 읽혔는데
    // 다음 틱엔 읽힌다"가 수명 안에서 계속 뒤집힌다 = 목표가 매 틱 튀는 #185 진동이다.
    // 한 리시버는 한 예고에 대해 **수명 내내 같은 판정**을 유지한다.
    if (!read) return null;
    return { x: it.xFx, y: it.yFx };
  }
  return null;
}

/**
 * `duty` 배수(#366 T5). 미배선이거나 꺼져 있으면 1(= 0.31.0 이전 동작, 변이체 킬 대조군).
 *
 * 결판은 **(a) 배선한다**로 갔다(#366 권장). 이유: 이미 유저에게 노출된 UI 셀렉트라 계약에서
 * 빼는 비용이 더 크고(shared 프리즈 + web 정리), 배선은 이 함수 하나로 끝난다.
 */
function dutyMult(config: EngineConfig, player: SimPlayer, axis: "forwardRun" | "supportPull"): number {
  const d = config.duty;
  if (!d.enabled) return 1;
  const table = axis === "forwardRun" ? d.forwardRunMult : d.supportPullMult;
  return table[player.duty] ?? 1;
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

  // GK: 자기 골대 앞에서 공 y 를 추종 + **공 거리에 따른 스위퍼 라인**(#314 C).
  // 구버전은 깊이가 상수(0.04·피치길이)라 GK 목표가 사실상 고정점이었다 — 역할별 정지율 실측에서
  // GK 38.6%(아웃필더 ~10%)로 "비소유팀이 굳어 있다"의 최대 기여자였다. 실제 GK 는 공이 멀면
  // 나오고 가까우면 골라인에 붙는다. 상수 두 개(0.04·0.3)도 여기서 config 로 승격된다(§2-4).
  if (player.isGK) {
    // #239 백스톱: **자기 박스 안에 죽어 있는 공**은 GK 가 주우러 간다(실축 GK 행동).
    //
    // 조건은 **데드엔드 지문 그대로**다 — 소유자 없음 + **비행조차 없음**(`flight == null`) +
    // 세트피스·정지 없음. 그 상태는 `stepTick` 의 어느 분기에도 안 걸리고 아래 루즈볼 분기도
    // `flight.kind === "loose"` 를 요구하므로 아무도 안 온다(= 하프가 죽는다). GK 목표는 평소
    // 스위퍼 밴드(`gk.baseDepth + sweepReach`)로 클램프되므로 그 밖에 멈춘 공은 GK 도 못 닿는다.
    //
    // ⚠️ **굴러가는 루즈볼(`kind === "loose"`)까지 넓히면 안 된다.** 그건 이미 아웃필더가 쫓고
    // 있고, 거기에 GK 까지 나가면 수비 배치가 통째로 흔들려 캘리브레이션이 깨진다(실측 60시드:
    // 유효슛 5.32 → 5.58 로 밴드 4.5–5.5 이탈 · 마크 진동 백스톱 10.13 → 11.23 로 임계 초과).
    // 지문으로 좁힌 형태는 정상 경기에서 사실상 발동하지 않는다(전 골든·지표 무이동).
    // 데드볼(정지/세트피스) 중에도 걸지 않는다 — 골 세리머니의 네트 안 공으로 달려가면 안 된다.
    const deadInBox =
      state.stoppage <= 0 &&
      state.setPiece == null &&
      ball.owner == null &&
      ball.flight == null &&
      pointInOwnBox(pitch, config, player.side, ball.posFx.x, ball.posFx.y);
    // **GK 가 우리 팀 최근접일 때만** 나간다(아웃필더가 더 가까우면 그쪽이 온다).
    // 아웃필더 경로(아래 루즈볼 분기)는 **한 줄도 안 바뀐다** — GK 완화를 그쪽에 넘기지 않는다.
    if (deadInBox && closestToBall(state, player.side, pitch, config) === player) {
      player.targetFx = clampToPitch(pitch, ball.posFx.x, ball.posFx.y);
      return;
    }
    const gkc = mv.gk;
    const ballDist = fdist(ball.posFx.x, ball.posFx.y, ownGoal.x, ownGoal.y);
    const outFrac = fclamp(ballDist / Math.max(1, gkc.sweepRefM * scale), 0, 1);
    const depthFx = Math.round((gkc.baseDepthM + gkc.sweepReachM * outFrac) * scale);
    const gy = fclamp(
      ownGoal.y + Math.round((ball.posFx.y - ownGoal.y) * gkc.ballYFollow),
      Math.round(pitch.hFx * 0.35),
      Math.round(pitch.hFx * 0.65),
    );
    player.targetFx = clampToPitch(pitch, ownGoal.x + sign * depthFx, gy);
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
    // #313: **주석과 코드가 어긋나 있었다.** 주석은 "양 팀 최근접이 간다"인데 코드는
    // `!loose.claimant` 조건 탓에 claimant 가 있으면 **상대 팀은 아무도 안 쫓았다** — 계획된
    // 리시버 혼자 주우러 가는, 경합이 아닌 그림이다(감사 지적). 실제 루즈볼은 양 팀이 다툰다.
    // #239: 여기는 **아웃필더 경로**라 GK 완화를 켜지 않는다(pitch/config 미전달 = 구동작 그대로).
    // GK 는 위 분기에서 따로 판단한다 — 아웃필더가 오던 공을 GK 가 "가로채" 대신 오게 만들면
    // 수비 블록 배치가 통째로 흔들린다(밴드 이탈 실측). 둘 다 오는 편이 데드엔드에 더 안전하다.
    const mine = closestToBall(state, player.side);
    // #231: claimant 는 상대일 수도 있다 — id 만 비교하면 같은 id 의 우리 팀 선수가 남의 공을 주우러 간다.
    const claimedByMe = loose.claimant === player.id && claimantSideOf(loose) === player.side;
    if (claimedByMe || (mine != null && mine.id === player.id)) {
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
      const baseProg = attackProgressX(pitch, player.side, player.baseFx.x);
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
  /** #369: 읽은 예고 패스의 도착 예정 지점(없으면 null). 대입 **직전**에 섞는다. */
  let planPt: { x: number; y: number } | null = null;
  const attacking = state.possession === player.side;

  if (attacking) {
    // #369: **예고 패스를 읽었으면** 도착 예정 지점 쪽으로 미리 움직인다. 전진 런 계산보다
    // 앞에 두는 이유는, 읽은 선수의 목표가 "자기 역할 자리"가 아니라 "공이 올 자리"여야 하기
    // 때문이다(런 보정은 그 위에 얹힌다).
    planPt = readPassPlan(state, player, config);
    // 전진 런: 역할 위치에서 골 방향으로.
    // #366 T5: **`duty`(밸런스/공격가담/수비안정/연결고리)가 여기서 처음 소비된다.** UI·계약·
    // `SimPlayer` 까지 전부 배선돼 있는데 읽는 코드가 0건이라 유저가 고른 셀렉트가 무효였다.
    // ⚠️ 자연어 우회와 **이중 계상**이 된다(같은 지시가 문장으로도 `forwardRunFreq` 를 올린다) →
    // 배수를 일부러 얕게 잡는다. 이 값들은 러프 기본값이고 조정은 트랙 T 소관이다.
    const runFrac = mv.forwardRunReach * player.behavior.forwardRunFreq * dutyMult(config, player, "forwardRun");
    tx += Math.round((g.x - player.baseFx.x) * runFrac);
    // 인포제션 폭 확장: 자기 반쪽 기준 바깥으로 벌림.
    // 정확히 중앙(y=center) 선수(4-3-3 의 ST·CM)는 idHash 패리티로 좌/우 분배 — 구 `<center?-1:1` 은
    // 중앙 선수를 항상 +y(아래)로 밀어 공격이 하프 아래로 쏠렸다(슛 96%·코너 98.6% 편중 → 코너 반복
    // 단조로움, #25). idHash 패리티는 결정론을 유지하며(전역 난수 미사용) 좌우 균형을 회복한다.
    const widthDir = player.baseFx.y < center ? -1 : player.baseFx.y > center ? 1 : ((player.idHash & 1) ? 1 : -1);
    // #361 T1: **팀 폭 슬라이더**가 여기서 처음 소비된다(그 전엔 참조 0건 — 유저가 "넓게 벌려라"
    // 를 아무리 올려도 경기가 비트 단위로 같았다). 선수별 `widthTendency` 와 **곱**으로 결합한다:
    // 팀 지시는 개인 성향을 지우는 것이 아니라 **전체를 스케일**하는 축이라 그게 맞다.
    // 0.5 를 더하는 것은 `chain.ts` 의 `shootTendency`·`passRisk` 배수와 **같은 관용구**다
    // (슬라이더 0 이 곱을 0 으로 만들어 축 자체를 죽이지 않게).
    ty += widthDir * Math.round(
      pitch.hFx * mv.attackWidthReach * player.behavior.widthTendency * (0.5 + team.width),
    );
    // 팀 업필드 push: 볼 x 를 따라 라인 전진 → length 압축 + 다이내믹(제자리 방지).
    tx += Math.round((ball.posFx.x - player.baseFx.x) * mv.attackLinePush);
    // 지원: 공 쪽으로 약하게 당김. (#366 T5 — "연결고리"가 더 붙고 "수비 안정"이 덜 붙는다)
    const supportFrac = mv.supportPull * player.behavior.supportDepth * dutyMult(config, player, "supportPull");
    tx += Math.round((ball.posFx.x - tx) * supportFrac);
    ty += Math.round((ball.posFx.y - ty) * supportFrac);
    // roam: positioningFreedom 이 크면 공쪽으로 더.
    tx += Math.round((ball.posFx.x - tx) * mv.roamFactor * player.behavior.positioningFreedom);
    // 수비/풀백 오버랩: 시드 노이즈가 임계 미만이면 여러 틱 동안 라인 위로 전진(뒤 공간 노출 리스크).
    const vr = config.variety;
    const baseProg = attackProgressX(pitch, player.side, player.baseFx.x);
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
    // #314: 블록 중심은 이제 **팀 계획**(teamplan.ts:computeTeamPlan)이 소유한다 — 값·공식은
    // 그대로이고(비트 동일), 선수마다 중복 재계산하던 것을 틱당 1회 계산으로 되돌린 것뿐이다.
    // S1 이 만들어 둔 `state.plan` 의 **첫 소비자**다(로드맵 W5-2 의 도입부).
    const plan = state.plan[player.side];
    const blockCenterX = plan.lineX;
    const compact = plan.blockDepth;
    tx += Math.round((blockCenterX - player.baseFx.x) * mv.defendCompactX * compact);
    // 폭: 블록으로 좁힘(볼 y 쪽으로 수축).
    const widthDir = player.baseFx.y < center ? -1 : player.baseFx.y > center ? 1 : ((player.idHash & 1) ? 1 : -1);
    // #361 T1: 수비 블록 폭도 같은 축이다(공격만 넓히면 "넓게"가 반쪽이 된다).
    ty += widthDir * Math.round(
      pitch.hFx * mv.defendWidthReach * player.behavior.widthTendency * (0.5 + team.width),
    );
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
        // #314 B(수비측, hero ⓑ "뛰어들어가는 선수를 보고 막는"): 지금까지 마킹은 상대의
        // **현재 위치**만 봤다 — 달려드는 선수를 예측하는 개념이 없어 러너는 항상 한 발 앞섰다.
        // 이제 마크 대상이 런 오더를 받은 상태면 그 **도착 예정 지점 쪽으로** 미리 붙는다.
        // 전지적 정보가 아니다: `known`(= 이 선수가 실제로 인지한 상대)에서만 읽고, 선점량은
        // `runReadMaxM` 로 상한을 둔다(라인을 버리고 러너를 쫓아가지 않게).
        if (vis.runReadFrac > 0) {
          const runner = playerAt(state, otherSide(player.side), target.id);
          const ro = runner?.runOrder;
          if (ro && ro.untilTick >= state.tick) {
            const dx = ro.xFx - target.x;
            const dy = ro.yFx - target.y;
            const len = isqrt(dx * dx + dy * dy);
            if (len > 0) {
              const lead = Math.min(
                Math.round(len * vis.runReadFrac),
                Math.round(vis.runReadMaxM * scale),
              );
              target.x += Math.round((dx * lead) / len);
              target.y += Math.round((dy * lead) / len);
              target.dist = fdist(player.posFx.x, player.posFx.y, target.x, target.y);
            }
          }
        }
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
    // ⚠️ #314 C 에서 **로밍 오프셋의 선형 보간**(#307 의 `idleDriftSmooth` 를 오픈플레이에 이식)을
    // 시도했다가 **기각**했다. 총 이동량이 같은데 25틱에 펴지면 틱당 0.24m 라 "거의 정지"(<0.3m)
    // 판정을 오히려 **더 많이** 받는다(실측 비소유 정지 15.1% → 16.5%, 슛/팀 12.8 → 15.3).
    // 이 축의 정답은 "잔진동을 늘리는 것"이 아니라 **블록이 공을 더 따라가는 것**이었다
    // (`defendCompactX` — 같은 실측에서 정지율·백4 산포·압박밀도가 동시에 좋아진 유일한 축).
    tx += Math.round((nx * 2 - 1) * ampFx);
    ty += Math.round((ny * 2 - 1) * ampFx);
  }

  // #369: 예고를 읽었으면 **마지막에** 도착 예정 지점 쪽으로 당긴다. 여기가 대입 직전이라
  // 위의 모든 항(런·폭·지원·roam·오버랩·노이즈)이 계산된 뒤에 얹힌다 — 역할 자리를 지우지 않고
  // "공이 올 자리"로 기울이는 것이다.
  // ⚠️ 첫 구현은 이걸 중간에서 `player.targetFx` 로 썼다가 이 대입에 **덮어써지는 no-op** 이었다.
  if (planPt) {
    const pull = config.movement.passPlan.pull;
    tx += Math.round((planPt.x - tx) * pull);
    ty += Math.round((planPt.y - ty) * pull);
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

/**
 * side 팀의 압박 담당(공 최근접) 지정.
 *
 * #361 T1: **`pressingScheme.triggerLine`(압박 시작선)** 이 여기서 처음 소비된다 — 그 전엔 참조가
 * 0건이라 유저가 "하이프레스" 를 골라도 경기가 비트 단위로 같았다. 게이트 하나로 **로우블록 vs
 * 하이프레스**가 갈린다: 공이 우리 진영 깊숙이(진행도가 `1 − triggerLine` 미만) 오기 전에는
 * 압박 담당을 지정하지 않는다 = 블록을 유지하고 나가지 않는다.
 *
 *  - triggerLine 1.0 → 상대 골라인까지 쫓아가 압박(최고 하이프레스)
 *  - triggerLine 0.5 → 하프라인까지만(현행 기본과 유사)
 *  - triggerLine 0.0 → 우리 골라인 앞까지 끌어들인 뒤에야 압박(극단 로우블록)
 *
 * ⚠️ `enabled=false` 면 게이트 없음 = 0.31.0 이전 동작(롤백 스위치·변이체 킬 대조군).
 */
export function assignPresser(
  state: SimState,
  side: SimPlayer["side"],
  config: EngineConfig,
  pitch: Pitch,
): SimPlayer | null {
  const g = config.press.trigger;
  if (g.enabled) {
    // 수비팀 관점의 "공이 얼마나 올라와 있나". 0 = 우리 골라인, 1 = 상대 골라인.
    // `triggerLine` 은 **어디까지 나가서 압박하는가**의 선이다 — 그 선 위쪽(상대 진영 더 깊은 곳)
    // 에 공이 있으면 나가지 않고 블록을 유지한다.
    const prog = attackProgressX(pitch, side, state.ball.posFx.x);
    if (prog > state.teams[side].pressingScheme.triggerLine + g.marginProgress) return null;
  }
  return closestToBall(state, side);
}
