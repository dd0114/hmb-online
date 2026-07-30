import type { EngineConfig } from "./config";
import type { Rng } from "./rng";
import type { Pitch } from "./pitch";
import { fclamp, isqrt, toFixed } from "./fixedmath";

/**
 * kick — 공을 **차는 행위**의 물리: 세기(얼마나 세게)와 정확도(의도 vs 실제).
 *
 * 왜 별도 모듈인가: 이 두 가지를 `decision.ts`(패스)·`contest.ts`(헤더/크로스)·`match.ts`(슛)이
 * 전부 필요로 한다. 한쪽에 두면 나머지가 복붙하고, 복붙하면 "패스만 오차가 있고 슛은 없는"
 * 드리프트가 생긴다(#312 의 출발점이 정확히 그 모양이었다 — 속도 상수가 3곳에 흩어져 있었다).
 *
 * ## 결정론 규율
 * `Math.sin/cos/tan/pow/exp` **런타임 금지**(명세상 구현 근사 = 플랫폼 편차, 로드맵 §5-4).
 * 각도가 필요하므로 **정수 탄젠트 테이블**을 리터럴로 박아 둔다(`deadball.ts:RAY_DIRS` 와 같은 규율).
 * 그리고 회전 대신 **수직 오프셋**으로 각도 오차를 표현한다 — 거리 L 에서 각도 θ 만큼 빗나간
 * 지점은 진행 방향의 수직으로 `L·tanθ` 떨어진 점이고, 수직 벡터는 `(-dy, dx)` 라 곱셈만으로 나온다.
 * (`sin/cos` 가 아예 등장하지 않는다.)
 */

/**
 * tan(deg) × 10000, deg = 0..30 정수. **리터럴 상수**다(로드 시 계산하지 않는다 — 계산하면
 * `Math.tan` 을 다시 부르는 것이고 그러면 정수 테이블을 쓰는 의미가 없다).
 */
const TAN_10K: readonly number[] = [
  0, 175, 349, 524, 699, 875, 1051, 1228, 1405, 1584, 1763,
  1944, 2126, 2309, 2493, 2679, 2867, 3057, 3249, 3443, 3640,
  3839, 4040, 4245, 4452, 4663, 4877, 5095, 5317, 5543, 5774,
];

/** 각도(도) → tanθ × 10000. 정수 테이블 선형보간(테이블 밖은 양끝으로 클램프). */
export function tanX10k(deg: number): number {
  if (deg <= 0) return 0;
  const last = TAN_10K.length - 1;
  if (deg >= last) return TAN_10K[last]!;
  const i = Math.floor(deg);
  const frac = deg - i;
  const a = TAN_10K[i]!;
  const b = TAN_10K[i + 1]!;
  return a + (b - a) * frac;
}

/** 대칭 오차 계수 [-1, 1). Rng 1회 소모. */
function signedRoll(rng: Rng): number {
  return rng.next() * 2 - 1;
}

export interface AimErrorInput {
  /** 유효 조준 오차 각도(도). 0 이면 정확히 의도대로. */
  errDeg: number;
  /** 세기 오차 비율(의도 거리 대비 ±). 0 이면 세기 정확. */
  powerErrFrac: number;
}

/**
 * 의도 지점을 **조준 오차만큼 흔든** 실제 도달 지점.
 *
 * 오차는 두 축이다:
 *  - **각도**: 진행 방향의 수직으로 `L·tan(errDeg)·u` (u ∈ [-1,1)) — 좌우로 빗나감.
 *  - **세기**: 진행 거리 자체를 `1 ± powerErrFrac·u` 로 — 짧게 끊기거나 길게 넘어감.
 *
 * Rng 를 **항상 2회** 소모한다(분기별로 다르면 재개 시 소비 순서가 갈린다).
 */
export function aimWithError(
  fromX: number,
  fromY: number,
  aimX: number,
  aimY: number,
  err: AimErrorInput,
  rng: Rng,
): { x: number; y: number } {
  const lateralRoll = signedRoll(rng);
  const powerRoll = signedRoll(rng);
  const dx = aimX - fromX;
  const dy = aimY - fromY;
  if (dx === 0 && dy === 0) return { x: aimX, y: aimY };
  // 수직 성분 계수: tanθ·u. (-dy, dx) 가 (dx, dy) 의 수직이고 길이가 같으므로 정규화가 필요 없다.
  const k = (tanX10k(err.errDeg) * lateralRoll) / 10000;
  const s = 1 + err.powerErrFrac * powerRoll;
  return {
    x: fromX + Math.round(dx * s - dy * k),
    y: fromY + Math.round(dy * s + dx * k),
  };
}

/**
 * 유효 조준 오차 각도 — 기본 각도가 **능력치로 줄고 압박으로 커진다**.
 * (hero H1: "확률적 + 상대선수의 압박정도에 따라 의도한대로 나가거나 흔들리거나")
 */
export function aimErrorDeg(
  baseDeg: number,
  attr: number,
  attrSwing: number,
  pressers: number,
  pressurePenalty: number,
): number {
  const skill = 1 - attrSwing * ((attr - 50) / 50);
  const press = 1 + pressurePenalty * pressers;
  return Math.max(0, baseDeg * skill * press);
}

/**
 * 패스 **세기**(fixed m/tick) — 선수가 정한다.
 *  - 거리: 발밑에 붙이는 짧은 패스는 살살, 라인을 넘기는 긴 패스는 세게(선형).
 *  - 능력치(passing): 잘 차는 선수가 더 강하게 정확히 보낸다.
 *  - 압박: 급하게 차면 힘이 안 실린다.
 * 구버전은 이 전부가 없는 상수 18 이었다(#312).
 */
export function passPowerFx(
  distFx: number,
  passing: number,
  pressers: number,
  config: EngineConfig,
): number {
  const b = config.ball;
  const distM = distFx / config.fixedScale;
  const t = fclamp(distM / b.passSpeedFullDistM, 0, 1);
  let v = b.passSpeedMin + (b.passSpeedMax - b.passSpeedMin) * t;
  v *= 1 + config.contest.passPowerAttrSwing * ((passing - 50) / 50);
  v *= 1 - config.contest.passPressurePowerPenalty * pressers;
  return toFixed(Math.max(1, v), config.fixedScale);
}

/**
 * 슛 **세기**(fixed m/tick, #312). 기준(`contest.shotBallSpeed`)에 shooting 능력치 스윙.
 * 사슬 후보 생성기와 `planShot` 이 **같은 함수**를 써야 비행틱 예측이 실제와 갈리지 않는다.
 */
export function shotPowerFx(shooting: number, config: EngineConfig): number {
  const c = config.contest;
  const v = c.shotBallSpeed * (1 + c.passPowerAttrSwing * ((shooting - 50) / 50));
  return toFixed(Math.max(1, v), config.fixedScale);
}

/** 이 거리·의도의 패스를 **띄워서** 보내는가(#306). 롱볼은 거리와 무관하게 항상 lofted. */
export function isLofted(distFx: number, long: boolean, config: EngineConfig): boolean {
  if (long) return true;
  return distFx >= toFixed(config.ball.loftMinDistM, config.fixedScale);
}

/** lofted 면 수평 속도를 낮춘다(아치로 가면 같은 거리를 더 오래 난다 = 체공). */
export function deliverySpeedFx(speedFx: number, lofted: boolean, config: EngineConfig): number {
  if (!lofted) return speedFx;
  return Math.max(1, Math.round(speedFx * config.ball.loftSpeedMult));
}

/**
 * **오버힛으로 라인 밖**(fail_out) 도달점 — 의도 방향 그대로 피치 밖까지 지나간 지점.
 *
 * 구버전은 "수신자에서 가장 가까운 경계 밖을 **정조준**" 했다. 그건 조준 오차가 아니라
 * 다른 목표를 정확히 맞히는 것이라, 공이 리시버와 무관한 방향으로 꺾여 나갔다(#312 hero H1).
 * 여기서는 **같은 방향으로 너무 세게 찬 결과**로 만든다 — 광선이 경계를 만나는 지점 + 여유.
 */
export function overhitOut(
  fromX: number,
  fromY: number,
  aimX: number,
  aimY: number,
  pitch: Pitch,
  marginFx: number,
): { x: number; y: number } {
  const dx = aimX - fromX;
  const dy = aimY - fromY;
  const len = isqrt(dx * dx + dy * dy);
  if (len === 0) return { x: aimX, y: aimY };
  // 광선이 사각형을 처음 벗어나는 파라미터 t(>1 이면 조준점 너머). 정수 나눗셈 없이 비율로.
  let tBest = Infinity;
  const consider = (num: number, den: number): void => {
    if (den === 0) return;
    const t = num / den;
    if (t > 0 && t < tBest) tBest = t;
  };
  if (dx < 0) consider(0 - fromX, dx);
  if (dx > 0) consider(pitch.wFx - fromX, dx);
  if (dy < 0) consider(0 - fromY, dy);
  if (dy > 0) consider(pitch.hFx - fromY, dy);
  if (!Number.isFinite(tBest)) return { x: aimX, y: aimY };
  // 경계 교점에서 방향으로 margin 만큼 더 나간 지점 = 확실히 밖.
  const bx = fromX + dx * tBest;
  const by = fromY + dy * tBest;
  return {
    x: Math.round(bx + (dx * marginFx) / len),
    y: Math.round(by + (dy * marginFx) / len),
  };
}
