import { z } from "zod";

/**
 * MatchClock — **서버 권위 시계** 계약 (P4-D1, 에픽 #170 / LLD-e2-flow-clock §4·§6).
 *
 * 역할 분담이 이 계약의 전부다:
 *  · **서버**는 "지금 어느 단계이고 그 단계가 언제 시작해 언제 끝나는가"(=창)만 소유한다 → `MatchDetail.clock`.
 *  · **클라**는 그 창 안에서 "지금 몇 틱까지 보여줘도 되는가"를 계산한다 → 이 파일의 함수들.
 * 서버가 로그 틱 수를 몰라도 되고(엔진 config 가 바뀌어도 서버 무변경), 같은 로그 + 같은 창이면
 * 어느 클라가 언제 열어도 **같은 틱**이 나온다(AC-W3-1).
 *
 * ⚠️ 이건 **재생 게이트**다. match-log 도, 시뮬 입력도 건드리지 않는다(엔진 결정론 불변 — 루트 §2-5).
 * 모든 함수는 순수하며 현재 시각을 인자로 받는다(내부에서 Date.now 를 읽지 않는다 — 테스트 가능·스큐 보정 가능).
 */

/** 시계가 도는 단계. BRIEFING·GEN1·GEN2·FINISHED 등 라이브가 아닌 상태에서는 `clock` 자체가 null 이다. */
export const MatchClockPhase = z.enum(["FIRST_HALF", "HALFTIME", "SECOND_HALF"]);
export type MatchClockPhase = z.infer<typeof MatchClockPhase>;

export const MatchClock = z.object({
  /** 현재 단계. SoT 는 서버의 match state 이고 이 값은 그 파생이다. */
  phase: MatchClockPhase,
  // 아래 세 시각은 openapi 에서 **선택 필드**(required 목록 밖)다 → 키가 아예 없는 응답도 합법이다.
  // 그래서 nullable 이 아니라 nullish 로 받는다(둘이 어긋나면 스펙상 합법인 응답을 SoT 파서가 거부한다).
  /** 전반이 라이브로 열린 시각(=킥오프, AC-W3-3). 레거시 매치는 null. */
  kickoffAt: z.string().nullish(),
  /** 현재 단계 시작 시각. null = 시계 미적용(레거시 매치·clock.enabled=false). */
  phaseStartAt: z.string().nullish(),
  /** 현재 단계 종료 예정 시각. HALFTIME 이면 감독시간 deadline. */
  phaseEndsAt: z.string().nullish(),
  /** 응답 생성 시각 — 클라 시계 스큐 보정 기준. */
  serverNow: z.string(),
  /** 하프당 실시간 재생 길이(ms, config). 압축비는 여기서 파생한다(compressionOf). */
  halfRealMs: z.number(),
  /** 감독시간 길이(ms, config). */
  halftimeMs: z.number(),
  /** 라이브 앞서가기 금지 여부(config). */
  seekForwardBlocked: z.boolean(),
  /** 지연·스큐 허용 오차(ms, config). */
  seekGraceMs: z.number(),
});
export type MatchClock = z.infer<typeof MatchClock>;

export type MatchHalf = 1 | 2;

/** ISO → epoch ms. 없거나 깨졌으면 null(화면이 죽지 않게 — 시계 없는 것으로 취급). */
function msOf(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isNaN(ms) ? null : ms;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 이 하프에 실제로 걸리는 시계(없으면 null). 지나간 하프는 게이트하지 않는다 —
 * 후반 라이브 중에 전반을 되돌려보는 건 자유고, 감독시간엔 전반 전체가 자유다.
 */
export function liveClockForHalf(clock: MatchClock | null, half: MatchHalf): MatchClock | null {
  if (!clock) return null;
  if (clock.phase === "FIRST_HALF" && half === 1) return clock;
  if (clock.phase === "SECOND_HALF" && half === 2) return clock;
  return null;
}

/**
 * 지금 보여줘도 되는 상한 틱. 라이브 단계가 아니거나 창 정보가 없으면 `tickCount`(상한 없음).
 *
 * 화면에 띄운 하프가 라이브 하프인지 판정은 호출자가 `liveClockForHalf` 로 먼저 거른다
 * (여기서는 감독시간=지나간 하프만 방어적으로 열어둔다). `nowMs` 는 **스큐 보정된** 시각을 넣는다.
 */
export function liveTick(clock: MatchClock | null, nowMs: number, tickCount: number): number {
  const total = Math.max(0, Math.floor(tickCount));
  if (!clock || clock.phase === "HALFTIME") return total;

  const start = msOf(clock.phaseStartAt);
  const end = msOf(clock.phaseEndsAt);
  if (start == null || end == null || end <= start) return total; // 창이 없음 = 게이트 없음

  const progress = clamp((nowMs - start) / (end - start), 0, 1);
  return Math.min(total, Math.floor(progress * total));
}

/**
 * seek 목표를 정책에 맞게 클램프한다(AC-W3-1): **뒤로는 자유, 앞으로는 라이브 상한 + grace 까지**.
 * `forwardBlocked=false`(config)면 상한 없이 통과한다. 음수는 항상 0으로.
 */
export function clampSeek(
  target: number,
  live: number,
  clock: MatchClock | null,
  msPerTick: number,
): number {
  const floored = Math.max(0, target);
  if (!clock || !clock.seekForwardBlocked) return floored;
  const graceTicks = msPerTick > 0 ? Math.ceil(Math.max(0, clock.seekGraceMs) / msPerTick) : 0;
  return Math.min(floored, Math.max(0, live) + graceTicks);
}

/**
 * 서버 − 클라 시각 차이(ms). 폴링마다 갱신해 로컬 시각에 더하면 스큐가 있어도 같은 라이브 틱이 나온다.
 * `serverNow` 가 깨졌으면 0(보정 없음).
 */
export function clockOffsetMs(clock: MatchClock, clientNowMs: number): number {
  const server = msOf(clock.serverNow);
  return server == null ? 0 : server - clientNowMs;
}

/** 현재 단계 잔여 시간(ms) — 감독시간 카운트다운용. 창이 없으면 null(카운트다운 비활성). */
export function phaseRemainingMs(clock: MatchClock | null, nowMs: number): number | null {
  const end = msOf(clock?.phaseEndsAt);
  if (end == null) return null;
  return Math.max(0, end - nowMs);
}

/**
 * 압축비(경기시간 / 실시간). **config 노브가 아니라 파생값**이다 — 노브는 `halfRealMs` 이고,
 * 엔진이 하프 길이를 바꿔도(쇼케이스 config 등) 재생이 창의 시작·끝에 정확히 맞도록 여기서 계산한다.
 * 뷰어 재생 속도(setSpeed)의 기준값. 계산 불가면 null(등속).
 */
export function compressionOf(
  clock: MatchClock | null,
  tickCount: number,
  msPerTick: number,
): number | null {
  if (!clock || clock.halfRealMs <= 0 || tickCount <= 0 || msPerTick <= 0) return null;
  return (tickCount * msPerTick) / clock.halfRealMs;
}
