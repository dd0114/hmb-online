/**
 * Pure league helpers (unit-tested) — standings ordering, fixture grouping, season state.
 *
 * 관점 계약(league-rules §4): 순위표·일정은 **픽스처 관점 그대로**(홈-어웨이 열) 표시한다.
 * 매치 화면 스코어보드/결과 화면의 유저 관점 오리엔트는 매치 플로우(ResultPage) 소관이라 여기서
 * 다루지 않는다. rank 는 서버가 승점 3-1-0 → 골득실 → 다득점 → 승자승으로 이미 계산한 authoritative
 * 값이다 — 클라는 rank 오름차순으로 렌더한다(방어적 비교자도 제공).
 */
import type { LeagueFixture, LeagueSeason, LeagueStanding, LeagueTeam } from "../api/v2";

/** 서버 rank(authoritative) 오름차순 안정정렬. 렌더 진입점. */
export function sortByRank(standings: readonly LeagueStanding[]): LeagueStanding[] {
  return [...standings].sort((a, b) => a.rank - b.rank || stableTeam(a.teamId, b.teamId));
}

/**
 * 방어적 타이브레이크 비교자(league-rules §2·3): 승점↓ → 골득실↓ → 다득점↓ → teamId 안정.
 * (승자승은 pairwise 라 순수 행 비교로는 불가 — 서버 rank 가 SoT. 이 비교자는 rank 부재/검증용.)
 */
export function standingsComparator(a: LeagueStanding, b: LeagueStanding): number {
  if (b.points !== a.points) return b.points - a.points;
  if (b.goalDiff !== a.goalDiff) return b.goalDiff - a.goalDiff;
  if (b.goalsFor !== a.goalsFor) return b.goalsFor - a.goalsFor;
  return stableTeam(a.teamId, b.teamId);
}

function stableTeam(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export interface RoundGroup {
  round: number;
  fixtures: LeagueFixture[];
}

/** 픽스처를 라운드별로 묶어 라운드 오름차순으로 반환(일정표). 라운드 내부는 입력 순서 유지. */
export function groupByRound(fixtures: readonly LeagueFixture[]): RoundGroup[] {
  const byRound = new Map<number, LeagueFixture[]>();
  for (const f of fixtures) {
    const list = byRound.get(f.round);
    if (list) list.push(f);
    else byRound.set(f.round, [f]);
  }
  return [...byRound.keys()]
    .sort((a, b) => a - b)
    .map((round) => ({ round, fixtures: byRound.get(round)! }));
}

/** teamId → 표시명 매핑(일정표에서 fixture.homeTeam/awayTeam 는 teamId 라 이름 조인 필요). */
export function teamNameMap(teams: readonly LeagueTeam[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const t of teams) m.set(t.teamId, t.name);
  return m;
}

export function isSeasonFinished(season: LeagueSeason | null | undefined): boolean {
  return season?.state === "FINISHED";
}

/** 픽스처 관점 스코어 표시("2 - 1"). 미플레이면 null(일정만). */
export function fixtureScore(fixture: Pick<LeagueFixture, "state" | "scoreHome" | "scoreAway">): string | null {
  if (fixture.state !== "PLAYED") return null;
  return `${fixture.scoreHome ?? "-"} - ${fixture.scoreAway ?? "-"}`;
}

/** 유저 최종 순위(시즌 종료 화면·보상 연출용). standings 에서 isUser 행의 rank. */
export function userRank(standings: readonly LeagueStanding[]): number | null {
  const me = standings.find((s) => s.isUser);
  return me ? me.rank : null;
}
