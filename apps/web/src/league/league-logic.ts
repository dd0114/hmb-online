/**
 * Pure league helpers (unit-tested) — standings ordering, fixture grouping, season state.
 *
 * 관점 계약(league-rules §4): 순위표·일정은 **픽스처 관점 그대로**(홈-어웨이 열) 표시한다.
 * 매치 화면 스코어보드/결과 화면의 유저 관점 오리엔트는 매치 플로우(ResultPage) 소관이라 여기서
 * 다루지 않는다. rank 는 서버가 승점 3-1-0 → 골득실 → 다득점 → 승자승으로 이미 계산한 authoritative
 * 값이다 — 클라는 rank 오름차순으로 렌더한다(방어적 비교자도 제공).
 */
import { withIga } from "../common/currency";
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
 * 서버가 실제로 보내는 status(openapi `SeasonReward.status` = SoT) + 구 별칭.
 *
 * ⚠️ 여기에 `GRANTED`/`NONE` 이 없어서 **종료된 시즌의 보상 카드가 전부 FAILED 로 떴다**(#251 발견).
 * 이 집합에 서버 enum 을 넣는 것이 그 픽스다 — 목이 `AWARDED` 를 쓰고 있어 e2e 가 통과하고 있었다.
 * 새 status 를 추가할 땐 **서버 openapi 를 보고** 넣어라(클라가 이름을 지어내면 같은 사고가 반복된다).
 */
const KNOWN_STATUSES = new Set<LeagueSeasonReward["status"]>([
  "GRANTED",
  "PENDING",
  "NONE",
  "AWARDED", // 구 별칭 — 목/구클라 호환. 서버는 보내지 않는다.
  "FAILED",
]);

/** 지급 완료 계열(서버 GRANTED = 구 별칭 AWARDED). 화면 성공 표현의 단일 판정. */
export function isGranted(status: LeagueSeasonReward["status"]): boolean {
  return status === "GRANTED" || status === "AWARDED";
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
  const known = obj.status !== undefined && KNOWN_STATUSES.has(obj.status);
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
  /** 획득 보상액을 실제 지급액으로 표시할지(PENDING/미지급은 "예정/미지급"으로 취급). */
  showPoints: boolean;
  /** 보상액 카운트업 연출 대상인지(지급 완료만). */
  animate: boolean;
  headline: string;
  detail: string;
  /** 미지급 재조회(GET) 버튼 노출 — 지급 트리거가 아니다. */
  canRetry: boolean;
  tone: "success" | "pending" | "error";
}

/**
 * status → 화면 표현(순수). 모든 상태를 사용자에게 보이게 만든다(조용한 숨김 금지).
 *
 * `formatPoints`/`formatGems` 는 **재화 표기 주입점** (#232) — 순수 함수가 심볼을 알면 서버 주도
 * 표기가 깨진다. 기본값은 숫자만(단위 없음)이라, 주입을 잊어도 "P" 같은 틀린 단위가 새 나가지 않는다.
 *
 * **G·Z 병기**(#251): 시즌 젬이 "우승만"에서 "완주 전원"으로 바뀌어 종료 화면에 항상 두 재화가 같이
 * 온다. 문장에서도 둘을 함께 읽어 준다 — 옆줄의 젬 숫자만으로는 "이게 뭐 때문에 들어온 건지"를
 * 유저가 알 수 없었다. 젬이 0/부재면 문장은 기존 G 단독 형태 그대로(구 시즌 회귀 0).
 */
export function seasonRewardView(
  reward: LeagueSeasonReward,
  formatPoints: (value: number) => string = (v) => v.toLocaleString(),
  formatGems: (value: number) => string = (v) => v.toLocaleString(),
): SeasonRewardView {
  const gems = Number.isFinite(reward.gems) ? (reward.gems as number) : 0;
  const both = (amount: string) => (gems > 0 ? `${amount} · ${formatGems(gems)}` : amount);

  if (isGranted(reward.status)) {
    return {
      status: reward.status,
      showPoints: true,
      animate: true,
      headline: "보상 지급 완료",
      detail: `${reward.rank}위 보상 ${withIga(both(formatPoints(reward.points)))} 지갑에 반영됐습니다`,
      canRetry: false,
      tone: "success",
    };
  }
  if (reward.status === "PENDING") {
    return {
      status: "PENDING",
      showPoints: false,
      animate: false,
      headline: "보상 지급 처리 중",
      detail: `${reward.rank}위 보상 ${formatPoints(reward.points)} 지급을 처리하고 있습니다. 잠시 후 다시 확인해 주세요.`,
      canRetry: true,
      tone: "pending",
    };
  }
  // NONE(서버: 종료됐으나 지급 행 없음) · FAILED(클라 방어) — 둘 다 "안 받았다"를 보여준다.
  return {
    status: reward.status === "NONE" ? "NONE" : "FAILED",
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

/* ───────────────── 디비전 승급/강등 (#252 / 이슈 #262) ─────────────────
 *
 * 서버가 SoT 다. `division`(level, **작을수록 상위**) · `divisionName`(표시명) ·
 * `promoteRankMax` / `relegateRankMin`(순위 컷) 을 그대로 받아 쓴다.
 *
 * ⚠️ **컷을 클라에 하드코딩하지 마라.** 규칙은 config(`hmb.league.division.*`)이고 사다리 표는
 * data 발행물(`league.v2.json`)이라 서버에서 바뀔 수 있다. 복제하면 그때 조용히 어긋난다 —
 * 순위표에 "승급권"이라 칠해 놓고 실제로는 강등되는 화면이 나온다.
 * 같은 이유로 **디비전 이름을 level 에서 만들지 않는다**(D10 → "디비전 10" 같은 규칙 복제 금지).
 */

/** 순위가 속한 구역. 컷이 없으면(구 서버) 전부 `none` — 색칠도 라벨도 안 한다. */
export type DivisionZone = "promote" | "hold" | "relegate" | "none";

export interface DivisionInfo {
  level: number;
  /** 표시명. 서버가 안 주면 null — 클라가 지어내지 않는다. */
  name: string | null;
  promoteRankMax: number | null;
  relegateRankMin: number | null;
  /** 승급/강등 규칙을 화면에 설명할 수 있는 상태인지(둘 중 하나라도 있으면 true). */
  hasRules: boolean;
}

/**
 * 시즌에서 디비전 정보를 뽑는다. **구 서버 폴백**: 필드가 없으면 null → 화면은 기존 그대로.
 * (필드 부재와 "값이 0" 을 구분해야 해서 `??` 로 부재만 거른다.)
 */
export function pickDivision(season: LeagueSeason | null | undefined): DivisionInfo | null {
  const raw = season as (LeagueSeason & Partial<DivisionFields>) | null | undefined;
  if (!raw) return null;
  const level = numberOrNull(raw.division);
  if (level === null) return null; // 디비전 개념이 없는 서버 — 이 기능 전체를 숨긴다.
  const promoteRankMax = numberOrNull(raw.promoteRankMax);
  const relegateRankMin = numberOrNull(raw.relegateRankMin);
  return {
    level,
    name: typeof raw.divisionName === "string" && raw.divisionName.trim() ? raw.divisionName : null,
    promoteRankMax,
    relegateRankMin,
    hasRules: promoteRankMax !== null || relegateRankMin !== null,
  };
}

interface DivisionFields {
  division: number;
  divisionName: string | null;
  promoteRankMax: number;
  relegateRankMin: number;
}

function numberOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** 순위 → 구역. 컷이 없으면 `none`(색칠 안 함). */
export function zoneOfRank(rank: number, division: DivisionInfo | null): DivisionZone {
  if (!division || !division.hasRules) return "none";
  if (division.promoteRankMax !== null && rank <= division.promoteRankMax) return "promote";
  if (division.relegateRankMin !== null && rank >= division.relegateRankMin) return "relegate";
  return "hold";
}

/** 디비전 표시 라벨. 이름이 없으면 level 만("D5") — 없는 이름을 지어내지 않는다. */
export function divisionLabel(division: DivisionInfo | null): string | null {
  if (!division) return null;
  return division.name ?? `D${division.level}`;
}

/**
 * 승급/강등 규칙 한 줄 설명("1~2위 승급 · 9위부터 강등"). 컷이 없으면 null.
 * 서버 값만으로 만든다 — 문장에 숫자를 박지 않는다.
 */
export function divisionRuleText(division: DivisionInfo | null): string | null {
  if (!division || !division.hasRules) return null;
  const parts: string[] = [];
  if (division.promoteRankMax !== null) {
    parts.push(
      division.promoteRankMax === 1 ? "1위 승급" : `1~${division.promoteRankMax}위 승급`,
    );
  }
  if (division.relegateRankMin !== null) parts.push(`${division.relegateRankMin}위부터 강등`);
  return parts.join(" · ");
}

/**
 * 시즌 **종료** 시 유저에게 무슨 일이 일어났나. 승급/강등 연출의 입력.
 * ⚠️ 다음 디비전 level 을 클라가 계산하지 않는다 — 사다리 양 끝 클램프는 서버 규칙이라
 * 여기서 `level-1` 을 만들면 최상위에서 존재하지 않는 디비전을 표시하게 된다.
 */
export interface DivisionOutcome {
  zone: Extract<DivisionZone, "promote" | "hold" | "relegate">;
  headline: string;
  detail: string;
  tone: "success" | "neutral" | "error";
}

export function divisionOutcome(
  rank: number | null,
  division: DivisionInfo | null,
): DivisionOutcome | null {
  if (rank === null || !division || !division.hasRules) return null;
  const label = divisionLabel(division);
  const where = label ? `${label}에서 ` : "";
  switch (zoneOfRank(rank, division)) {
    case "promote":
      return {
        zone: "promote",
        headline: "승급!",
        detail: `${where}${rank}위 — 다음 시즌은 한 단계 위 디비전에서 시작합니다`,
        tone: "success",
      };
    case "relegate":
      return {
        zone: "relegate",
        headline: "강등",
        detail: `${where}${rank}위 — 다음 시즌은 한 단계 아래 디비전에서 시작합니다`,
        tone: "error",
      };
    default:
      return {
        zone: "hold",
        headline: "디비전 유지",
        detail: `${where}${rank}위 — 다음 시즌도 같은 디비전입니다`,
        tone: "neutral",
      };
  }
}
