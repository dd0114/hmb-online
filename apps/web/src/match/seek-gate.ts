// 과거 전용 시크바의 **판정 규칙** — 순수 로직(React/DOM 의존 0). #406 W3 / 요구 5-3
//
// ⚠️ **여기서 상한 규칙을 새로 만들지 않는다.** "뒤로 자유 · 앞으로 `liveTick + grace` 제한"은
// `clampSeek`(packages/shared/match-clock)이 이미 소유하고 `liveGate.clamp`(live-clock)가 그걸
// 래핑한다. 이 파일이 하는 일은 두 가지뿐이다:
//   ① 유저 조작을 **그 하나뿐인 clamp 에 태우는** 어댑터(호출부가 상한을 다시 계산하지 않게)
//   ② "지금 과거를 보는 중인가"·"이 핀은 아직 안 온 장면인가" 같은 **화면 상태를 그 clamp 에서 파생**
// 상한 계산을 호출부에 복제하면 변이체가 그대로 통과한다 — #233 독립검증 minor-1 이 정확히 그 형태였다.
//
// ⚠️ **서버 시계는 인덱스로, 이벤트는 절대 틱으로 말한다.** `liveGate.liveTick` 은 이름과 달리
// **스냅샷 인덱스**다(`liveTick(clock, now, tickCount)` = 진행률 × 스냅샷 수). 후반 로그는 틱이
// 2700 부터 시작하므로 둘을 섞으면 상한 비교가 늘 참이 된다. 그래서 이 파일은 경계에서 단위를
// 이름으로 갈라 둔다: `*Index` = 스냅샷 인덱스, `*Tick` = 절대 틱.

import type { LiveGate } from "./live-clock";
import { indexOfPlayhead, tickOfIndex } from "./live-pace";

/**
 * 화면이 소비하는 라이브 정책. `liveGate` 에서 파생하며 **clamp 는 그대로 물려받는다**
 * (여기서 감싸 다시 계산하지 않는다 — 규칙이 두 곳에 생기는 순간 조용히 갈라진다).
 */
export interface SeekPolicy {
  /** 이 하프가 지금 라이브인가 = 상한이 걸리는가. */
  isLive: boolean;
  /** 지금 보여줘도 되는 **상한 스냅샷 인덱스**. 라이브가 아니면 null = 상한 없음(전 구간 자유). */
  liveIndex: number | null;
  /** 정책을 통과시킨 인덱스(뒤로 자유·앞으로 상한+grace). */
  clampIndex(index: number): number;
}

export function policyOf(gate: LiveGate): SeekPolicy {
  return {
    isLive: gate.isLive,
    liveIndex: gate.isLive ? gate.liveTick : null,
    clampIndex: (index) => gate.clamp(index),
  };
}

/**
 * "라이브 헤드에 붙어 있다"로 볼 허용 오차(스냅샷 인덱스).
 *
 * 왜 0 이 아닌가: 라이브 상한은 실시간으로 계속 흐른다. 유저가 바 오른쪽 끝(=그 순간의 상한)을
 * 잡은 뒤 판정이 도는 사이에도 상한이 1~2 인덱스 앞서 있어서, 0 으로 재면 **끝까지 끌어도 항상
 * "과거 보는 중"** 이 된다(배지가 안 꺼진다). 서버 창은 하프를 스냅샷 수로 나눠 흐르므로 1 인덱스가
 * 대략 1 실초이고, 판정 주기(250ms)와 폴링(1s)을 덮으려면 2 면 충분하다.
 */
export const LIVE_EDGE_TOLERANCE_IDX = 2;

/** 이 인덱스가 **아직 안 온 미래**인가(= 열면 스포일러). 상한이 없으면 미래도 없다. */
export function isFutureIndex(index: number, policy: SeekPolicy): boolean {
  return policy.liveIndex != null && index > policy.liveIndex;
}

/**
 * 라이브 헤드에 (허용 오차 안에서) 붙어 있는가 = **라이브를 따라가는 중**.
 * `false` 이면 화면은 "과거 보는 중"이고, 복구 루프는 유저를 끌어당기지 않는다(hero 확정 = 수동 [현재로]만).
 * 상한이 없는 화면(종료·지나간 하프)에서는 "뒤처짐"이라는 개념 자체가 없으므로 항상 true.
 */
export function atLiveEdge(
  index: number,
  policy: SeekPolicy,
  tolerance: number = LIVE_EDGE_TOLERANCE_IDX,
): boolean {
  if (policy.liveIndex == null) return true;
  return index >= policy.liveIndex - Math.max(0, tolerance);
}

/** 트랙 범위 안으로 자른 정수 인덱스. */
export function withinTrack(index: number, snapCount: number): number {
  if (!Number.isFinite(index)) return 0;
  const end = Math.max(0, Math.floor(snapCount) - 1);
  return Math.max(0, Math.min(Math.round(index), end));
}

/**
 * 절대 틱 → 스냅샷 인덱스. 스냅샷 목록이 없으면(트림·손상 로그) 코어 폴백과 같은 규칙으로
 * **인덱스 = 틱** 취급한다(`VisualPlayback.onLoaded` 의 `idxOf` 폴백과 같은 태도).
 */
export function indexOfTick(snapTicks: readonly number[], tick: number): number {
  return snapTicks.length > 0 ? indexOfPlayhead(snapTicks, tick) : Math.max(0, Math.round(tick));
}

/** 스냅샷 인덱스 → 절대 틱(같은 폴백). */
export function tickOfSnapIndex(snapTicks: readonly number[], index: number): number {
  return snapTicks.length > 0 ? tickOfIndex(snapTicks, index) : Math.max(0, Math.round(index));
}

/**
 * 정책을 통과한 **절대 틱**. 잘리지 않았으면 요청한 틱을 그대로 돌려준다 —
 * 인덱스로 왕복시키면 틱당 스냅샷이 1개가 아닌 로그에서 초 단위 정밀도가 뭉개진다(#180 계약).
 */
export function gatedTick(requestTick: number, snapTicks: readonly number[], policy: SeekPolicy): number {
  const want = Math.max(0, Math.round(requestTick));
  const idx = indexOfTick(snapTicks, want);
  const capped = policy.clampIndex(idx);
  return capped >= idx ? want : tickOfSnapIndex(snapTicks, capped);
}

/** 시크바 트랙의 기하 — [재생된 과거] / [진행됐지만 안 본 구간] / [아직 안 온 미래]. */
export interface TrackGeometry {
  /** 재생 헤드 위치(%). */
  headPct: number;
  /** 라이브 헤드(=`현재` 선) 위치(%). 상한이 없으면 100. */
  livePct: number;
  /**
   * **닿을 수 있는 경계**(%) = max(head, live).
   *
   * 헤드가 라이브를 살짝 앞설 수 있다(자유 재생의 크루즈 구간 — `PACE_DRIFT_FRAC` 안쪽은 회수하지
   * 않는 것이 #216 계약이다). 그때 미래 구간을 `live` 에서 시작시키면 **헤드가 잠긴 구간 위에**
   * 그려져 화면이 자기모순을 말한다. 미래 = "아직 못 닿은 곳"이므로 경계는 둘 중 먼 쪽이다.
   */
  reachPct: number;
  /** 미래 구간(빗금)을 그리는가. */
  locked: boolean;
  /** 슬라이더가 덮는 최대 인덱스 — **`snapCount - 1` 이 아니라 라이브 헤드**다(바 끝 = 스포일러 금지). */
  maxIndex: number;
}

export function trackGeometry(
  headIndex: number,
  liveIndex: number | null,
  snapCount: number,
): TrackGeometry {
  const end = Math.max(1, Math.floor(snapCount) - 1);
  const pct = (i: number) => Math.max(0, Math.min(100, (i / end) * 100));
  const headPct = pct(Number.isFinite(headIndex) ? headIndex : 0);
  const livePct = liveIndex == null ? 100 : pct(liveIndex);
  return {
    headPct,
    livePct,
    reachPct: Math.max(headPct, livePct),
    locked: liveIndex != null && livePct < 100,
    maxIndex: liveIndex == null ? end : Math.max(0, Math.min(end, Math.floor(liveIndex))),
  };
}

/**
 * 게이트를 통과하는 **유저 시크 창구**. 구현은 뷰어를 쥔 `VisualPlayback` 이 만들고,
 * 컨트롤(`PlaybackControls`)은 이것만 부른다 — 컨트롤이 `viewer.scrubTo/jumpToTick` 을 직접
 * 부르면 그 호출은 상한을 안 거친다(오늘의 결함이 정확히 그것이었다).
 */
export interface GatedSeek {
  /** 스냅샷 인덱스로 이동(시간바·프레임 스텝). 실제로 간 인덱스 반환. */
  toIndex(index: number): number;
  /** 절대 틱으로 **정밀** 이동(초 스텝·mm:ss). 실제로 간 틱 반환. */
  toTick(tick: number): number;
  /** 장면 점프(핀·장면 리스트 — 맥락 되감기 포함). **미래 장면이면 거부**하고 false. */
  toScene(tick: number): boolean;
  /** 이 틱이 아직 안 온 미래인가(핀 잠금 표시용). */
  isFutureTick(tick: number): boolean;
  /** [현재로] — 라이브 헤드로 복귀하고 추종을 재개한다. 상한이 없으면 아무것도 하지 않는다. */
  toNow(): void;
}
