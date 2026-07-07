/**
 * fixedmath — 고정소수(정수 스케일) 유틸.
 *
 * 결정론 핵심: 위치·거리·속도·누적은 부동소수 오차/플랫폼 편차를 피하기 위해
 * 정수(= 실수 × scale)로만 계산한다. 이 모듈 밖에서 float 산술로 좌표를 만들지 않는다.
 *
 * 표현: fixed 값 = round(meters × scale). scale 은 EngineConfig.fixedScale.
 */

/** 실수 → 고정소수 정수. */
export function toFixed(n: number, scale: number): number {
  return Math.round(n * scale);
}

/** 고정소수 정수 → 실수. */
export function fromFixed(f: number, scale: number): number {
  return f / scale;
}

/** 고정소수 덧셈(스케일 동일). */
export function fadd(a: number, b: number): number {
  return a + b;
}

/** 고정소수 뺄셈. */
export function fsub(a: number, b: number): number {
  return a - b;
}

/** 고정소수 곱(a,b 둘 다 fixed) → fixed. a·b/scale. */
export function fmul(a: number, b: number, scale: number): number {
  return Math.round((a * b) / scale);
}

/** 고정소수 나눗셈(a,b 둘 다 fixed) → fixed. */
export function fdiv(a: number, b: number, scale: number): number {
  if (b === 0) return 0;
  return Math.round((a * scale) / b);
}

/**
 * 정수 제곱근(floor). Math.sqrt 는 IEEE754 상 정확히 반올림되어 플랫폼 결정적이므로
 * 이를 씨앗으로 쓰되, 경계 오차를 정수 보정해 완전 결정적 정수 결과를 보장한다.
 */
export function isqrt(n: number): number {
  if (n <= 0) return 0;
  let r = Math.floor(Math.sqrt(n));
  // 부동소수 경계 보정.
  while (r * r > n) r--;
  while ((r + 1) * (r + 1) <= n) r++;
  return r;
}

/** 두 고정소수 점 사이 거리(fixed). */
export function fdist(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return isqrt(dx * dx + dy * dy);
}

/** 거리 제곱(fixed²) — 비교용(제곱근 회피). */
export function fdistSq(ax: number, ay: number, bx: number, by: number): number {
  const dx = ax - bx;
  const dy = ay - by;
  return dx * dx + dy * dy;
}

/** 고정소수 클램프. */
export function fclamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/**
 * (fromX,fromY) 에서 (toX,toY) 로 step(fixed) 만큼 이동한 새 위치(fixed).
 * 남은 거리 <= step 이면 목표에 스냅. 모두 정수 산술.
 */
export function stepToward(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number,
  step: number,
): { x: number; y: number } {
  const dx = toX - fromX;
  const dy = toY - fromY;
  const dist = isqrt(dx * dx + dy * dy);
  if (dist <= step || dist === 0) return { x: toX, y: toY };
  // 정수 방향 스케일: 이동량 = d * step / dist
  const nx = fromX + Math.round((dx * step) / dist);
  const ny = fromY + Math.round((dy * step) / dist);
  return { x: nx, y: ny };
}
