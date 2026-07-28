/**
 * 게임 로그(FM식 코멘터리) 투영 — 타입 표면.
 *
 * P4-D3 SoT: 런타임 규칙은 **`./log-lines.mjs`** 가 원본이다(stats.ts↔stats.mjs 와 같은 패턴).
 * 이 파일은 그 순수 모듈에 타입을 입혀 web(React LogPanel)·QA(티커) 가 대칭 소비하게 한다.
 * **규칙을 바꿀 땐 log-lines.mjs 만 고친다.** dev-viewer 셸은 .mjs 를 인라인해 renderTicker 가 소비.
 *
 * 순수 함수 — DOM·프레임워크·시간·난수 의존 0(루트 CLAUDE §2-5 결정론 원칙과 같은 규율).
 */
// plain ESM(JSDoc) 모듈. allowJs 로 로드, 아래에서 타입을 입혀 재수출(stats.ts↔stats.mjs 와 동일).
import * as impl from "./log-lines.impl.mjs";

/** 뷰어가 소비하는 최소 이벤트 형태(shared MatchEvent 의 구조적 부분집합). */
export interface LogEvent {
  tick: number;
  minute: number;
  type: string;
  team?: "home" | "away" | null;
  playerId?: string | null;
  xg?: number | null;
  detail?: string | null;
}

/** 코멘터리 중요도 — major=골/PK/카드/교체/휘슬, minor=세트피스·태클·차단·빗나간슛. */
export type LogTier = "major" | "normal" | "minor";

export interface LogLine {
  tick: number;
  minute: number;
  type: string;
  tier: LogTier;
  /** "⚽ GOAL", "Shot · saved 🧤" 등 주 라벨. */
  label: string;
  /** 골에서만: 그 시점 스코어 "2-1". */
  score?: string;
  /** 등번호(선수 표기). playerId 가 없으면 undefined. */
  number?: string;
  team?: "home" | "away";
  /** 슛 계열에서만 표시하는 xG(소수 2자리). */
  xg?: string;
}

/**
 * 이 로그 **앞에** 이미 끝난 하프의 스코어 (#233). 하프 로그는 그 하프의 골만 갖기 때문에,
 * 후반 로그의 누적을 경기 점수로 쓰려면 전반 확정 스코어를 여기로 받아야 한다.
 * 생략/null 이면 하프 로컬 누적(= 기존 동작, dev-viewer 경로 무회귀).
 */
export type ScoreBaseline = { home: number; away: number } | null | undefined;

interface LogLinesImpl {
  eventTier(e: LogEvent): LogTier;
  isLogged(e: LogEvent): boolean;
  logLines(events: readonly LogEvent[], uptoTick?: number, baseline?: ScoreBaseline): LogLine[];
  scoreAt(
    events: readonly LogEvent[],
    uptoTick: number,
    baseline?: ScoreBaseline,
  ): { home: number; away: number };
}
// JSDoc 모듈이라 TS 가 tier 를 넓은 string 으로 추론 → 검증된 표면 타입으로 재해석(stats.ts 패턴).
const typed = impl as unknown as LogLinesImpl;

/** 코멘터리 중요도. */
export const eventTier: LogLinesImpl["eventTier"] = typed.eventTier;

/** 티커에 나오는 이벤트인가 — 경기중 무-detail 킥오프(재시작 노이즈)는 숨긴다. */
export const isLogged: LogLinesImpl["isLogged"] = typed.isLogged;

/**
 * `uptoTick`(포함)까지의 로그 라인. `uptoTick` 을 주지 않으면 전체.
 * 골 라인에는 그 시점의 스코어를 함께 계산해 붙인다(진행 중 스코어 = 재생 시점 기준).
 */
export const logLines: LogLinesImpl["logLines"] = typed.logLines;

/** `uptoTick` 까지의 스코어(골 이벤트 누적). 스코어바가 재생 진행에 맞춰 쓰는 값. */
export const scoreAt: LogLinesImpl["scoreAt"] = typed.scoreAt;
