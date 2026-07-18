/**
 * Pure log/ranking helpers (unit-tested) — no network, no clock reads.
 *
 * ⚠️ 관점 계약(league-rules §4 + openapi-v2 MatchLogItem): scoreHome/scoreAway 는 **픽스처(=엔진)
 * 관점** 원값이다. 로그 행에 이 원값을 그대로 "홈:어웨이"로 찍으면 유저가 어웨이였던 리그 경기에서
 * "내 스코어"가 뒤집혀 보인다. 반드시 userWasHome 로 오리엔트해 "내 득점 : 상대 득점"으로 표시한다.
 * result 는 서버가 이미 유저 관점으로 계산(WIN/DRAW/LOSS) — 그대로 사용.
 */
import type { MatchLogItem } from "../api/v2";

export type MatchMode = "practice" | "league";
export type MatchResult = "WIN" | "DRAW" | "LOSS";

export interface OrientedScore {
  /** 유저 팀 득점(userWasHome ? scoreHome : scoreAway). 미확정이면 null. */
  my: number | null;
  /** 상대 팀 득점(userWasHome ? scoreAway : scoreHome). 미확정이면 null. */
  opp: number | null;
}

type ScoreFields = Pick<MatchLogItem, "scoreHome" | "scoreAway" | "userWasHome">;

/**
 * 픽스처 관점 스코어를 유저 관점으로 오리엔트한다.
 * - userWasHome=true  → my=scoreHome,  opp=scoreAway  (연습·유저홈 리그)
 * - userWasHome=false → my=scoreAway,  opp=scoreHome  (어웨이 리그)
 */
export function orientScore(item: ScoreFields): OrientedScore {
  const home = item.scoreHome ?? null;
  const away = item.scoreAway ?? null;
  return item.userWasHome ? { my: home, opp: away } : { my: away, opp: home };
}

/** "내 득점 : 상대 득점" 표시 문자열. 미확정(null)이면 '-'. 원값 직표시 금지. */
export function formatMyScore(item: ScoreFields): string {
  const { my, opp } = orientScore(item);
  return `${my ?? "-"} : ${opp ?? "-"}`;
}

export const MODE_LABELS: Record<MatchMode, string> = {
  practice: "연습",
  league: "리그",
};

export const RESULT_LABELS: Record<MatchResult, string> = {
  WIN: "승",
  DRAW: "무",
  LOSS: "패",
};

/** 리그 경기 라운드 라벨(예: "R3"). 리그가 아니거나 라운드 없으면 null. */
export function roundLabel(item: Pick<MatchLogItem, "mode" | "round" | "seasonNo">): string | null {
  if (item.mode !== "league" || item.round == null) return null;
  return item.seasonNo != null ? `S${item.seasonNo} R${item.round}` : `R${item.round}`;
}

// ─────────────────────────── 필터 상태 (경기 로그) ───────────────────────────

export type ModeFilter = "all" | MatchMode;

export interface MatchLogFilter {
  mode: ModeFilter;
  /** 리그 시즌 번호 필터(모드=league 일 때만 의미). null=전체 시즌. */
  season: number | null;
}

export const DEFAULT_MATCH_LOG_FILTER: MatchLogFilter = { mode: "all", season: null };

/**
 * 필터 상태를 서버 쿼리스트링으로 직렬화(GET /api/logs/matches?mode&season). mode='all' 이면
 * mode 파라미터 생략. season 은 mode='league' 일 때만 유효(다른 모드면 무시). 순수·결정론.
 */
export function matchLogQuery(filter: MatchLogFilter): string {
  const params = new URLSearchParams();
  if (filter.mode !== "all") params.set("mode", filter.mode);
  if (filter.mode === "league" && filter.season != null) params.set("season", String(filter.season));
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

/**
 * 모드 선택 시 season 정합성 유지: league 가 아니게 되면 season 필터를 해제한다(무의미한 조합 방지).
 */
export function setFilterMode(filter: MatchLogFilter, mode: ModeFilter): MatchLogFilter {
  return { mode, season: mode === "league" ? filter.season : null };
}

export function setFilterSeason(filter: MatchLogFilter, season: number | null): MatchLogFilter {
  return { ...filter, season };
}

/** 승률(0..1) 표시 문자열 — 소수1 반올림 퍼센트. */
export function formatWinRate(rate: number | null | undefined): string {
  if (rate == null) return "-";
  const pct = Math.round(Math.max(0, Math.min(1, rate)) * 1000) / 10;
  return `${pct}%`;
}
