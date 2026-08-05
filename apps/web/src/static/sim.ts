/**
 * 스태틱 모드 엔진 어댑터 (#444) — 브라우저에서 하프를 시뮬한다.
 *
 * <b>재발명하지 않은 것</b>: 시뮬 자체(`@hmb/engine`)와 재생 길이 모델
 * (`@hmb/viewer-core/playback:autoPaceDurationMs` — #365 SoT)은 그대로 소비한다.
 * 여기 있는 것은 러너(`packages/server/src/runner/simulate.ts`)가 하는 일 중
 * **스태틱 모드에 필요한 부분집합**뿐이다:
 *   · half=1 → `runFirstHalf` → carry 를 그대로 들고 있는다
 *   · half=2 → `resumeSecondHalf` 후 **전반분을 잘라내고** 후반만 돌려준다
 *
 * 러너의 `resumeState` 직렬화(수백 줄)를 가져오지 않는 이유: 브라우저에는 프로세스 경계가 없어
 * carry 를 **메모리에 그대로** 들고 있으면 된다. 새로고침 복구는 직렬화가 아니라 **재시뮬**로
 * 한다(엔진이 결정론이라 같은 입력 → 같은 로그).
 *
 * ⚠️ `config-overlay`(계수 오버레이)는 안 쓴다 — `node:crypto` 의존이고 스태틱 모드에는
 * 오버레이 자체가 없다. 항상 `defaultEngineConfig` 다.
 */
import {
  runFirstHalf,
  resumeSecondHalf,
  defaultEngineConfig,
  type CarryState,
} from "@hmb/engine-runtime";
import type { MatchLog, SelectData, TacticalInput } from "@hmb/shared";
// 재생 길이 모델의 SoT — 여기서 다시 구현하지 않고 그대로 읽는다(러너 simulate.ts 와 같은 이유, #365).
import { autoPaceDurationMs } from "@hmb/viewer-core/playback";

export interface HalfResult {
  matchLog: MatchLog;
  /** 이 하프를 연출 페이싱으로 끝까지 보는 데 걸리는 실시간(ms). */
  playbackMs: number;
  /** 하프 종료 시점 누적 스코어(전반) 또는 이 하프의 득점(후반). */
  score: { home: number; away: number };
}

export interface SimSession {
  seed: string;
  carry: CarryState;
  half1: HalfResult;
  half2?: HalfResult;
}

function paceOf(log: MatchLog): number {
  const ms = autoPaceDurationMs(log.tickSnapshots, log.events);
  return Number.isFinite(ms) && ms > 0 ? ms : 60_000;
}

/** carry 내부 누적 배열 → 전반 MatchLog(러너 `carryToMatchLog` 와 같은 조립). */
function carryToMatchLog(carry: CarryState): MatchLog {
  return {
    configVersion: carry.configVersion,
    seed: carry.seed,
    tickSnapshots: carry.snapshots as MatchLog["tickSnapshots"],
    events: carry.events as MatchLog["events"],
    finalScore: { ...carry.state.score },
  };
}

export function simulateFirstHalf(
  seed: string,
  home: TacticalInput,
  away: TacticalInput,
  selectData: SelectData,
): SimSession {
  const carry = runFirstHalf(seed, home, away, selectData, defaultEngineConfig);
  const matchLog = carryToMatchLog(carry);
  return {
    seed,
    carry,
    half1: {
      matchLog,
      playbackMs: paceOf(matchLog),
      score: { home: matchLog.finalScore.home ?? 0, away: matchLog.finalScore.away ?? 0 },
    },
  };
}

export function simulateSecondHalf(
  session: SimSession,
  home: TacticalInput,
  away: TacticalInput,
): HalfResult {
  const before = session.half1.matchLog;
  const tickCut = before.tickSnapshots.length;
  const eventCut = before.events.length;
  const h1Score = { home: before.finalScore.home ?? 0, away: before.finalScore.away ?? 0 };
  const full = resumeSecondHalf(session.carry, home, away);
  const matchLog: MatchLog = {
    configVersion: full.configVersion,
    seed: full.seed,
    tickSnapshots: full.tickSnapshots.slice(tickCut),
    events: full.events.slice(eventCut),
    finalScore: {
      home: (full.finalScore.home ?? 0) - h1Score.home,
      away: (full.finalScore.away ?? 0) - h1Score.away,
    },
  };
  const result: HalfResult = {
    matchLog,
    playbackMs: paceOf(matchLog),
    score: { home: full.finalScore.home ?? 0, away: full.finalScore.away ?? 0 },
  };
  session.half2 = result;
  return result;
}
