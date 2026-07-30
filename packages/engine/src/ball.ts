import type { EngineConfig } from "./config";
import type { Ball, BallFlight } from "./simstate";
import type { Pitch } from "./pitch";
import { isqrt, toFixed } from "./fixedmath";

/**
 * ball — 공의 **물리**(고정소수 정수). #320 에서 목표점 보간을 걷어내고 속도 벡터로 재작성했다.
 *
 * ## 한 줄 요약
 *   구: `pos = stepToward(pos, 목표, speed)`  — 어디에 멈출지 먼저 정하고 거기까지 걸어간다.
 *   신: `pos += v ; v *= friction`            — 방향×세기로 차고, 마찰이 언제 멈출지 정한다.
 *
 * ## 왜 바꿨나 (hero 실관전 #320)
 * "슛이나 공이 뜨면 **직선으로 꽂혀야** 되는데 지금은 **정지될 위치를 먼저 잡고 공이 점점 정지**
 * 하는 느낌이야." — 실측이 그대로 뒷받침했다. `stepToward` 는 목표를 넘지 않으므로 마지막 틱이
 * **잘린 부분스텝**이 되고(`12.6 → 0.9`), 그 뒤 `contest.settle()` 이 속도를 25% 로 **되올려**
 * (`0.9 → 3.1`) 궤적이 비단조로 요동했다. 속도 벡터는 그 두 가지가 **구조적으로 불가능**하다:
 * 스텝은 마찰 배수만큼만 줄고(단조), 목표점이라는 개념이 운동에 없다.
 *
 * ## 이 재작성이 #181 을 자동으로 만족시키는 이유
 * #181 계약은 "빈 공간에서 공이 스스로 꺾이지 않는다"이다. 속도 벡터는 **접촉이 없으면 방향이
 * 바뀌지 않는다** — 마찰은 크기만 줄이는 스칼라 곱이라 방향에 손대지 않는다. 구조가 계약이다.
 *
 * ## 결정론
 * 좌표·속도는 전부 고정소수 정수. `Math.pow/exp/sin/cos` 없음(마찰은 틱당 곱 1회).
 * 방향 정규화는 `isqrt` 로만 한다.
 */

/** 공이 넘은 경계. left/right = 골라인(x), top/bottom = 사이드라인(y). */
export interface OutCross {
  edge: "left" | "right" | "top" | "bottom";
  x: number;
  y: number;
}

export interface AdvanceResult {
  /** 경계를 넘어 아웃. null 이면 인플레이. */
  out: OutCross | null;
  /** 이번 틱 이동의 **시작점**(fixed) — 스윕 접촉 판정(`nearestOnSweep`)의 선분 시작. */
  fromX: number;
  fromY: number;
  /**
   * **계획 낙하점을 지났다** — 계획 창(passOutcome) 이 끝나는 신호.
   * 구버전의 "도착(arrived)"을 대체하지만 의미가 다르다: 공은 여기서 **멈추지 않는다**.
   * 슛에서는 골문 도달(= 판정 시점)을 뜻한다.
   */
  passedPlan: boolean;
  /** 속도가 정지 임계 아래로 떨어져 이 틱에 멈췄다(자연 정지). */
  stopped: boolean;
}

/** 공이 owner 에게 붙어 이동(드리블/홀드). */
export function glueBallToOwner(ball: Ball, ownerX: number, ownerY: number): void {
  ball.posFx.x = ownerX;
  ball.posFx.y = ownerY;
}

/**
 * **공을 찬다** — 조준점은 *방향*을 정하는 데만 쓰고, 운동은 `방향 × 세기`로 준다(#320).
 *
 * 구버전은 조준점을 `toX/toY` 에 넣어 놓고 그 점을 향해 보간했다(= 도달점이 권위). 여기서는
 * 조준점에서 **단위 방향만** 뽑아 속도 벡터를 만든다 — 그 뒤로 공이 어디까지 가는지는 세기와
 * 마찰이 정한다. `toX/toY` 는 계획 낙하점으로 함께 실려 가지만 **운동에는 관여하지 않는다**.
 *
 * 방향 정규화는 `isqrt` 기반 정수 산술이다(§5-4: sin/cos/pow 런타임 금지).
 */
export function kickBall(
  fromX: number,
  fromY: number,
  aimX: number,
  aimY: number,
  speedFx: number,
  rest: Omit<BallFlight, "toX" | "toY" | "vxFx" | "vyFx" | "speed" | "fromX" | "fromY">,
): BallFlight {
  const dx = aimX - fromX;
  const dy = aimY - fromY;
  const len = isqrt(dx * dx + dy * dy);
  const v = Math.max(0, speedFx);
  return {
    ...rest,
    toX: aimX,
    toY: aimY,
    // len 0(제자리 조준)이면 속도 0 — 공은 그 자리에 있고 다음 틱 판정으로 넘어간다.
    vxFx: len > 0 ? Math.round((dx * v) / len) : 0,
    vyFx: len > 0 ? Math.round((dy * v) / len) : 0,
    speed: len > 0 ? v : 0,
    fromX,
    fromY,
  };
}

/**
 * 이 공의 **틱당 마찰 배수**(0..1). 종류별로 다르다(#320):
 *  - `shot`   강타. 골문까지 사실상 등속으로 **꽂힌다**(hero: "직선으로 꽂혀야").
 *  - lofted   떠 있는 공은 잔디에 닿지 않는다 — 공기저항만이라 거의 안 줄어든다.
 *  - ground   잔디 구름 마찰. 루즈볼이 굴러가다 서는 것은 **여기 하나로만** 결정된다.
 *
 * 하드코딩 금지(§2-4) — 세 값 모두 `EngineConfig.ball.friction`.
 */
function frictionOf(f: BallFlight, config: EngineConfig): number {
  const fr = config.ball.friction;
  if (f.kind === "shot") return fr.shot;
  return f.delivery === "lofted" ? fr.lofted : fr.ground;
}

/** 선분 (fx,fy)->(tx,ty) 이 피치 경계를 처음 넘는 교점. 끝점이 안이면 null. */
function boundaryCross(
  fx: number,
  fy: number,
  tx: number,
  ty: number,
  pitch: Pitch,
): OutCross | null {
  const w = pitch.wFx;
  const h = pitch.hFx;
  if (tx >= 0 && tx <= w && ty >= 0 && ty <= h) return null;
  const dx = tx - fx;
  const dy = ty - fy;
  let bestT = Infinity;
  let best: OutCross | null = null;
  const consider = (t: number, edge: OutCross["edge"], cx: number, cy: number): void => {
    // #181: t=0(현재 위치가 이미 그 라인 위)도 허용한다. 스로인 재시작은 taker 를 사이드라인
    // **위**(y=0 또는 y=h)에 세우므로, 거기서 밖으로 찬 공은 크로싱 파라미터가 정확히 0 이라
    // 구 `t > 0` 조건에서 걸러졌다 → 아웃 판정이 통째로 누락되고 공이 피치 밖을 날아간 뒤
    // 소유 이전으로 필드 안으로 되돌아 순간이동(=빈 공간 꺾임)했다.
    // 잘못된 t=0 검출(라인 위에서 **안쪽**으로 차는 정상 스로인)은 아래 방향 가드가 막는다.
    //
    // #320: 속도 기반에서도 이 판정은 **한 틱 이동 선분**을 그대로 받는다(바뀐 것은 끝점을
    // 무엇으로 만드느냐뿐: `stepToward` → `pos + v`). 그래서 t=0 성질도 그대로 유효하다.
    if (t < 0 || t > 1) return;
    if (cx < -1 || cx > w + 1 || cy < -1 || cy > h + 1) return;
    if (t < bestT) {
      const px = cx < 0 ? 0 : cx > w ? w : cx;
      const py = cy < 0 ? 0 : cy > h ? h : cy;
      bestT = t;
      best = { edge, x: Math.round(px), y: Math.round(py) };
    }
  };
  // 방향 가드: 각 라인은 **그 라인 밖으로 나가는 방향**일 때만 크로싱 후보다(위 t=0 허용의 짝).
  if (dx < 0) {
    const t = (0 - fx) / dx;
    consider(t, "left", 0, fy + dy * t);
  }
  if (dx > 0) {
    const t = (w - fx) / dx;
    consider(t, "right", w, fy + dy * t);
  }
  if (dy < 0) {
    const t = (0 - fy) / dy;
    consider(t, "top", fx + dx * t, 0);
  }
  if (dy > 0) {
    const t = (h - fy) / dy;
    consider(t, "bottom", fx + dx * t, h);
  }
  return best;
}

/**
 * 공이 **계획 낙하점을 지났는가** — 발사 방향 위에서 계획 거리만큼 갔는지의 정수 내적 판정.
 * 제곱근도 나눗셈도 없다. 발사점(`fromX/fromY`)이 없으면 판단 근거가 없으므로 false.
 */
function passedPlanPoint(f: BallFlight, x: number, y: number): boolean {
  if (f.fromX == null || f.fromY == null) return false;
  const dx = f.toX - f.fromX;
  const dy = f.toY - f.fromY;
  const planSq = dx * dx + dy * dy;
  if (planSq === 0) return true; // 제자리 계획 = 이미 지났다.
  const px = x - f.fromX;
  const py = y - f.fromY;
  return px * dx + py * dy >= planSq;
}

/**
 * 비행 중인 공을 한 틱 전진 — **속도 벡터 적분**(#320).
 *
 *   1) `pos += v` (직선. 목표를 향해 방향을 틀지 않는다 → #181 "빈 공간 꺾임" 구조적 0)
 *   2) 경계를 넘었으면 교점에 세우고 out
 *   3) `v *= friction` (종류별) → 임계 미만이면 자연 정지
 *
 * 슛만 예외가 하나 있다: **골문은 물리적 벽**이라 계획 낙하점(골 마우스)을 지나는 틱에
 * 공을 그 지점에 세운다. 이건 "목표 근처에서 감속"이 아니라 **도달 즉시 판정**이고,
 * 그러지 않으면 공이 골라인을 뚫고 나가 `boundaryCross` 가 슛을 스로인/골킥으로 오분류한다.
 */
export function advanceBall(ball: Ball, config: EngineConfig, pitch: Pitch): AdvanceResult {
  const f = ball.flight;
  const fromX = ball.posFx.x;
  const fromY = ball.posFx.y;
  const idle: AdvanceResult = { out: null, fromX, fromY, passedPlan: false, stopped: false };
  if (!f) return idle;

  const nx = fromX + f.vxFx;
  const ny = fromY + f.vyFx;

  // 슛: 골문(계획 낙하점)에 닿는 틱에 정확히 그 지점에서 판정한다(공은 네트/키퍼가 멈춘다).
  if (f.kind === "shot" && passedPlanPoint(f, nx, ny)) {
    ball.posFx.x = f.toX;
    ball.posFx.y = f.toY;
    return { out: null, fromX, fromY, passedPlan: true, stopped: false };
  }

  const cross = boundaryCross(fromX, fromY, nx, ny, pitch);
  if (cross) {
    ball.posFx.x = cross.x;
    ball.posFx.y = cross.y;
    f.vxFx = 0;
    f.vyFx = 0;
    f.speed = 0;
    return { out: cross, fromX, fromY, passedPlan: passedPlanPoint(f, cross.x, cross.y), stopped: true };
  }

  ball.posFx.x = nx;
  ball.posFx.y = ny;

  // --- 마찰: 크기만 줄인다(방향 불변 = #181 계약의 구조적 근거). ---
  const k = frictionOf(f, config);
  f.vxFx = Math.round(f.vxFx * k);
  f.vyFx = Math.round(f.vyFx * k);
  f.speed = isqrt(f.vxFx * f.vxFx + f.vyFx * f.vyFx);
  let stopped = false;
  if (f.speed < toFixed(config.ball.stopSpeedM, config.fixedScale)) {
    // 자연 정지. "미리 정한 자리"가 아니라 속도가 다한 자리다.
    f.vxFx = 0;
    f.vyFx = 0;
    f.speed = 0;
    stopped = true;
  }

  return { out: null, fromX, fromY, passedPlan: passedPlanPoint(f, nx, ny), stopped };
}

/**
 * 점 (px,py) 와 **이번 틱 이동 선분** (ax,ay)→(bx,by) 의 최단거리(fixed).
 *
 * 왜 점이 아니라 선분인가(#320): 공이 한 틱에 8~16m 를 난다. 틱 끝 위치만 보면 그 사이를
 * 스쳐 지나간 선수는 **닿을 수 있었는데 없던 일**이 된다 — 속도 기반에서 도착 판정을
 * "누가 공에 닿을 수 있는가"로 다시 정의한 이상, 닿을 수 있었는지는 궤적으로 재야 한다.
 * (구버전은 공이 목표점에 **서 있었기 때문에** 점 판정으로 충분했다.)
 *
 * 정수 산술: 투영 파라미터를 `num/den` 유리수로 두고 곱셈으로만 최근접점을 만든다.
 */
export function nearestOnSweep(
  px: number,
  py: number,
  ax: number,
  ay: number,
  bx: number,
  by: number,
): { dist: number; x: number; y: number } {
  const dx = bx - ax;
  const dy = by - ay;
  const den = dx * dx + dy * dy;
  const at = (cx: number, cy: number): { dist: number; x: number; y: number } => ({
    dist: isqrt((px - cx) * (px - cx) + (py - cy) * (py - cy)),
    x: cx,
    y: cy,
  });
  if (den === 0) return at(ax, ay);
  const num = (px - ax) * dx + (py - ay) * dy;
  if (num <= 0) return at(ax, ay);
  if (num >= den) return at(bx, by);
  return at(ax + Math.round((dx * num) / den), ay + Math.round((dy * num) / den));
}
