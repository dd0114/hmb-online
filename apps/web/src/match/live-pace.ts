/**
 * 라이브 재생 **페이스 정합** (#216 AC2) — 순수 로직.
 *
 * 서버는 "이 하프를 언제부터 언제까지 보여준다"(창)만 소유하고, 재생 속도는 뷰어 코어의 연출
 * 페이싱(크루즈 4x / 키장면 1x / 데드볼 홀드)이 정한다. 둘은 단위가 달라 절대 저절로 맞지 않는다.
 *
 * 이전 구현은 그 차이를 **되감기**로 흡수했다 — 250ms 마다 플레이헤드가 상한을 넘었는지 보고
 * `jumpToTick(liveTick)` 으로 끌어내렸다. 연출 페이싱은 속도가 균일하지 않아 크루즈 구간마다
 * 창의 평균속도를 앞지르므로, 이 되감기는 **초당 4회 발화하는 상시 동작**이 됐다(고무줄).
 *
 * ⚠️ **#365 이후 `paceRate` 는 제품 경로에서 쓰지 않는다**(hero 확정: 고정 배속만).
 * 서버 창이 이제 **그 하프의 실제 재생 길이**라(러너가 viewer-core 페이싱 모델로 재서 준다)
 * 창과 재생이 애초에 같은 길이다 = 흡수할 오차가 없다. 함수를 지우지 않는 이유는 **폴백 경로**다 —
 * 러너가 `playbackMs` 를 안 주면(구 러너·계산 실패) 서버가 고정 `half-real-ms` 로 되돌아가고,
 * 그때는 창이 다시 고정값이라 이 보정이 필요해진다. 되살릴 조건은 그 하나다.
 * 지금 살아 있는 것은 `driftAllowanceTicks`(회수 임계)와 `clampSeek`(유저 seek 상한)뿐이다.
 *
 * 아래 설명은 그 폴백 경로의 것이다 — 두 가지로 바꾼다.
 *  1. 서버 `half-real-ms` 를 **켬 모드 실측 재생 길이**에 맞춘다(config, 서버 쪽) → 오차가 애초에 작다.
 *  2. 남은 오차는 **배율**로 흡수한다(`paceRate`) — 뒤처지면 살짝 빠르게, 앞서면 살짝 느리게.
 *     크루즈·키장면에 같은 배율이 걸리므로 슬로우모션 대비(연출)는 그대로다.
 * 앞서보기 클램프(`clampSeek`)는 **유저 seek 에만** 남는다 — 자유 재생을 끌어내리지 않는다.
 */

/** 배율 하한·상한 — 되감기나 백그라운드 탭 복귀가 스프린트/슬로모션이 되지 않게 가둔다. */
export const PACE_MIN = 0.6;
export const PACE_MAX = 1.6;
/** 창이 사실상 끝났을 때(단계 전이 직전) 0 나눗셈 대신 쓰는 최소 잔여 비율. */
const MIN_REMAINING = 0.02;

/**
 * 자유 재생이 라이브 상한을 잠깐 앞질러도 눈감아 주는 폭(하프 스냅샷 수 대비).
 * 연출 페이싱은 속도가 균일하지 않아 크루즈 구간에서 창의 평균속도를 앞지른다 — `paceRate` 가
 * 곧 되돌리지만 그 사이의 앞섬까지 회수하면 다시 고무줄이 된다. 자연 페이스가 창보다 빠를 때
 * `paceRate` 평형점의 앞섬은 하프 초반에 최대 `1 − 1/r`(실측 r ≤ 1.10 → 9%)이라, 그보다 넉넉한
 * 12% 로 잡는다. 이 폭을 **넘는 건 자유 재생이 아니라 의도적 점프**(스크럽·핀)라서 상한으로 회수한다.
 */
export const PACE_DRIFT_FRAC = 0.12;

export function driftAllowanceTicks(tickCount: number): number {
  if (!Number.isFinite(tickCount) || tickCount <= 0) return 0;
  return Math.ceil(tickCount * PACE_DRIFT_FRAC);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * 재생 배율(코어 `setSpeed`) = **남은 재생분 ÷ 남은 창**. `playedFrac`(재생 진행률)이
 * `liveFrac`(창 진행률)보다 뒤처지면 1 보다 크고, 앞서면 1 보다 작다.
 *
 * 왜 단순 오차비례(1 + k·오차)가 아니라 잔여 비율인가: 오차비례는 평형점이 창 끝까지 **일정 오차**로
 * 남는다(자연 페이스가 창보다 10% 빠르면 끝까지 6% 앞선 채 끝난다). 잔여 비율은 `liveFrac→1` 에서
 * 분모가 함께 줄어 **창의 끝과 재생의 끝이 같은 지점으로 수렴**한다 — AC2 가 요구하는 "전반 종료
 * 시점에 재생도 끝나 있게"가 이 형태에서 저절로 나온다.
 *
 * 값이 이상하면 1(=코어 자연 페이스)로 떨어진다.
 */
export function paceRate(playedFrac: number, liveFrac: number): number {
  if (!Number.isFinite(playedFrac) || !Number.isFinite(liveFrac)) return 1;
  const played = clamp(playedFrac, 0, 1);
  const live = clamp(liveFrac, 0, 1);
  const remainingWindow = Math.max(1 - live, MIN_REMAINING);
  return clamp((1 - played) / remainingWindow, PACE_MIN, PACE_MAX);
}

/**
 * 스냅샷 인덱스 → 절대 틱. 서버 시계(`liveTick`)는 **진행률 × 스냅샷 수** 즉 인덱스를 돌려주고
 * 뷰어(`jumpToTick`·`cur().tick`)는 **절대 틱**으로 말한다. 후반 로그는 틱이 2700 부터 시작하므로
 * 둘을 섞으면 후반이 통째로 어긋난다.
 */
export function tickOfIndex(snapTicks: readonly number[], index: number): number {
  if (snapTicks.length === 0) return 0;
  const i = clamp(Math.floor(index), 0, snapTicks.length - 1);
  return snapTicks[i] ?? 0;
}

/** 절대 틱 → 스냅샷 인덱스(뷰어 `idxOfTick` 과 같은 규칙: 그 틱 이상의 첫 스냅샷). */
export function indexOfPlayhead(snapTicks: readonly number[], tick: number): number {
  if (snapTicks.length === 0) return 0;
  const i = snapTicks.findIndex((t) => t >= tick);
  return i < 0 ? snapTicks.length - 1 : i;
}
