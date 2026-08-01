import type { EngineConfig } from "./config";
import type { SimState, SimPlayer } from "./simstate";
import { restartRequiresKick } from "./simstate";
import type { Pitch } from "./pitch";
import type { Rng } from "./rng";
import type { PassOption } from "./perception";
import type { ActionCandidate, GeneratorId, ChainProbe } from "./action";
import { fromFixed, fclamp, fdist, fdistSq, isqrt, toFixed } from "./fixedmath";
import { attackGoal, clampToPitch, distToAttackGoal } from "./pitch";
import { passOptions, pressureCount } from "./perception";
import { shotPowerFx } from "./kick";

import {
  clearanceAim,
  clearanceEligible,
  clearancePowerFx,
  computePassProb,
  oneOnOneShot,
  planClearance,
  planPass,
  passDelivery,
  planShot,
  shotPressureXg,
  xgAtPoint,
  type Action,
  type PassForecast,
} from "./decision";
import {
  EV_SCALE,
  FRAC_SCALE,
  GENERATORS,
  candidateKey,
  chainProbe,
  toActionCandidate,
} from "./action";

/**
 * chain — **볼 소유자 결정의 대안 코어**(#279, `config.chain.mode="chain"` 일 때만).
 *
 * ## 왜 이 파일이 존재하나
 * 기존 `decideBallOwner` 는 {슛·패스·드리블·홀드} 각각의 **즉시 점수**를 만들어 가중 추첨한다.
 * 그 구조에는 "이 패스를 하면 **그다음에 뭐가 되는가**"를 볼 자리가 없다. 그래서 #279 진단이
 * 보여준 증상들(백패스 22.4% · 전진 후보 0개 23.6% · 다이렉트 스피드 5.69 m/s · 슛 출발점 엔트로피 0)을
 * 노브로 각각 눌러야 했고, 하나를 누르면 다른 게 튀었다.
 *
 * 여기서는 행동이 아니라 **도달하는 상태**를 평가한다:
 *
 *   EV(행동) = P(성공) × V(성공 상태, depth−1) + (1 − P(성공)) × V(턴오버 상태)
 *
 * 그래서 "안전하지만 뒤로 빼는 패스"는 V 가 낮아서 자연히 밀리고, "성공하면 좋지만 뺏히면 치명적인
 * 롱볼"은 턴오버 항이 깎는다. 백패스 페널티·전진 보너스 같은 **개별 노브 없이** 방향성이 나온다.
 * 설계 출처 = RoboCup 2D `agent2d` 의 ChainAction(BFS + Field Evaluator, 논문 공개·코드 미사용).
 *
 * ## S2 에서 바뀐 것 (#279 S2 — "고를 것을 담을 그릇")
 * 1. 후보가 인라인 리터럴이 아니라 **`ActionCandidate`(action.ts)** 다 — 좌표가 1급이고
 *    `receiver` 가 nullable 이라 S5 의 좌표 타깃(크로스·스루패스·사이드전환)이 **표현 가능**해진다.
 * 2. 후보 생성이 **생성기(generator) 함수**로 쪼개졌다. **행동은 한 개도 늘지 않았다**
 *    (shoot · direct · long · carry · hold 그대로). 늘리는 건 S5 고, 그때 이 파일에 추가되는 건
 *    `GEN_FN` 테이블의 항목뿐이어야 한다.
 * 3. 탐색 상한이 **깊이가 아니라 평가 노드 수**(`chain.search`)다 — 생성기를 추가해도 비용 상한이
 *    안 변하게 하는 유일한 방법. (기본값은 비구속. config.ts 의 `search` 주석 참조.)
 * 4. **EV 가 정수 고정소수**(`EV_SCALE`)다. 부동 EV 를 비교·정렬하면 마지막 비트 차이가 행동을
 *    뒤집는다(= 무음 desync). 정수는 플랫폼 불변이고 동점이 정확히 동점이다.
 * 5. 생성기별 **생성/채택 계측**(옵트인 probe) — "왜 안 바뀌었나"를 추측 대신 수치로 답한다.
 *
 * ## 범위 (의도적으로 좁다)
 * **볼 소유자 결정만** 바꾼다. 오프더볼 이동(`decideOffBall`)·경합(`contest`)·공 물리는 손대지 않는다.
 *
 * ## 결정론
 * 전역 난수·시각 의존 0. 상태 예측은 순수 정수 산술이고, 유일한 Rng 소비는 상위 후보 샘플 1회 +
 * 선택된 패스의 `planPass` 롤(기존과 동일 순서)이다. 예측은 좌표를 **읽기만** 한다(상태 변경 없음).
 */

/** 사슬 탐색이 평가하는 "가상 상태" — 공을 누가 어디서 잡고 있나. 나머지 선수는 정지 가정. */
interface Hypo {
  side: SimPlayer["side"];
  xFx: number;
  yFx: number;
  /** 그 지점에서 슛을 칠 사람의 슈팅 속성·피로(위협 계산용). */
  shooting: number;
  fatigue: number;
}

/**
 * 0..FRAC_SCALE 분수의 정수 거듭제곱. **`Math.pow` 를 쓰지 않는다** — ECMAScript 명세상 `Math.pow` 는
 * *구현 근사(implementation-approximated)* 라 엔진/버전 간 최하위 비트가 다를 수 있고, 이 코어는
 * EV 를 **비교·정렬**하므로 그 차이가 **행동 선택을 뒤집을 수 있다**(= 무음 desync).
 * 곱셈·나눗셈은 IEEE754 로 정확히 규정돼 있으므로 반복 곱이 안전하다
 * (중간값 ≤ FRAC_SCALE² = 1e8 로 2^53 안, 즉 곱은 **정확**하고 나눗셈만 올바른 반올림).
 * → `chain.advanceExponent` 는 **음이 아닌 정수**여야 한다(소수 지수는 지원하지 않는다).
 */
function powFrac(baseFrac: number, exp: number): number {
  const n = exp < 0 ? 0 : Math.round(exp);
  let r = FRAC_SCALE;
  for (let i = 0; i < n; i++) r = Math.round((r * baseFrac) / FRAC_SCALE);
  return r;
}

/** 정수 EV(또는 정수 스칼라) × 0..1 분수 계수(FRAC_SCALE). */
function mulFrac(v: number, fracScaled: number): number {
  return Math.round((v * fracScaled) / FRAC_SCALE);
}

/** 0..1 float → FRAC_SCALE 정수(경계 클램프). 확률·정규화 항이 정수 도메인에 들어오는 관문. */
function toFrac(v: number): number {
  const n = Math.round(v * FRAC_SCALE);
  return n < 0 ? 0 : n > FRAC_SCALE ? FRAC_SCALE : n;
}

/**
 * 배수(0..1 범위를 넘을 수 있는 계수) → FRAC_SCALE 정수. **클램프하지 않는다** —
 * behavior 배수는 `0.5 + tendency` (최대 1.5) · `1.4 − passRisk` (최대 1.4) 라 1 을 넘는다.
 * 여기에 `toFrac` 을 쓰면 1.5 가 1.0 으로 잘려 성향이 조용히 죽는다.
 */
function toMul(v: number): number {
  return Math.round(v * FRAC_SCALE);
}

/** config 의 float 노브를 정수로 한 번만 굽는다(결정마다 재변환하지 않게). */
interface Weights {
  advEv: number;
  threatEv: number;
  spaceEv: number;
  turnoverFrac: number;
  goalValueEv: number;
  holdPenaltyEv: number;
  discountFrac: number;
  spaceRefFx: number;
  advExp: number;
}

function bakeWeights(config: EngineConfig): Weights {
  const c = config.chain;
  return {
    advEv: Math.round(c.advanceWeight * EV_SCALE),
    threatEv: Math.round(c.threatWeight * EV_SCALE),
    spaceEv: Math.round(c.spaceWeight * EV_SCALE),
    turnoverFrac: Math.round(c.turnoverWeight * FRAC_SCALE),
    goalValueEv: Math.round(c.goalValue * EV_SCALE),
    holdPenaltyEv: Math.round(c.holdPenalty * EV_SCALE),
    discountFrac: Math.round(c.discount * FRAC_SCALE),
    spaceRefFx: Math.round(c.spaceRefM * config.fixedScale),
    advExp: c.advanceExponent,
  };
}

/**
 * 한 결정(재귀 포함) 동안의 탐색 문맥. **결정 하나마다 새로 만든다** — 그래야 캐시가 상태 스냅샷과
 * 1:1 이고(state 는 결정 중에 안 바뀐다), 결정 간 누수가 없다.
 */
interface SearchCtx {
  state: SimState;
  config: EngineConfig;
  pitch: Pitch;
  w: Weights;
  /**
   * (x,y) → 좌표 파생값 캐시(`PointCache`).
   *
   * 이게 있어야 표현형 도입이 **성능 중립**으로 떨어진다. depth-2 한 결정에서 상태 가치는 280번쯤
   * 계산되는데, 그 좌표들은 사실상 **동료 11명의 위치 13개뿐**이다(성공 상태 / 턴오버 상태 /
   * 재귀 재방문이 같은 점을 반복해서 친다). 캐시 없이는 최근접 상대 탐색·진행도 거듭제곱·공간 항이
   * 매번 다시 돈다. 담기는 값은 전부 (상태, 좌표)의 순수 함수라 **비트 동일**이고 결정론 영향 0.
   */
  near: Map<number, PointCache>;
  /** EV 평가 노드 카운터(예산 대상). */
  nodes: number;
  maxNodes: number;
  budgetHit: boolean;
  beamClipped: boolean;
  recurseClipped: boolean;
  probe: ChainProbe | null;
}

/**
 * 좌표 하나에 대한 **양팀 관점 파생값 캐시**.
 *
 * 사슬 탐색은 같은 지점(= 동료 위치)을 결정 하나 안에서 수십 번 재평가한다 — 성공 상태로 한 번,
 * 턴오버(상대 관점)로 한 번, 그리고 depth-2 재귀에서 다시. 여기 담기는 값은 전부
 * **(상태, 좌표)의 순수 함수**라 메모이제이션이 값에 영향을 주지 않는다(비트 동일).
 */
interface PointCache {
  /** 최근접 비-GK 홈/어웨이 선수까지 거리(fixed). 없으면 Infinity. */
  home: number;
  away: number;
  /** 진행도^advanceExponent (FRAC). 팀별. */
  advHome: number;
  advAway: number;
  /** 여유공간 항(FRAC) = min(1, 최근접상대/spaceRefM). 팀별. */
  spHome: number;
  spAway: number;
}

function pointAt(ctx: SearchCtx, xFx: number, yFx: number): PointCache {
  // 키: 좌표는 피치 안 음이 아닌 정수(fixedScale=1000 → x<1.06e5, y<6.9e4)라 충돌이 없다.
  const key = xFx * 1_000_000 + yFx;
  const hit = ctx.near.get(key);
  if (hit) return hit;
  // **제곱거리로 최솟값을 찾고 마지막에 한 번만 정수 제곱근**을 취한다. `isqrt` 는 Math.sqrt +
  // 경계 보정 루프라 이 코어에서 가장 비싼 원자 연산인데, `min` 은 단조라 √를 뒤로 미뤄도
  // 결과가 **비트 동일**하다(원본은 선수마다 √를 돌렸다).
  let homeSq = Infinity;
  let awaySq = Infinity;
  for (const p of ctx.state.players) {
    if (p.isGK) continue;
    const d2 = fdistSq(p.posFx.x, p.posFx.y, xFx, yFx);
    if (p.side === "home") {
      if (d2 < homeSq) homeSq = d2;
    } else if (d2 < awaySq) awaySq = d2;
  }
  const home = homeSq === Infinity ? Infinity : isqrt(homeSq);
  const away = awaySq === Infinity ? Infinity : isqrt(awaySq);
  const w = ctx.w;
  const raw = Math.round((xFx * FRAC_SCALE) / ctx.pitch.wFx);
  const rec: PointCache = {
    home,
    away,
    advHome: powFrac(clampFrac(raw), w.advExp),
    advAway: powFrac(clampFrac(FRAC_SCALE - raw), w.advExp),
    // side 관점의 "최근접 상대" = 반대 팀 거리.
    spHome: spaceFrac(away, w.spaceRefFx),
    spAway: spaceFrac(home, w.spaceRefFx),
  };
  ctx.near.set(key, rec);
  return rec;
}

/** 0..FRAC_SCALE 로 클램프. */
function clampFrac(v: number): number {
  return v < 0 ? 0 : v > FRAC_SCALE ? FRAC_SCALE : v;
}

/** 여유공간 항(FRAC) = min(1, 최근접상대거리 / spaceRefM). 상대가 없으면 만점. */
function spaceFrac(nd: number, spaceRefFx: number): number {
  if (nd === Infinity) return FRAC_SCALE;
  const v = Math.round((nd * FRAC_SCALE) / spaceRefFx);
  return v > FRAC_SCALE ? FRAC_SCALE : v;
}

/** side 팀 관점의 최근접 상대 거리(fixed). */
function nearestOppDist(ctx: SearchCtx, side: SimPlayer["side"], xFx: number, yFx: number): number {
  const d = pointAt(ctx, xFx, yFx);
  return side === "home" ? d.away : d.home;
}

/**
 * 상태 가치 V — **정수 EV**(EV_SCALE). 전부 0..1 로 정규화한 항의 가중합이라 노브가 서로 스케일을
 * 안 깨뜨린다.  V = advance·진행도^exp + threat·xG + space·여유공간
 */
function evaluateStateEv(ctx: SearchCtx, h: Hypo): number {
  const w = ctx.w;
  // 진행도는 **볼록**하게(^exponent). 선형이면 자기 진영에서 안전하게 돌리는 것과 밀고 가는 것의
  // 가치 차가 작아 뒤로 빼는 게 최적이 된다(#279 W2 1차 실측: 파이널서드 백패스 67%).
  // adv·space 는 좌표만의 함수라 PointCache 가 결정당 한 번만 계산한다.
  const pc = pointAt(ctx, h.xFx, h.yFx);
  const home = h.side === "home";
  const adv = home ? pc.advHome : pc.advAway;
  const sp = home ? pc.spHome : pc.spAway;
  const { xg } = xgAtPoint(h.side, h.xFx, h.yFx, h.shooting, h.fatigue, ctx.config, ctx.pitch);
  return Math.round((w.advEv * adv + w.threatEv * toFrac(xg) + w.spaceEv * sp) / FRAC_SCALE);
}

/**
 * 턴오버 상태의 가치 — **상대 관점의 V 를 뒤집어** 쓴다. 그래서 "우리 진영에서 뺏기는 것"이
 * "상대 진영에서 뺏기는 것"보다 훨씬 큰 손해로 계산된다(별도 노브 없이 위치 리스크가 나온다).
 */
function turnoverEv(ctx: SearchCtx, h: Hypo): number {
  const opp: SimPlayer["side"] = h.side === "home" ? "away" : "home";
  // 뺏은 쪽은 그 자리에서 시작한다고 본다. 슈팅 속성은 중앙값(50)으로 — 누가 뺏을지 모른다.
  const v = evaluateStateEv(ctx, { side: opp, xFx: h.xFx, yFx: h.yFx, shooting: 50, fatigue: 0 });
  return -mulFrac(v, ctx.w.turnoverFrac);
}

/**
 * 외부(테스트·진단)용 상태 가치. **정수 EV** 를 돌려준다.
 * 결정 문맥이 없을 때 쓰는 얇은 래퍼라 캐시 이득이 없다 — 뜨거운 경로에서는 쓰지 말 것.
 */
export function evaluateState(
  state: SimState,
  h: { side: SimPlayer["side"]; xFx: number; yFx: number; shooting: number; fatigue: number },
  config: EngineConfig,
  pitch: Pitch,
): number {
  return evaluateStateEv(newCtx(state, config, pitch), h);
}

function newCtx(state: SimState, config: EngineConfig, pitch: Pitch): SearchCtx {
  const s = config.chain.search;
  return {
    state,
    config,
    pitch,
    w: bakeWeights(config),
    near: new Map(),
    nodes: 0,
    maxNodes: s.maxNodes > 0 ? s.maxNodes : Number.MAX_SAFE_INTEGER,
    budgetHit: false,
    beamClipped: false,
    recurseClipped: false,
    probe: chainProbe(),
  };
}

/* ------------------------------------------------------------------------- *
 * 생성기 — **행동을 늘리지 않는다.** 인라인이던 후보를 생성기 함수로 재편했을 뿐이다.
 * ------------------------------------------------------------------------- */

/** 생성기에 넘기는 입력(홀더와 그 자리에서 이미 계산된 값). */
interface GenInput {
  ctx: SearchCtx;
  holder: SimPlayer;
  here: Hypo;
  /** 홀더 자리의 xG·골거리 — 슛 생성기가 쓰고, 재계산하지 않도록 한 번만 넘긴다. */
  xgHere: number;
  distToGoalM: number;
  distToGoalFx: number;
  goal: { x: number; y: number };
  /** 이 레벨의 패스 후보(지연 생성 — 생성기 두 개가 같은 배열을 공유해 `passOptions` 를 1회만 부른다). */
  passOpts: PassOption[] | null;
}

function passOptsOf(g: GenInput): PassOption[] {
  if (g.passOpts === null) g.passOpts = passOptions(g.ctx.state, g.holder, g.ctx.config, g.ctx.pitch);
  return g.passOpts;
}

/** 이 후보를 실제로 차면 나갈 세기(#312). `planPass` 와 **같은 함수**를 쓴다(재구현 금지). */
function candidateSpeedFx(g: GenInput, o: PassOption): number {
  return passDelivery(g.ctx.state, g.holder, o, g.ctx.config).speedFx;
}

/**
 * 생성기 테이블. **`GENERATORS` 순서대로만** 실행한다(결정론: 후보 배열의 초기 순서가 상태의 함수로
 * 고정된다). S5 는 여기에 항목을 **뒤에** 추가한다.
 */
const GEN_FN: Record<GeneratorId, (g: GenInput, out: ActionCandidate[]) => void> = {
  // 슛: 사거리·xG 임계 안일 때만. 타깃은 아직 골 중앙 고정(조준점 분산은 S5).
  shoot: (g, out) => {
    const c = g.ctx.config;
    if (g.distToGoalM > c.contest.shootRange || g.xgHere < c.contest.shootXgThreshold) return;
    const speed = shotPowerFx(g.holder.attrs.shooting, c);
    const flight = speed > 0 ? Math.ceil(g.distToGoalFx / speed) : 0;
    out.push({
      kind: "shoot",
      form: "shoot",
      gen: "shoot",
      toXFx: g.goal.x,
      toYFx: g.goal.y,
      receiver: null,
      ballSpeedFx: speed,
      flightTicks: flight,
      durationTicks: flight,
      // 슛에는 아직 "레인" 개념이 없다(블록 판정은 contest 소관). Infinity = 레인 항 미적용.
      laneDangerFx: Infinity,
      forwardGainFx: g.distToGoalFx,
      distFx: g.distToGoalFx,
    });
  },
  // 다이렉트 패스 = 인식 반경 안 동료. long 과 **같은 `passOptions` 배열**을 나눠 갖는다.
  // #312: `ballSpeedFx` 가 드디어 **후보마다 다른 값**을 갖는다(구버전은 상수 하나). 세기는
  // `planPass` 가 실행 시 쓰는 것과 **같은 함수**로 뽑는다 — 후보의 비행틱 예측이 실제와 갈리지 않게.
  direct: (g, out) => {
    for (const o of passOptsOf(g)) {
      if (o.long) continue;
      out.push(toActionCandidate(o, "direct", "direct", candidateSpeedFx(g, o)));
    }
  },
  // 롱패스 = 반경 밖 의도적 롱볼(perception 이 이미 게이팅해 둔 것).
  long: (g, out) => {
    for (const o of passOptsOf(g)) {
      if (!o.long) continue;
      out.push(toActionCandidate(o, "long", "long", candidateSpeedFx(g, o)));
    }
  },
  // 캐리(드리블) — **방향은 아직 골 중앙 한 개다**(방향 후보화는 S5). 여기서 후보를 늘리면
  // 슛 위치 분포가 움직여 S2 의 "무회귀" 게이트가 성립하지 않는다.
  carry: (g, out) => {
    const c = g.ctx.config;
    const step = c.movement.dribbleReach;
    const tx = g.holder.posFx.x + Math.round((g.goal.x - g.holder.posFx.x) * step);
    const ty = g.holder.posFx.y + Math.round((g.goal.y - g.holder.posFx.y) * step);
    const cl = clampToPitch(g.ctx.pitch, tx, ty);
    const after = distToAttackGoal(g.ctx.pitch, g.holder.side, cl.x, cl.y);
    out.push({
      kind: "carry",
      form: "carry",
      gen: "carry",
      toXFx: cl.x,
      toYFx: cl.y,
      receiver: null,
      ballSpeedFx: 0,
      flightTicks: 0,
      durationTicks: 1,
      laneDangerFx: Infinity,
      forwardGainFx: g.distToGoalFx - after,
      distFx: fdist(g.holder.posFx.x, g.holder.posFx.y, cl.x, cl.y),
    });
  },
  // 걷어내기(#314 A) — **의도 수신자가 없는 좌표 타깃**. S2 가 "receiver 가 null 인 후보"를
  // 표현 가능하게 만들어 둔 자리의 첫 사용처다. 생성 조건은 롤백 경로와 **같은 함수**를 쓰고,
  // "좋은 패스가 있으면 안 한다"는 여기서 게이트가 아니라 **EV 비교**가 자동으로 한다.
  clear: (g, out) => pushClear(g, out, false),
  // 홀드(제자리).
  hold: (g, out) => {
    out.push({
      kind: "hold",
      form: "hold",
      gen: "hold",
      toXFx: g.holder.posFx.x,
      toYFx: g.holder.posFx.y,
      receiver: null,
      ballSpeedFx: 0,
      flightTicks: 0,
      durationTicks: 1,
      laneDangerFx: Infinity,
      forwardGainFx: 0,
      distFx: 0,
    });
  },
};

/**
 * 걷어내기 후보 push. `force` 는 #349 폴백 전용 — 재시작 틱에 킥 후보가 **하나도** 없을 때
 * (주변 패스 옵션 0 + 사거리 밖 + 걷어내기 부적격) 후보 배열이 비어 결정 코어가 설 자리가 없다.
 * 그때만 적격 판정을 건너뛴다. 새 행동을 만들지 않는 이유는 실행·이벤트·기하가 전부 기존
 * 경로와 **같은 함수**를 타게 하기 위해서다(두 코어가 갈릴 여지 0).
 */
function pushClear(g: GenInput, out: ActionCandidate[], force: boolean): void {
  const c = g.ctx.config;
  if (!force && !clearanceEligible(g.ctx.state, g.holder, c, g.ctx.pitch)) return;
  const aim = clearanceAim(g.holder, c, g.ctx.pitch);
  const speed = clearancePowerFx(g.holder, c);
  const d = fdist(g.holder.posFx.x, g.holder.posFx.y, aim.x, aim.y);
  const flight = speed > 0 ? Math.ceil(d / speed) : 0;
  const after = distToAttackGoal(g.ctx.pitch, g.holder.side, aim.x, aim.y);
  out.push({
    kind: "clear",
    form: "clear",
    gen: "clear",
    toXFx: aim.x,
    toYFx: aim.y,
    receiver: null,
    ballSpeedFx: speed,
    flightTicks: flight,
    durationTicks: flight,
    // 걷어내기에 "레인"은 없다 — 누구를 향해 차는 것이 아니다.
    laneDangerFx: Infinity,
    forwardGainFx: g.distToGoalFx - after,
    distFx: d,
  });
}

/**
 * **재시작(데드볼) 틱의 생성기 부분집합**(#349) — 킥만 남긴다. `carry`/`hold` 를 **함께** 뺀다:
 * 드리블만 막으면 `hold` 가 EV 로 이겨 재시작이 영원히 안 나가는 데드락(#231 계열)이 된다.
 * `GENERATORS` 와 **같은 상대 순서**를 유지한다(결정론: 후보 배열의 초기 순서가 상태의 함수).
 */
const RESTART_GENERATORS: readonly GeneratorId[] = GENERATORS.filter((g) => g !== "carry" && g !== "hold");

/**
 * 재귀 안쪽에서 도는 생성기 부분집합. 원본과 동일하게 **패스와 슛만** 본다 — 안쪽의 "제자리"는
 * 이미 `base`(상태 가치 자체)가 대표하고, 안쪽 드리블까지 펴면 분기폭이 곱으로 늘어난다.
 * `GENERATORS` 와 **같은 상대 순서**를 유지한다.
 */
const INNER_GENERATORS: readonly GeneratorId[] = GENERATORS.filter(
  (g) => g !== "carry" && g !== "hold" && g !== "clear",
);

function generate(
  ctx: SearchCtx,
  holder: SimPlayer,
  here: Hypo,
  gens: readonly GeneratorId[],
  root: boolean,
): ActionCandidate[] {
  const goal = attackGoal(ctx.pitch, holder.side);
  const { xg, distM } = xgAtPoint(
    here.side,
    here.xFx,
    here.yFx,
    here.shooting,
    here.fatigue,
    ctx.config,
    ctx.pitch,
  );
  const input: GenInput = {
    ctx,
    holder,
    here,
    xgHere: xg,
    distToGoalM: distM,
    distToGoalFx: distToAttackGoal(ctx.pitch, holder.side, here.xFx, here.yFx),
    goal,
    passOpts: null,
  };
  const out: ActionCandidate[] = [];
  for (const g of gens) {
    const before = out.length;
    GEN_FN[g](input, out);
    // 루트에서만 센다(picked 와 자릿수를 맞춘다 — action.ts:ChainProbe.generated 주석).
    if (root && ctx.probe) ctx.probe.generated[g] += out.length - before;
  }
  return out;
}

/* ------------------------------------------------------------------------- *
 * 평가 — 값싼 프리필터 → 빔 → EV → 노드 예산
 * ------------------------------------------------------------------------- */

/**
 * **값싼** 순위 스칼라(O(1), 선수 루프 없음). 상태 가치에서 `space` 항(= 22명 루프)만 뺀 것이라
 * EV 와 대체로 같은 방향을 가리키면서 비용이 0 에 가깝다. 빔에 들어갈 후보를 고르는 데만 쓰고,
 * **선택에는 절대 쓰지 않는다**(선택은 언제나 EV).
 */
function cheapScore(ctx: SearchCtx, cand: ActionCandidate, side: SimPlayer["side"], shooting: number, fatigue: number): number {
  const w = ctx.w;
  if (cand.kind === "shoot") {
    const { xg } = xgAtPoint(side, cand.toXFx, cand.toYFx, shooting, fatigue, ctx.config, ctx.pitch);
    return mulFrac(w.goalValueEv, toFrac(xg));
  }
  const pc = pointAt(ctx, cand.toXFx, cand.toYFx);
  const adv = side === "home" ? pc.advHome : pc.advAway;
  const { xg } = xgAtPoint(side, cand.toXFx, cand.toYFx, shooting, fatigue, ctx.config, ctx.pitch);
  return Math.round((w.advEv * adv + w.threatEv * toFrac(xg)) / FRAC_SCALE);
}

/** 후보의 도착 상태(가상) — 패스면 리시버, 캐리면 이동 후 지점, 홀드/슛이면 제자리. */
function arrivalHypo(cand: ActionCandidate, here: Hypo): Hypo {
  const r = cand.receiver;
  if (r) return { side: here.side, xFx: r.posFx.x, yFx: r.posFx.y, shooting: r.attrs.shooting, fatigue: r.fatigue };
  return { ...here, xFx: cand.toXFx, yFx: cand.toYFx };
}

/**
 * 후보 하나의 EV(정수).
 * @param depth  남은 탐색 깊이. `depth > 1` 이고 패스면 리시버의 다음 수까지 재귀.
 * @param recurse 재귀 빔에 들었는가(false 면 도착 상태 가치로 종결).
 * @param behavior 프롬프트 behavior 배수를 적용하는가(루트에서만 — 원본과 동일).
 */
function candidateEv(
  ctx: SearchCtx,
  holder: SimPlayer,
  here: Hypo,
  cand: ActionCandidate,
  depth: number,
  recurse: boolean,
  behavior: boolean,
): number {
  const w = ctx.w;
  ctx.nodes++;

  switch (cand.kind) {
    case "shoot": {
      const { xg } = xgAtPoint(here.side, here.xFx, here.yFx, here.shooting, here.fatigue, ctx.config, ctx.pitch);
      const xgFrac = toFrac(xg);
      let ev = mulFrac(w.goalValueEv, xgFrac) + mulFrac(turnoverEv(ctx, here), FRAC_SCALE - xgFrac);
      // 슛 성향(프롬프트 behavior)은 EV 를 곱으로 가감 — 전술 입력이 계속 살아 있어야 한다.
      if (behavior) ev = mulFrac(ev, toMul(0.5 + holder.behavior.shootTendency));
      return ev;
    }
    case "pass": {
      const opt = cand.opt as PassOption;
      const pFrac = toFrac(computePassProb(ctx.state, holder, opt, ctx.config, ctx.pitch));
      const succ = arrivalHypo(cand, here);
      const vSucc =
        recurse && depth > 1 && cand.receiver
          ? bestEvAt(ctx, cand.receiver, depth - 1)
          : evaluateStateEv(ctx, succ);
      let tov = turnoverEv(ctx, succ);
      // passRisk 성향: 리스크 감수형은 턴오버 항을 덜 무겁게 본다(전술 입력 유지).
      if (behavior) tov = mulFrac(tov, toMul(1.4 - holder.behavior.passRisk));
      let inner = mulFrac(vSucc, pFrac) + mulFrac(tov, FRAC_SCALE - pFrac);
      // #361 T1: **`passDirectness`(다이렉트함) 성향**. 유일한 소비자였던 `decision.ts:scoreOption`
      // 은 weighted 전용이라, 사슬 기본(0.24.0~)에서 이 지시는 **절반만** 도달했다(`passRisk` 만
      // 먹혔다). 여기서 **롱 옵션의 EV** 를 가감한다 — `shootTendency`(위)와 동형.
      // 롱에만 거는 이유: "다이렉트하게" 는 "길게 앞으로" 라는 뜻이고, 숏까지 같이 올리면
      // 그건 패스 자체의 가중이라 축이 아니다.
      if (behavior && opt.long && ctx.config.chain.passDirectnessEnabled) {
        inner = mulFrac(inner, toMul(0.5 + holder.behavior.passDirectness));
      }
      // 할인: 패스도 한 수를 쓰는 행동이다(슛/드리블과 같은 자에 놓으려면 여기서 깎아야 한다).
      return mulFrac(inner, w.discountFrac);
    }
    case "carry": {
      const after = arrivalHypo(cand, here);
      // 공간이 좁을수록 드리블 성공률이 떨어진다(근접 상대 거리로 스케일).
      const ndM = fromFixed(
        Math.min(nearestOppDist(ctx, here.side, here.xFx, here.yFx), w.spaceRefFx),
        ctx.config.fixedScale,
      );
      const p = fclamp(ctx.config.chain.dribbleSuccess * (0.4 + 0.6 * (ndM / ctx.config.chain.spaceRefM)), 0.05, 0.98);
      const pFrac = toFrac(p);
      let ev = mulFrac(evaluateStateEv(ctx, after), pFrac) + mulFrac(turnoverEv(ctx, here), FRAC_SCALE - pFrac);
      if (behavior) ev = mulFrac(ev, toMul(0.5 + holder.behavior.dribbleTendency));
      return ev;
    }
    case "clear": {
      // 걷어내기(#314 A): 의도 수신자가 없으니 "성공 확률"이 아니라 **회수 확률**이다
      // (`clearance.retainProb` — 루즈볼이라 50% 근처). 여기서 사슬 코어가 축구를 정확히 표현한다:
      // 낙하점(자기 진영 밖)에서 뺏기는 손해는 **지금 이 자리(자기 박스)에서 뺏기는 손해보다 작다** —
      // `turnoverEv` 가 위치의 함수라 별도 노브 없이 그 대소가 나온다.
      const after = arrivalHypo(cand, here);
      const pFrac = toFrac(ctx.config.clearance.retainProb);
      let ev =
        mulFrac(evaluateStateEv(ctx, after), pFrac) + mulFrac(turnoverEv(ctx, after), FRAC_SCALE - pFrac);
      // 리스크 감수 성향(passRisk)이 높은 선수는 덜 걷어낸다(전술 입력이 계속 살아 있어야 한다).
      if (behavior) {
        ev = mulFrac(ev, toMul(ctx.config.clearance.chainEvBias * (1.5 - holder.behavior.passRisk)));
      }
      return ev;
    }
    default: {
      /**
       * 홀드(#353) — 다른 행동과 **같은 형태**로 평가한다:
       *   `EV = p_keep × (V(here) − holdPenalty) + (1 − p_keep) × V(턴오버)`
       *
       * 구 형태는 `V(here) − holdPenalty` 뿐이라 **실패 항이 없었다** = 뺏길 수 없는 선택지.
       * 그래서 슛 사거리 안 결정의 72% 가 hold 였다. 평평한 상수를 키우는 것으로는 못 고친다 —
       * 그러면 "혼자일 때 볼을 지키는" 정상 플레이까지 같이 죽는다. `p_keep` 이 압박에
       * 반응하므로 자유로우면 지키는 것이 여전히 최적이고, 붙으면 무언가 해야 한다.
       *
       * `holder`/`here` 는 여기서 언제나 **실제 볼 소유자와 그의 실제 좌표**다 — hold 생성기는
       * 루트에서만 돈다(`INNER_GENERATORS` 가 제외). 즉 가상 지점에서 압박을 재는 일이 없다.
       */
      const keepFrac = toFrac(holdKeepProb(ctx.state, holder, ctx.config));
      const stay = evaluateStateEv(ctx, here) - w.holdPenaltyEv;
      return mulFrac(stay, keepFrac) + mulFrac(turnoverEv(ctx, here), FRAC_SCALE - keepFrac);
    }
  }
}

/**
 * 홀드 유지 확률 `p_keep`(0..1) — 압박의 **인원과 거리** 둘 다에 반응한다(#353).
 *
 * 밀착(`tightRangeM`)은 근접(`pressRangeM`)에도 같이 세이므로 두 페널티가 **누적**된다 =
 * 같은 1명이라도 5m 와 1m 가 다른 값을 받는다. 측정은 `pressureCount` 재사용(압박의 정의는
 * 패스·걷어내기와 하나여야 한다).
 *
 * 계약·진단이 이 함수를 직접 부른다 — EV 를 통해서만 관측하면 "홀드가 줄었다"의 원인이
 * 이 항인지 다른 항인지 귀속할 수 없다.
 */
export function holdKeepProb(state: SimState, holder: SimPlayer, config: EngineConfig): number {
  const h = config.chain.hold;
  const near = pressureCount(state, holder, config, h.pressRangeM);
  const tight = pressureCount(state, holder, config, h.tightRangeM);
  return fclamp(h.keepBase - h.pressPenalty * near - h.tightPenalty * tight, h.minKeep, 1);
}

/**
 * 빔 결과. **후보 배열 + 재귀 허용 경계 인덱스**로 표현한다(후보마다 래퍼 객체를 만들지 않는다 —
 * depth-2 에서 결정당 130개 넘게 생기고, 그게 곧 GC 압력이다).
 * `list[i]` 는 `i < recurseTop` 일 때만 재귀한다.
 */
interface Beamed {
  list: ActionCandidate[];
  recurseTop: number;
}

/**
 * 값싼 스칼라로 순위를 매긴 뒤 상위 `beamTop` 만 남긴다. 정렬은 **전순서**(점수 → candidateKey).
 *
 * ## 순위가 결과에 영향을 줄 수 있는 경우는 셋뿐이다
 *  (1) 빔이 후보를 자를 때, (2) 재귀 빔이 자를 때, (3) 노드 예산이 이 레벨에서 걸릴 때.
 * 셋 다 아니면 **모든 후보가 똑같이 평가되고 선택은 EV 로만 결정**되므로 순위는 관측 불가능하다.
 * 그때는 값싼 점수 계산과 정렬을 통째로 생략한다(= 생성 순서 유지).
 *
 * (3)을 **정확히** 판정할 수 있는 조건이 `depth <= 1` 이다 — 그 레벨에는 재귀가 없어 후보 하나가
 * 정확히 노드 1개이므로 `nodes + n <= maxNodes` 면 예산이 절대 안 걸린다. 재귀가 있는 레벨(루트)은
 * 자식이 몇 노드를 먹을지 미리 모르므로 항상 순위를 매긴다(결정당 1회라 비용이 무시할 만하다).
 * 이 생략이 없으면 depth-2 에서 **매 리시버마다** 정렬이 돌아 사슬 코어가 12% 느려진다(실측).
 */
function beam(ctx: SearchCtx, cands: ActionCandidate[], here: Hypo, depth: number): Beamed {
  const n = cands.length;
  const s = ctx.config.chain.search;
  const clipBeam = s.beamTop > 0 && s.beamTop < n;
  const clipRecurse = s.recurseBeam > 0 && s.recurseBeam < n;
  const budgetSafe = depth <= 1 && ctx.nodes + n <= ctx.maxNodes;
  if (!clipBeam && !clipRecurse && budgetSafe) {
    return { list: cands, recurseTop: n };
  }

  const scored = cands.map((c) => {
    const a = arrivalHypo(c, here);
    return { c, s: cheapScore(ctx, c, here.side, a.shooting, a.fatigue) };
  });
  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    const ka = candidateKey(a.c);
    const kb = candidateKey(b.c);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const top = clipBeam ? s.beamTop : scored.length;
  if (top < scored.length) ctx.beamClipped = true;
  const recurseTop = s.recurseBeam > 0 && s.recurseBeam < top ? s.recurseBeam : top;
  if (recurseTop < top) ctx.recurseClipped = true;
  const list: ActionCandidate[] = [];
  for (let i = 0; i < top; i++) list.push(scored[i]!.c);
  return { list, recurseTop };
}

/**
 * 깊이 d 에서 "이 지점에서 이 사람이 낼 수 있는 최선의 EV". 재귀 종료(d<=0)면 상태 가치 자체.
 */
function bestEvAt(ctx: SearchCtx, holder: SimPlayer, depth: number): number {
  const h: Hypo = {
    side: holder.side,
    xFx: holder.posFx.x,
    yFx: holder.posFx.y,
    shooting: holder.attrs.shooting,
    fatigue: holder.fatigue,
  };
  const base = evaluateStateEv(ctx, h);
  ctx.nodes++;
  if (depth <= 0) return base;

  let best = base;
  const cands = generate(ctx, holder, h, INNER_GENERATORS, false);
  const picked = beam(ctx, cands, h, depth);
  for (let i = 0; i < picked.list.length; i++) {
    if (ctx.nodes >= ctx.maxNodes) {
      ctx.budgetHit = true;
      break;
    }
    const ev = candidateEv(ctx, holder, h, picked.list[i]!, depth, i < picked.recurseTop, false);
    if (ev > best) best = ev;
  }
  return best;
}

/**
 * 사슬 탐색으로 볼 소유자 행동을 고른다. 반환은 기존 `Action` 과 **완전히 같은 계약**이라
 * match.ts 는 어느 코어인지 모른다(교체 가능).
 *
 * ## 노드 예산 컷오프가 결정론을 깨지 않는 이유
 * 컷오프가 위험한 유일한 경우는 "언제 끊기는지가 상태 외의 무언가에 달려 있을 때"다. 여기서는
 *  (1) 생성이 `GENERATORS` 고정 순서로 돌고,
 *  (2) 빔 정렬이 (값싼 점수 → `candidateKey`) 로 **전순서**이며(동점이 정수라 정확히 동점,
 *      그때 키가 유일하게 순서를 정한다),
 *  (3) 평가가 그 순서대로만 노드를 소비한다.
 * 즉 같은 상태에서는 **항상 같은 노드가 같은 순서로** 소진되고 같은 지점에서 끊긴다.
 * 통짜 실행과 재개(resume) 실행도 같은 상태에서 같은 호출을 하므로 동일하다.
 * (시간·난수·플랫폼 부동오차 중 어느 것도 컷오프 지점에 들어가지 않는다 — EV 는 정수다.)
 */
export function decideBallOwnerChain(
  state: SimState,
  owner: SimPlayer,
  rng: Rng,
  config: EngineConfig,
  pitch: Pitch,
): Action {
  const c = config.chain;
  const goal = attackGoal(pitch, owner.side);
  const ctx = newCtx(state, config, pitch);
  const here: Hypo = {
    side: owner.side,
    xFx: owner.posFx.x,
    yFx: owner.posFx.y,
    shooting: owner.attrs.shooting,
    fatigue: owner.fatigue,
  };
  // 반환 계약(Action.shoot.xg)에 필요한 값 — 생성기와 같은 함수·같은 인자라 값이 갈릴 수 없다.
  const { xg: rawXg, distM } = xgAtPoint(
    here.side, here.xFx, here.yFx, here.shooting, here.fatigue, config, pitch,
  );
  /**
   * 1대1(단독) 찬스 (#316) — **루트(= 실제 상태의 슈터 자리)에서만** 잰다.
   *
   * `GEN_FN.shoot` 안에서 재면 안 된다: 생성기는 `bestEvAt`/`arrivalHypo` 를 통해 **가상 도착
   * 지점**에서도 돌기 때문에, 거기서 1v1 기하를 재면 "상대가 그때까지 안 움직인다"는 가정이
   * EV 에 심긴다(가상 미래의 수비 배치를 현재 좌표로 읽는다).
   *
   * ## 설계 판단: 부스트는 **결과 xg 에만** 걸고 EV(선택)에는 반영하지 않는다
   *  - 루트에서만 재는 위 원칙과 정합한다. EV 공간은 도착 지점들을 비교하는 곳이고, 1v1 판정은
   *    "지금 이 자리"의 성질이라 그 비교에 넣을 자리가 없다.
   *  - 사슬 코어는 슛을 이미 `chain.goalValue × xG` 로 평가한다 — 선택 압력은 거기 있다.
   *  - 그래서 `contest.oneOnOneShootBias`(weighted 의 슛 가중 배수)는 **적용하지 않는다**:
   *    EV 공간에 자명한 대응물이 없고(가중치가 아니라 기대값이다), 넣으면 밸런스 레버가
   *    `goalValue` 와 이중이 된다. `decisionWeights.shoot` 이 chain 에서 무효인 것과 같은 이유다.
   *  - 대가: "선택은 원 xG 로, 결과는 부스트로" 갈린다. 부스트가 EV 를 통해 슛 **빈도**까지
   *    밀지 않으므로 볼륨(팀당 슛) 재보정이 필요 없다 — 움직이는 것은 골 계열뿐이다.
   */
  const oo = oneOnOneShot(state, owner, rawXg, distM, config);

  // #349: 재시작 틱이면 **킥 후보만** 만든다(Law 8/13/15/16). 사슬 코어는 `state.setPiece` 를
  // 보지 않아 재시작에도 carry 를 그대로 만들었고, EV 가 그걸 이겨 프리킥 재개의 78.5% 가
  // 드리블이었다. 규칙은 EV 로 협상할 대상이 아니라 **후보 공간의 제약**이라 여기서 건다.
  const mustKick = restartRequiresKick(state, config);
  const cands = generate(ctx, owner, here, mustKick ? RESTART_GENERATORS : GENERATORS, true);
  if (mustKick && cands.length === 0 && config.rules.restart.fallbackKick) {
    // 킥 후보가 하나도 없다(패스 옵션 0 + 사거리 밖 + 걷어내기 부적격). 후보 배열이 비면
    // 결정 코어가 설 자리가 없으므로 걷어내기를 무조건 하나 넣는다 — 재시작은 나가야 한다.
    const goalHere = attackGoal(pitch, owner.side);
    pushClear(
      {
        ctx, holder: owner, here,
        xgHere: rawXg,
        distToGoalM: distM,
        distToGoalFx: distToAttackGoal(pitch, owner.side, here.xFx, here.yFx),
        goal: goalHere,
        passOpts: null,
      },
      cands,
      true,
    );
  }
  const beamed = beam(ctx, cands, here, c.depth);

  // EV 평가 — 예산에 닿으면 그 시점 best 로 확정. **최소 1개는 평가한다**(첫 후보는 무조건).
  const scored: { cand: ActionCandidate; ev: number }[] = [];
  for (let i = 0; i < beamed.list.length; i++) {
    if (i > 0 && ctx.nodes >= ctx.maxNodes) {
      ctx.budgetHit = true;
      break;
    }
    const b = beamed.list[i]!;
    scored.push({ cand: b, ev: candidateEv(ctx, owner, here, b, c.depth, i < beamed.recurseTop, true) });
  }

  // 정렬은 **완전 전순서**여야 한다. 구버전은 마지막 단계가 `a < b ? -1 : 1` 이라 **완전 동점에서
  // 양방향 모두 1** 을 반환했다(비일관 비교자) — shoot/carry/hold 는 receiver 가 없어 실제로 동점이
  // 발생한다. 비일관 비교자에서 `Array.prototype.sort` 결과는 **구현 정의**라 엔진/버전 간 순서가
  // 갈릴 수 있다(= 무음 desync). 좌표 타깃 후보(receiver 없음)를 넣으면 더 흔해진다.
  // EV 가 정수라 "동점"이 정확히 동점이고, 그때 candidateKey 가 유일하게 순서를 정한다.
  scored.sort((a, b) => {
    if (b.ev !== a.ev) return b.ev - a.ev;
    const ka = candidateKey(a.cand);
    const kb = candidateKey(b.cand);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });

  let picked = scored[0]!;
  if (c.temperature > 0 && scored.length > 1) {
    const k = Math.max(1, Math.min(scored.length, 1 + Math.round(c.temperature * (scored.length - 1))));
    const floor = scored[k - 1]!.ev;
    const eps = Math.round(0.05 * EV_SCALE);
    let total = 0;
    for (let i = 0; i < k; i++) total += scored[i]!.ev - floor + eps;
    let rr = rng.next() * total;
    for (let i = 0; i < k; i++) {
      rr -= scored[i]!.ev - floor + eps;
      if (rr < 0) {
        picked = scored[i]!;
        break;
      }
    }
  }

  if (ctx.probe) {
    const p = ctx.probe;
    p.decisions += 1;
    if (mustKick) p.restarts += 1;
    p.picked[picked.cand.gen] += 1;
    p.evalNodes += ctx.nodes;
    if (cands.length > p.maxCandidates) p.maxCandidates = cands.length;
    if (ctx.beamClipped) p.beamClipped += 1;
    if (ctx.recurseClipped) p.recurseClipped += 1;
    if (ctx.budgetHit) p.budgetHit += 1;
  }

  const cand = picked.cand;
  switch (cand.kind) {
    case "shoot": {
      // #312: 슛도 세기·조준 오차를 탄다(weighted 코어와 **같은 함수** — 두 코어가 갈리지 않게).
      const sp = planShot(state, owner, config, rng, pitch);
      // #316: 부스트된 xg 와 `detail` 을 **둘 다** 실어야 한다 — detail 이 빠지면 이벤트가 소실되고
      // (하이라이트 사망), xg 가 빠지면 부스트 안 된 값이 flight 를 타고 골 롤까지 간다.
      // #353: 그 위에 압박 감산(같은 축의 반대편 — 1v1 부스트와 상호 배타적이라 이중 계상이 없다:
      // `oneOnOneShot` 이 부스트하는 조건은 반경 안 상대 0명이고, 그때 `shotPressureXg` 는 no-op 다).
      return {
        kind: "shoot",
        xg: shotPressureXg(state, owner, oo.xg, config),
        toX: sp.toX,
        toY: sp.toY,
        speedFx: sp.speedFx,
        detail: oo.detail,
      };
    }
    case "pass": {
      const opt = cand.opt as PassOption;
      const plan = planPass(state, owner, opt, config, rng, pitch);
      return {
        kind: "pass",
        receiver: opt.receiver,
        toX: plan.toX,
        toY: plan.toY,
        outcome: plan.outcome,
        long: opt.long,
        claimant: plan.claimant,
        speedFx: plan.speedFx,
        lofted: plan.lofted,
      };
    }
    case "carry":
      return { kind: "dribble", toX: cand.toXFx, toY: cand.toYFx, forecast: forecastOf(ctx, owner, scored, config) };
    case "clear": {
      // 실행은 롤백 경로와 **같은 함수** — 두 코어의 걷어내기 기하가 갈리지 않는다.
      const cp = planClearance(owner, config, rng, pitch);
      return { kind: "clearance", toX: cp.toX, toY: cp.toY, speedFx: cp.speedFx, lofted: cp.lofted };
    }
    default:
      return { kind: "hold", forecast: forecastOf(ctx, owner, scored, config) };
  }
}

/**
 * **예고 패스**(#369) — 캐리어가 아직 안 찼을 때, 사슬이 **이미 계산한** 후보 중 최상위 패스를
 * 그대로 돌려준다.
 *
 * ## 왜 새 예측기를 안 만드나
 * hero 요구는 *"받는 쪽이 패스하는 사람의 생각을 예측"* 인데, 캐리어의 사슬은 이 틱에 이미
 * 그 생각을 **정수 EV 로 다 계산해 뒀다**. 리시버가 같은 탐색을 다시 돌리면 비용이 22배가 되고
 * 결과도 같다. **계산을 다시 하지 말고 게시한다** — 그게 이 설계의 전부다.
 *
 * ## 결정론
 * `scored` 는 이미 전순서로 정렬돼 있다(EV → `candidateKey`). 여기서 **읽기만** 하므로
 * RNG 도, 상태 변경도 없다. 예고를 만드는 것 자체는 동작을 바꾸지 않고,
 * 바꾸는 것은 `match.ts` 가 그걸 게시하고 동료가 읽는 단계다.
 */
function forecastOf(
  ctx: SearchCtx,
  owner: SimPlayer,
  scored: { cand: ActionCandidate; ev: number }[],
  config: EngineConfig,
): PassForecast | undefined {
  if (!config.movement.passPlan.enabled) return undefined;
  for (const s of scored) {
    if (s.cand.kind !== "pass" || !s.cand.receiver) continue;
    const opt = s.cand.opt as PassOption;
    // 실행 시 조준(`planPass`)은 Rng 를 소비하므로 여기서 부르면 안 된다 — 예고는 **후보의
    // 계획 좌표**(오차 이전)를 쓴다. 어차피 리시버가 "어디로 올 것 같다"만 알면 되는 값이다.
    return {
      receiverId: opt.receiver.id,
      toX: s.cand.toXFx,
      toY: s.cand.toYFx,
      speedFx: s.cand.ballSpeedFx,
    };
  }
  return undefined;
}
