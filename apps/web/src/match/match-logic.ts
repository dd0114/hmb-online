/**
 * Pure match-flow logic (unit-tested): state routing, poll gating, event display
 * mapping, running score, team stats derivation, substitution pre-checks.
 *
 * Event shapes mirror packages/shared/src/match-log.ts (zod SoT — openapi MatchLog is a
 * loose stub by design). Structural types are declared locally so the web app keeps its
 * "Java API only" dependency boundary (PRD §1: 웹은 Java API만 안다).
 */
import type { components } from "../api/schema";
import { pollIntervalFor } from "./live-clock";

export type MatchState = components["schemas"]["MatchState"];

// ── state router ───────────────────────────────────────────────────────

export type MatchPanel =
  | "briefing"
  | "genwait"
  | "live"
  | "halftime"
  | "result"
  | "failed"
  | "abandoned"
  | "unknown";

/**
 * 상태 → 화면. P4-E2(#170)로 라이브 단계가 들어왔다: FIRST_HALF/SECOND_HALF 는 "지금 경기 중"이라
 * 감독시간/결과와 같은 관전 셸(StageShell)에서 돈다. GEN* 는 여전히 생성 대기 화면이다.
 */
export function panelForState(state: MatchState | string | undefined): MatchPanel {
  switch (state) {
    case "BRIEFING":
      return "briefing";
    case "GEN1":
    case "GEN2":
      return "genwait";
    case "FIRST_HALF":
    case "SECOND_HALF":
      return "live";
    case "HALFTIME":
    case "H1_BREAK": // 레거시(P4 이전 배포본의 진행 중 매치)
      return "halftime";
    case "FINISHED":
      return "result";
    case "FAILED":
      return "failed";
    case "ABANDONED":
      // #217: 두 번째 터미널 상태. "알 수 없는 상태"로 떨어뜨리면 포기한 유저가 에러 화면을 본다.
      return "abandoned";
    default:
      return "unknown";
  }
}

/**
 * GET /api/matches/:id 폴링 여부. 생성 중(GEN*)뿐 아니라 **라이브 단계**도 폴링한다 — 전반 종료·
 * 감독시간 만료 같은 단계 전환을 서버가 소유하기 때문이다(주기는 live-clock.pollIntervalFor).
 */
export function shouldPoll(state: MatchState | string | undefined): boolean {
  return pollIntervalFor(state) !== false;
}

// ── GEN 대기 문구 ──────────────────────────────────────────────────────

export interface GenWaitCopy {
  title: string;
  note: string;
}

/**
 * 생성 대기(GEN1/GEN2) 화면 문구. **실측 정합**(#193): 킥오프→관전은 6~14초, 전술을 크게 바꿔
 * 대변경 라우팅을 타면 1~2분(단, 제출 시점부터 백그라운드로 돌아간다), 하프타임→후반은 0.3초다.
 * 그래서 GEN1 만 시간 감각을 주고, GEN2 는 숫자를 말하지 않는다 — 문구를 읽을 새도 없이 넘어간다.
 *
 * 서버가 예상 소요를 내려주지 않으므로 수치는 **문구 안 서술**로만 둔다(튜닝 설정값이 아니다).
 */
export function genWaitCopy(state: MatchState | string | undefined): GenWaitCopy {
  if (state === "GEN2") {
    return {
      title: "AI 감독이 후반 작전 반영 중…",
      note: "하프타임 — 선수들이 후반 준비 중입니다",
    };
  }
  return {
    title: "AI 감독이 전반 작전 반영 중…",
    note: "감독의 지시가 선수들에게 전달되고 있습니다 (보통 10초 안팎, 전술을 크게 바꾼 경우 1~2분)",
  };
}

// ── MatchLog event display (shared MatchEventType mirror) ──────────────

export interface MatchEventLike {
  tick: number;
  minute: number;
  type: string;
  team?: "home" | "away";
  playerId?: string;
  xg?: number;
  detail?: string;
}

export interface EventDisplay {
  icon: string;
  label: string;
  /** timeline noise filter — only key events are rendered in the text viewer */
  key: boolean;
}

/**
 * MatchEventType → 아이콘/라벨. 코너는 엔진이 `kickoff`+detail:"corner" 로 인코딩
 * (contest.ts restartCorner). 미지의 타입은 원문 노출(fallback) — 스키마 확장에 안전.
 */
export function eventDisplay(event: MatchEventLike): EventDisplay {
  switch (event.type) {
    case "kickoff":
      if (event.detail === "corner") return { icon: "◤", label: "코너킥", key: true };
      if (event.detail === "goal_kick") return { icon: "◎", label: "골킥", key: false };
      if (event.detail === "throw_in") return { icon: "↷", label: "스로인", key: false };
      return { icon: "●", label: "킥오프", key: true };
    case "goal":
      return { icon: "⚽", label: "골!", key: true };
    case "shot":
      return {
        icon: "◎",
        label: event.detail === "penalty" ? "페널티킥 슛" : "슛",
        key: true,
      };
    case "save":
      return { icon: "🧤", label: "선방", key: true };
    case "foul":
      return { icon: "✕", label: "파울", key: true };
    case "card":
      if (event.detail === "red") return { icon: "🟥", label: "레드카드", key: true };
      return { icon: "🟨", label: "옐로카드", key: true };
    case "offside":
      return { icon: "🚩", label: "오프사이드", key: true };
    case "free_kick":
      return { icon: "◍", label: "프리킥", key: true };
    case "penalty":
      return { icon: "⊙", label: "페널티킥", key: true };
    case "substitution":
      return { icon: "⇄", label: "교체", key: true };
    case "half_whistle":
      return { icon: "🔔", label: "전반 종료", key: true };
    case "full_whistle":
      return { icon: "🏁", label: "경기 종료", key: true };
    case "pass":
      return { icon: "→", label: "패스", key: false };
    case "interception":
      return { icon: "⊘", label: "인터셉트", key: false };
    case "tackle":
      return { icon: "⊗", label: "태클", key: false };
    default:
      // unknown-type fallback: show the raw type, keep it visible
      return { icon: "•", label: event.type, key: true };
  }
}

/** Key events only — text timeline hides per-tick noise (pass/tackle/interception). */
export function keyEvents(events: MatchEventLike[]): MatchEventLike[] {
  return events.filter((e) => eventDisplay(e).key);
}

/** tick(1초 틱) → "분:초" 표기. half 2는 +45:00 오프셋 표시용. */
export function formatClock(tick: number, half: 1 | 2 = 1): string {
  const base = half === 2 ? 45 * 60 : 0;
  const total = base + Math.max(0, Math.floor(tick));
  const mm = Math.floor(total / 60);
  const ss = total % 60;
  return `${mm}:${String(ss).padStart(2, "0")}`;
}

// ── scores & stats (events only — no tick math) ────────────────────────

export interface ScorePair {
  home: number;
  away: number;
}

/**
 * Running score over the first `revealedCount` events (text-playback scoreboard).
 *
 * `baseline` = 이 로그 앞에 이미 끝난 하프의 확정 스코어(#233). 하프 로그는 그 하프의 골만 갖기
 * 때문에, 후반 폴백 스코어보드가 이걸 안 받으면 `0 : 0` 부터 다시 센다. 생략하면 하프 로컬(무회귀).
 */
export function runningScore(
  events: MatchEventLike[],
  revealedCount: number,
  baseline?: ScorePair | null,
): ScorePair {
  const score = { home: baseline?.home ?? 0, away: baseline?.away ?? 0 };
  for (const e of events.slice(0, revealedCount)) {
    if (e.type === "goal" && (e.team === "home" || e.team === "away")) {
      score[e.team] += 1;
    }
  }
  return score;
}

export interface TeamStats {
  shots: number;
  goals: number;
  corners: number;
  fouls: number;
  cards: number;
  offsides: number;
}

export interface TeamStatsPair {
  home: TeamStats;
  away: TeamStats;
}

const STAT_ROWS: Array<[keyof TeamStats, string]> = [
  ["goals", "골"],
  ["shots", "슛"],
  ["corners", "코너킥"],
  ["fouls", "파울"],
  ["cards", "카드"],
  ["offsides", "오프사이드"],
];

export const TEAM_STAT_LABELS = STAT_ROWS;

function emptyStats(): TeamStats {
  return { shots: 0, goals: 0, corners: 0, fouls: 0, cards: 0, offsides: 0 };
}

/** Derive simple team stats from BOTH halves' events (concatenated by caller). */
export function deriveTeamStats(events: MatchEventLike[]): TeamStatsPair {
  const stats: TeamStatsPair = { home: emptyStats(), away: emptyStats() };
  for (const e of events) {
    if (e.team !== "home" && e.team !== "away") continue;
    const t = stats[e.team];
    switch (e.type) {
      case "shot":
        // 결과 마커(saved/off_target)는 **같은 슛의 결과** 이벤트다 — 시도로 또 세면 안 된다.
        // 정의는 엔진 쪽 SoT(`stats.mjs liveEventStats` · `match-stats.ts`)와 동일해야 한다:
        // 결과 화면 팀스탯과 관전 통계 패널이 같은 화면에 나란히 놓이므로 정의가 갈라지면 바로 보인다.
        if (e.detail !== "saved" && e.detail !== "off_target") t.shots += 1;
        break;
      case "goal":
        t.goals += 1;
        break;
      case "kickoff":
        if (e.detail === "corner") t.corners += 1;
        break;
      case "foul":
        t.fouls += 1;
        break;
      case "card":
        t.cards += 1;
        break;
      case "offside":
        t.offsides += 1;
        break;
    }
  }
  return stats;
}

// ── text-playback pacing ───────────────────────────────────────────────

/** Compress a half's key events into ~targetMs of sequential reveal (clamped). */
export function revealInterval(totalEvents: number, targetMs: number = 30_000): number {
  if (totalEvents <= 0) return targetMs;
  return Math.min(2000, Math.max(120, Math.round(targetMs / totalEvents)));
}

// ── halftime substitutions (client pre-check — server AC-M4 is SoT) ────

export const MAX_SUBS = 3;

export interface SubPair {
  out: string;
  in: string;
}

export interface SubIssue {
  rule: string;
  message: string;
}

export function validateSubs(
  subs: SubPair[],
  starterIds: string[],
  benchIds: string[],
  positionOf: (playerId: string) => string | undefined,
): SubIssue[] {
  const issues: SubIssue[] = [];
  if (subs.length > MAX_SUBS) {
    issues.push({ rule: "SUBS_MAX", message: `교체는 최대 ${MAX_SUBS}명입니다` });
  }
  const outs = new Set<string>();
  const ins = new Set<string>();
  for (const s of subs) {
    if (!starterIds.includes(s.out)) {
      issues.push({ rule: "OUT_NOT_STARTER", message: "선발이 아닌 선수를 뺄 수 없습니다" });
    }
    if (!benchIds.includes(s.in)) {
      issues.push({ rule: "IN_NOT_BENCH", message: "벤치에 없는 선수를 넣을 수 없습니다" });
    }
    if (outs.has(s.out)) {
      issues.push({ rule: "DUPLICATE_OUT", message: "같은 선수를 두 번 뺄 수 없습니다" });
    }
    if (ins.has(s.in)) {
      issues.push({ rule: "DUPLICATE_IN", message: "같은 선수를 두 번 넣을 수 없습니다" });
    }
    outs.add(s.out);
    ins.add(s.in);
  }
  // GK guard: 교체 후 필드에 GK 0명이 되면 경고 (서버 SUBSTITUTION_INVALID 미러)
  const afterIds = starterIds.filter((id) => !outs.has(id)).concat([...ins]);
  if (starterIds.length > 0 && !afterIds.some((id) => positionOf(id) === "GK")) {
    issues.push({ rule: "GK_REQUIRED", message: "교체 후에도 GK가 최소 1명 필요합니다" });
  }
  return issues;
}
