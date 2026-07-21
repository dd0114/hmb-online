/**
 * Pure league helpers (unit-tested) — standings ordering, fixture grouping, season state.
 *
 * 관점 계약(league-rules §4): 순위표·일정은 **픽스처 관점 그대로**(홈-어웨이 열) 표시한다.
 * 매치 화면 스코어보드/결과 화면의 유저 관점 오리엔트는 매치 플로우(ResultPage) 소관이라 여기서
 * 다루지 않는다. rank 는 서버가 승점 3-1-0 → 골득실 → 다득점 → 승자승으로 이미 계산한 authoritative
 * 값이다 — 클라는 rank 오름차순으로 렌더한다(방어적 비교자도 제공).
 */
import type { LeagueFixture, LeagueSeason, LeagueStanding, LeagueTeam } from "../api/v2";
import type { LeagueResponseP3, LeagueSeasonReward } from "../api/p3";

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

/* ───────────────── 시즌 종료 보상 (PRD-v4 §E / AC-E1, P3-D8) ─────────────────
 *
 * 멱등성 계약: 보상 **지급은 서버 소관**(AC-F4 기구현). 클라는 GET /api/league 의 결과를
 * 읽어 표시만 하며 지급 트리거 POST 를 **절대** 보내지 않는다 — 재진입/재조회(FAILED 재시도
 * 버튼 포함)는 전부 GET refetch 라 중복 지급이 구조적으로 불가능하다(AC-E1 "멱등, 중복 지급 0").
 */

/** 시즌 요약(유저 행에서 파생) — 종료 화면 카드용. */
export interface SeasonSummary {
  rank: number;
  played: number;
  won: number;
  drawn: number;
  lost: number;
  goalsFor: number;
  goalsAgainst: number;
  goalDiff: number;
  points: number;
  /** "12승 3무 3패" */
  record: string;
  /** "+9" / "-4" / "0" — 부호 포함 골득실. */
  goalDiffLabel: string;
  /** "38 - 29" — 득점 - 실점. */
  goalsLabel: string;
}

/** standings 의 isUser 행에서 시즌 요약을 계산한다. 유저 행이 없으면 null(요약 숨김). */
export function seasonSummary(standings: readonly LeagueStanding[]): SeasonSummary | null {
  const me = standings.find((s) => s.isUser);
  if (!me) return null;
  return {
    rank: me.rank,
    played: me.played,
    won: me.won,
    drawn: me.drawn,
    lost: me.lost,
    goalsFor: me.goalsFor,
    goalsAgainst: me.goalsAgainst,
    goalDiff: me.goalDiff,
    points: me.points,
    record: `${me.won}승 ${me.drawn}무 ${me.lost}패`,
    goalDiffLabel: signed(me.goalDiff),
    goalsLabel: `${me.goalsFor} - ${me.goalsAgainst}`,
  };
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

/**
 * 응답에서 seasonReward 를 뽑는다(Phase3 additive).
 * **경계(흐리면 안 됨)**:
 *  - 필드 **부재/null/undefined** → `null` → 화면 기존 그대로(구 서버 폴백, 깨짐 0).
 *  - 값이 **있는데 형태가 계약 밖**(원시값 `"boom"`/`42`/`true`, 배열, 미지 status, 비숫자
 *    rank/points) → **FAILED 로 승격해 노출**. 조용히 감추면 유저가 미지급을 알 길이 없다(AC-E1).
 *
 * 위치는 `season.seasonReward` 우선, 루트 `seasonReward` 도 수용 — openapi-v3 발행 시 한쪽으로
 * 고정하고 이 관용 로직을 좁힌다(통합 정합 지점).
 */
export function pickSeasonReward(res: LeagueResponseP3 | null | undefined): LeagueSeasonReward | null {
  // ?? 로 부재만 걸러낸다 — falsy(0, "") 는 "값이 있음"이라 폴백 대상이 아니다.
  const raw = res?.season?.seasonReward ?? res?.seasonReward ?? null;
  if (raw === null || raw === undefined) return null;

  // 여기부터 raw 는 "값이 있음" — 어떤 형태든 화면에서 사라지지 않는다.
  const obj: Partial<LeagueSeasonReward> =
    typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const known = obj.status === "AWARDED" || obj.status === "PENDING" || obj.status === "FAILED";
  const numeric = Number.isFinite(obj.rank) && Number.isFinite(obj.points);
  if (!known || !numeric) {
    return {
      rank: Number.isFinite(obj.rank) ? (obj.rank as number) : 0,
      points: Number.isFinite(obj.points) ? (obj.points as number) : 0,
      status: "FAILED",
      message: obj.message ?? "보상 상태를 확인할 수 없습니다 (알 수 없는 응답)",
    };
  }
  return obj as LeagueSeasonReward;
}

/**
 * 지급 시각 표시("2026-07-20 09:00"). 서버 ISO 문자열을 **순수 문자열 연산**으로만 자른다
 * (`new Date`/로케일 의존 없음 — 결정론·SSR 안전, 루트 §2-5 정신).
 * 파싱 불가면 원문 그대로(정보 손실 0).
 */
export function formatAwardedAt(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})/.exec(iso);
  return m ? `${m[1]} ${m[2]}` : iso;
}

export interface SeasonRewardView {
  status: LeagueSeasonReward["status"];
  /** 획득 포인트를 실제 지급액으로 표시할지(PENDING/FAILED 는 "예정/미지급"으로 취급). */
  showPoints: boolean;
  /** 포인트 카운트업 연출 대상인지(AWARDED 만). */
  animate: boolean;
  headline: string;
  detail: string;
  /** FAILED 재조회(GET) 버튼 노출 — 지급 트리거가 아니다. */
  canRetry: boolean;
  tone: "success" | "pending" | "error";
}

/** status → 화면 표현(순수). 세 상태 전부 사용자에게 보이게 만든다(조용한 숨김 금지). */
export function seasonRewardView(reward: LeagueSeasonReward): SeasonRewardView {
  switch (reward.status) {
    case "AWARDED":
      return {
        status: "AWARDED",
        showPoints: true,
        animate: true,
        headline: "보상 지급 완료",
        detail: `${reward.rank}위 보상 ${reward.points.toLocaleString()}P 가 지갑에 반영됐습니다`,
        canRetry: false,
        tone: "success",
      };
    case "PENDING":
      return {
        status: "PENDING",
        showPoints: false,
        animate: false,
        headline: "보상 지급 처리 중",
        detail: `${reward.rank}위 보상 ${reward.points.toLocaleString()}P 지급을 처리하고 있습니다. 잠시 후 다시 확인해 주세요.`,
        canRetry: true,
        tone: "pending",
      };
    default:
      return {
        status: "FAILED",
        showPoints: false,
        animate: false,
        headline: "보상이 지급되지 않았습니다",
        detail: reward.message?.trim()
          ? reward.message.trim()
          : "보상 지급에 실패했습니다. 다시 조회해도 해결되지 않으면 문의해 주세요.",
        canRetry: true,
        tone: "error",
      };
  }
}
