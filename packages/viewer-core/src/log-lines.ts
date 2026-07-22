/**
 * 게임 로그(FM식 코멘터리) 투영 — `MatchEvent[]` → 표시 라인.
 *
 * P4-D3 SoT: 이 파일이 원본이다. dev-viewer(QA)의 `renderTicker()` 는 같은 규칙을 인라인으로
 * 갖고 있는데, S2(코어 추출)에서 그 구현을 지우고 이 모듈을 소비한다. **규칙을 바꿀 땐 여기만 고친다.**
 * (S1 시점의 정의는 dev-viewer index.html `EV_LABEL`/`evTier`/`shotLabel`/`renderTicker` 와 1:1 동치.)
 *
 * 순수 함수 — DOM·프레임워크·시간·난수 의존 0(루트 CLAUDE §2-5 결정론 원칙과 같은 규율).
 */

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

/** 티커에 노출하는 이벤트 타입(그 외는 소음). */
const SHOWN = new Set([
  "goal", "shot", "tackle", "interception", "kickoff", "foul", "offside",
  "free_kick", "penalty", "card", "save", "substitution", "half_whistle", "full_whistle",
]);

const MAJOR_EV = new Set(["goal", "penalty", "card", "substitution", "half_whistle", "full_whistle"]);
const MINOR_EV = new Set(["tackle", "interception", "kickoff"]);

const EV_LABEL: Record<string, string> = {
  goal: "⚽ Goal", shot: "Shot", tackle: "Tackle", interception: "Interception",
  foul: "Foul", offside: "🚩 Offside", free_kick: "Free kick",
  penalty: "⚽ Penalty!", save: "🧤 Save", card: "Card",
  half_whistle: "Half-time", full_whistle: "Full-time",
};

const SHOT_LABEL: Record<string, string> = {
  saved: "Shot · saved 🧤",
  off_target: "Shot · off target",
  one_on_one: "1-on-1 chance!",
  penalty: "Penalty shot",
};

const RESTART_LABEL: Record<string, string> = {
  corner: "Corner",
  goal_kick: "Goal kick",
  throw_in: "Throw-in",
};

export function eventTier(e: LogEvent): LogTier {
  if (MAJOR_EV.has(e.type)) return "major";
  if (MINOR_EV.has(e.type)) return "minor";
  if (e.type === "shot" && e.detail === "off_target") return "minor";
  return "normal";
}

/** 티커에 나오는 이벤트인가 — 경기중 무-detail 킥오프(재시작 노이즈)는 숨긴다. */
export function isLogged(e: LogEvent): boolean {
  if (!SHOWN.has(e.type)) return false;
  if (e.type === "kickoff" && e.detail == null && e.minute > 0) return false;
  return true;
}

function labelOf(e: LogEvent): string {
  switch (e.type) {
    case "goal": return "⚽ GOAL";
    case "penalty": return "⚽ PENALTY awarded";
    case "card": return e.detail === "red" ? "🟥 Red card" : "🟨 Yellow card";
    case "substitution": return "🔄 Substitution";
    case "kickoff": return RESTART_LABEL[e.detail ?? ""] ?? "Kick-off";
    case "shot": return SHOT_LABEL[e.detail ?? ""] ?? "Shot on goal";
    case "free_kick": return e.detail ? `Free kick (${e.detail})` : "Free kick";
    default: return EV_LABEL[e.type] ?? e.type;
  }
}

/**
 * `uptoTick`(포함)까지의 로그 라인. `uptoTick` 을 주지 않으면 전체.
 * 골 라인에는 그 시점의 스코어를 함께 계산해 붙인다(진행 중 스코어 = 재생 시점 기준).
 */
export function logLines(events: readonly LogEvent[], uptoTick?: number): LogLine[] {
  const upto = uptoTick ?? Number.POSITIVE_INFINITY;
  const out: LogLine[] = [];
  let h = 0;
  let a = 0;
  for (const e of events) {
    // 정렬 가정을 하지 않는다(break 대신 continue) — 로그가 어떤 순서로 오든 결과가 같다.
    if (e.tick > upto) continue;
    if (e.type === "goal") {
      if (e.team === "home") h++;
      else if (e.team === "away") a++;
    }
    if (!isLogged(e)) continue;
    const line: LogLine = {
      tick: e.tick,
      minute: e.minute,
      type: e.type,
      tier: eventTier(e),
      label: labelOf(e),
    };
    if (e.type === "goal") line.score = `${h}-${a}`;
    if (e.playerId) line.number = e.playerId.replace(/[HA]/, "");
    if (e.team) line.team = e.team;
    if (e.type === "shot" && typeof e.xg === "number") line.xg = e.xg.toFixed(2);
    out.push(line);
  }
  return out;
}

/** `uptoTick` 까지의 스코어(골 이벤트 누적). 스코어바가 재생 진행에 맞춰 쓰는 값. */
export function scoreAt(events: readonly LogEvent[], uptoTick: number): { home: number; away: number } {
  let home = 0;
  let away = 0;
  for (const e of events) {
    if (e.type !== "goal" || e.tick > uptoTick) continue;
    if (e.team === "home") home++;
    else if (e.team === "away") away++;
  }
  return { home, away };
}
