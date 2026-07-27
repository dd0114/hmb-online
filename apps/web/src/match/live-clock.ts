import {
  clampSeek,
  clockOffsetMs,
  compressionOf,
  liveClockForHalf,
  liveTick,
  type MatchClock,
} from "@hmb/shared";

/**
 * 서버 권위 시계의 **화면 쪽 소비 규칙** (P4-E2 #170 W3, LLD-e2-flow-clock §9).
 *
 * 시각→틱 매핑은 `@hmb/shared`(match-clock)가 SoT 다 — 여기서 다시 계산하지 않는다. 이 파일은
 * "그래서 화면이 어떻게 행동하는가"만 정한다: 얼마나 자주 폴링할지, 어떤 로그를 요청해도 되는지,
 * 뷰어 재생을 어디까지 허용할지.
 *
 * 시간 상수는 서버가 내려준 clock 값만 쓴다(웹에 압축비·감독시간 상수를 복제하지 않는다 — AC-W3-2).
 */

/** 엔진 1틱 = 1 게임초(match-log 계약). 뷰어 플레이헤드 단위. */
export const MS_PER_TICK = 1000;

const LIVE_STATES = new Set(["FIRST_HALF", "HALFTIME", "SECOND_HALF"]);
const GEN_STATES = new Set(["GEN1", "GEN2"]);

/** 전반 로그가 열려 있는 상태 — 후반 생성/재생 중에도 전반 다시보기는 계속 가능하다. */
const H1_LOG_STATES = new Set([
  "FIRST_HALF",
  "HALFTIME",
  "H1_BREAK", // 레거시(P4 이전 배포본의 진행 중 매치)
  "GEN2",
  "SECOND_HALF",
  "FINISHED",
]);

/**
 * 폴링 주기(ms) 또는 false. 라이브 단계는 단계 전환(전반 종료·감독시간 만료)을 초 단위로 따라가야
 * 하므로 1초. **생성 단계도 1초**(#193) — 예전 3초는 생성이 팀당 70초 걸리던 시절의 값이고, 새
 * 플로우 실측은 킥오프→관전 6~14초·하프타임→후반 0.3초다. 그 대기에 3초 격자를 씌우면 폴링 대기만
 * 최대 3초(≈25%) 더 붙어 "다 됐는데 화면이 안 넘어가는" 구간이 생긴다. 그 외 상태는 폴링하지 않는다.
 */
export function pollIntervalFor(state: string | undefined): number | false {
  if (state && LIVE_STATES.has(state)) return 1000;
  if (state && GEN_STATES.has(state)) return 1000;
  return false;
}

/** 이 상태에서 그 하프 로그를 요청해도 되는가(서버 허용표 미러 — 409 를 유발하지 않기 위해). */
export function logAvailableFor(state: string | undefined, half: 1 | 2): boolean {
  if (!state) return false;
  return half === 1 ? H1_LOG_STATES.has(state) : state === "SECOND_HALF" || state === "FINISHED";
}

/** 잔여 ms → `분:초`. null 이면 카운트다운 비활성(시계 없는 매치). */
export function countdownLabel(remainingMs: number | null): string | null {
  if (remainingMs == null) return null;
  const total = Math.max(0, Math.ceil(remainingMs / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

export interface LiveGate {
  /** 이 하프가 지금 라이브인가(= 재생 상한이 걸리는가). */
  isLive: boolean;
  /** 지금 보여줘도 되는 상한 틱. */
  liveTick: number;
  /** seek 목표를 정책에 맞게 자른 정수 틱(뒤로 자유·앞으로 상한+grace). */
  clamp(target: number): number;
  /** 라이브 재생 속도(압축비). 없으면 null = 등속. */
  speed: number | null;
}

/**
 * 응답이 도착한 그 순간에 재는 서버-클라 시각차(ms). **폴링 때 한 번 재서 보관**하고, 이후 프레임마다
 * 로컬 시각에 더한다 — 매 프레임 다시 재면 `serverNow` 에 고정돼 시계가 멈춘 것처럼 보인다.
 */
export function captureOffsetMs(clock: MatchClock | null | undefined, clientNowAtFetchMs: number): number {
  return clock ? clockOffsetMs(clock, clientNowAtFetchMs) : 0;
}

/**
 * 화면이 쓸 재생 게이트. `offsetMs` 는 {@link captureOffsetMs} 로 폴링 시점에 잡아둔 값이다 —
 * 클라 시계가 틀어져 있어도 다른 클라와 같은 지점이 나온다(AC-W3-1 "두 클라가 같은 시각 열면 같은 지점").
 */
export function liveGate(
  clock: MatchClock | null | undefined,
  half: 1 | 2,
  tickCount: number,
  clientNowMs: number,
  offsetMs: number = 0,
): LiveGate {
  const active = liveClockForHalf(clock ?? null, half);
  const nowMs = clientNowMs + offsetMs;
  const live = liveTick(active, nowMs, tickCount);
  return {
    isLive: Boolean(active),
    liveTick: live,
    clamp: (target: number) => Math.floor(clampSeek(target, live, active, MS_PER_TICK)),
    speed: compressionOf(active, tickCount, MS_PER_TICK),
  };
}
