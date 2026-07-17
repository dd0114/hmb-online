/**
 * Pure match-flow logic (unit-tested): state routing, poll gating, event display
 * mapping, running score, team stats derivation, substitution pre-checks.
 *
 * Event shapes mirror packages/shared/src/match-log.ts (zod SoT — openapi MatchLog is a
 * loose stub by design). Structural types are declared locally so the web app keeps its
 * "Java API only" dependency boundary (PRD §1: 웹은 Java API만 안다).
 */
import type { components } from "../api/schema";

export type MatchState = components["schemas"]["MatchState"];

// ── state router ───────────────────────────────────────────────────────

export type MatchPanel = "briefing" | "genwait" | "halftime" | "result" | "failed" | "unknown";

export function panelForState(state: MatchState | string | undefined): MatchPanel {
  switch (state) {
    case "BRIEFING":
      return "briefing";
    case "GEN1":
    case "GEN2":
      return "genwait";
    case "H1_BREAK":
      return "halftime";
    case "FINISHED":
      return "result";
    case "FAILED":
      return "failed";
    default:
      return "unknown";
  }
}

/** Poll GET /api/matches/:id only while the server is generating (LLD-web §2). */
export function shouldPoll(state: MatchState | string | undefined): boolean {
  return state === "GEN1" || state === "GEN2";
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

/** Running score over the first `revealedCount` events (text-playback scoreboard). */
export function runningScore(events: MatchEventLike[], revealedCount: number): ScorePair {
  const score = { home: 0, away: 0 };
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
        t.shots += 1;
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
