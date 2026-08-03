/**
 * 선수 기록 **표시 계층**의 순수 로직 (#403 W2).
 *
 * 집계는 `player-stats.ts`(W1) 가 소유한다 — 여기서 지표를 다시 계산하지 않는다. 이 파일이 하는 일은
 * "그 줄들을 화면에 어떻게 세우나"뿐이다: 이름·등번호·포지션 붙이기 · 정렬 · 열 값 파생 · 세그먼트.
 * React·DOM 의존 0(그래서 계약이 브라우저 없이 이 규칙들을 죽인다).
 *
 * ⚠️ 키는 전부 `playerKey(team, playerId)` 다. 유저 덱과 봇 로스터가 **같은 카탈로그를 공유**해
 * 같은 `playerId` 가 양 팀에 동시에 뛴다(#231) — 맨 id 로 조회하면 두 사람이 한 줄로 합쳐진다.
 */
import { buildPlayerNames, UNKNOWN_PLAYER_NAME } from "../common/player-names";
import { jerseyNumbers } from "./viewer-skins";
import { halfForState, isHalftimeState } from "./stage/stage-state";
import {
  passPct,
  playerKey,
  playerKeySet,
  type PlayerPosition,
  type PlayerStatLine,
  type PlayerStatsResult,
  type TeamSide,
} from "./player-stats";

/**
 * **선택된 선수 한 명** — 표의 행 강조·피치 강조·요약 카드가 같은 것을 가리키는 키.
 *
 * ⚠️ 키는 반드시 `(team, playerId)` 다 — 같은 `playerId` 가 양 팀에 동시에 뛴다(#231).
 * ⚠️ 이 타입이 **(A) 쪽에 사는 것이 의도**다. 원래 `pitch-hit.ts`((B))에 있었는데, 그러면 선수 탭이
 * 피치 모듈에 의존해 **(A) 만 떼서 머지할 수가 없다**(#421 로 (B) 통합이 보류된 동안 필요한 성질).
 * 피치 쪽은 `PitchSelection` 이라는 이름으로 이걸 재수출한다 — (B) 의 공개 API 는 안 바뀐다.
 */
export interface PlayerSelection {
  team: TeamSide;
  playerId: string;
}

/**
 * 카탈로그(`GET /api/players`) 에서 우리가 쓰는 최소 형상. 응답 형태는 믿지 않는다.
 *
 * `name`/`shortName` 은 이 파일이 읽지 않는다 — **초크포인트가 구조 판정으로 읽는다**
 * (`nameEntryOf`, 그래서 openapi 생성 타입에 `shortName` 이 없어도 실려 오면 살아난다).
 * 여기 적어 두는 것은 "이 행에 무엇이 실려 오는가"의 문서용이다.
 */
export interface CatalogLike {
  id?: unknown;
  name?: unknown;
  position?: unknown;
}

/**
 * 로그에 등장한 선수 한 명의 표시 메타.
 *
 * ⚠️ **이름 필드가 두 축인 것은 의도다**(#406 요구 6, W8). 여기 한때 `name` 하나만 있었고 그 값은
 * `catalog.name ?? playerId` 였다 — 즉 이 파일이 **선수명 사다리를 두 번째로 선언**하고 있었고
 * 3단이 `playerId` 였다(화면에 `P077` 이 뜬 그 패턴). 지금 두 값은 전부
 * `common/player-names` 초크포인트가 만든다. 축은 **자리**가 정한다(그 파일 머리말 표):
 *  · `short` = 밀집 UI — 선수 탭 표 행 · 하프 리포트 카드(번호 원·포지션 칩이 같은 줄에 앉는다)
 *  · `full`  = 넓은 자리 — 선수 상세 모달 헤더처럼 한 줄을 통째로 쓰는 자리
 *
 * ⚠️ **`name` 으로 되돌리지 마라.** 하나로 합치면 소비자가 축을 고를 수 없고, 그 순간 밀집 UI 와
 * 모달 헤더 중 한쪽이 잘못된 축을 그린다(오늘은 두 축의 값이 같아 **화면 차이가 0**이라 안 보인다 —
 * #411 스위치 날에야 드러난다). 계약 = `player-stats-view.names.test.ts`.
 */
export interface RosterMeta {
  /** 밀집 UI 용 짧은 이름. 발행물에 `shortName` 이 없으면 풀네임과 같다(설계된 폴백, #411). */
  short: string;
  /** 넓은 자리용 풀네임. */
  full: string;
  position: PlayerPosition | null;
  /** 등번호(1~11). 로그 등장 순서로 코어와 **같은 규칙**을 쓴다 — 토큰과 표가 다른 번호를 말하면 안 된다. */
  num: string | null;
}

const POSITIONS: ReadonlySet<string> = new Set(["GK", "DF", "MF", "FW"]);

/**
 * 로그에 등장하는 `(team, playerId)` 전원의 표시 메타.
 *
 * 이름·포지션은 **카탈로그**에서 온다 — 봇 로스터도 같은 선수 카탈로그를 쓰므로 상대 팀까지
 * 여기서 나온다(루트 CLAUDE §#231). 등번호는 `viewer-skins.jerseyNumbers` 를 **재사용**한다:
 * 경기장 토큰이 그 규칙으로 번호를 달고 있어서, 표가 따로 매기면 같은 선수가 화면에서 두 번호를
 * 갖는다(그리고 유저는 토큰↔행을 번호로 잇는다).
 *
 * ⚠️ **이름은 `buildPlayerNames` 초크포인트가 만든다**(#406 요구 6). 여기서 `c.name` 을 직접 읽지
 * 마라 — 구 코드가 `typeof c.name === "string" && c.name ? c.name : c.id` 로 **사다리 1단과 3단을
 * 다시 선언**하고 있었고, 그 3단이 `playerId` 였다. 정규화 자리처럼 보이지만 정규화는 초크포인트의
 * `nameEntryOf` 가 이미 한다(빈 문자열·비문자열 거부 포함) — 여기 남기면 규칙이 두 벌이 된다.
 * 포지션만 이 파일의 몫이라 그것만 따로 표로 만든다.
 *
 * ⚠️ `/api/players` 가 배열이 아닐 수 있다(구 서버·목의 `200 {}`) → 초크포인트가 그 형태를 흡수해
 * 빈 이름표를 준다(`buildPlayerNames` 는 배열·Map 이 아니면 `size 0`). 그러면 이름이
 * `미상 선수` 로 떨어질 뿐 화면은 성립한다 — 여기서 던지면 관전 화면이 흰 화면이 된다.
 */
export function buildRosterMeta(
  log: unknown,
  catalog: readonly CatalogLike[] | null | undefined,
): Map<string, RosterMeta> {
  const names = buildPlayerNames(catalog);
  const posById = new Map<string, PlayerPosition>();
  if (Array.isArray(catalog)) {
    for (const c of catalog) {
      if (!c || typeof c.id !== "string") continue;
      if (typeof c.position === "string" && POSITIONS.has(c.position)) {
        posById.set(c.id, c.position as PlayerPosition);
      }
    }
  }
  const nums = jerseyNumbers(log);
  const out = new Map<string, RosterMeta>();
  for (const [key, num] of Object.entries(nums)) {
    const i = key.indexOf(":");
    const id = i >= 0 ? key.slice(i + 1) : key;
    out.set(key, {
      short: names.short(id),
      full: names.full(id),
      position: posById.get(id) ?? null,
      num,
    });
  }
  return out;
}

/** 평점의 포지션 보정용 표 — `computePlayerStats({ positions })` 가 그대로 받는다. */
export function positionsOf(roster: ReadonlyMap<string, RosterMeta>): Record<string, PlayerPosition> {
  const out: Record<string, PlayerPosition> = {};
  for (const [key, meta] of roster) if (meta.position) out[key] = meta.position;
  return out;
}

/** GK 키 집합 — `computePlayerStats({ gkKeys })` 규약대로 **`playerKey` 형태**로 만든다. */
export function gkKeysOf(roster: ReadonlyMap<string, RosterMeta>): Set<string> {
  const pairs: [TeamSide, string][] = [];
  for (const [key, meta] of roster) {
    if (meta.position !== "GK") continue;
    const i = key.indexOf(":");
    const side = key.slice(0, i);
    if (side !== "home" && side !== "away") continue;
    pairs.push([side, key.slice(i + 1)]);
  }
  return playerKeySet(pairs);
}

// ── 행 ───────────────────────────────────────────────────────────────────

export interface PlayerRow {
  key: string;
  team: TeamSide;
  playerId: string;
  /**
   * 표 한 행의 이름 = **밀집 축**(`RosterMeta.short`). 행은 `[번호][이름][포지션][평점]…` 이라
   * 이름 옆에 조각이 같이 앉는다(축 규칙 = `common/player-names.ts` 머리말).
   * 못 찾으면 `미상 선수` — **`playerId` 로 떨어지지 않는다**(사다리 3단은 초크포인트 한 곳).
   */
  name: string;
  position: PlayerPosition | null;
  num: string | null;
  isGk: boolean;
  line: PlayerStatLine;
  /** 표의 `패스%` 열 — 시도 0 이면 null(0% 는 거짓말이다, `passPct` 규약). */
  passPct: number | null;
  /**
   * 표의 `수비` 열. 필드 플레이어 = 태클+가로채기+걷어내기, **GK = 선방**(목업 ① 그대로).
   * 한 열이 두 뜻을 갖는 건 실제 축구 앱의 요약 표가 하는 것과 같다 — 대신 행에 `data-gk` 를
   * 달아 화면이 "선방"이라고 **말하게** 한다(숫자만 두면 GK 가 수비를 5번 한 것으로 읽힌다).
   */
  defence: number;
}

/**
 * 그 팀의 행들. 로그에 **등장한 선수만**(로스터에 있어도 안 뛴 선수는 표에 없다 — 출전 0 을
 * 0.0 평점으로 깔면 표가 벤치로 채워진다).
 */
export function rowsFor(
  result: PlayerStatsResult,
  team: TeamSide,
  roster: ReadonlyMap<string, RosterMeta>,
): PlayerRow[] {
  const out: PlayerRow[] = [];
  for (const line of result.players) {
    if (line.team !== team) continue;
    if (line.ticksPlayed <= 0) continue;
    const meta = roster.get(line.key);
    const isGk = meta?.position === "GK";
    out.push({
      key: line.key,
      team: line.team,
      playerId: line.playerId,
      // 로스터에 없는 키(성긴 로그로 등번호를 못 만든 경우) → 사다리 3단. `line.playerId` 를
      // 쓰지 마라 — 그게 화면에 `P077` 을 띄웠던 패턴이고, 3단은 초크포인트 한 곳에만 있다.
      name: meta?.short ?? UNKNOWN_PLAYER_NAME,
      position: meta?.position ?? null,
      num: meta?.num ?? null,
      isGk,
      line,
      passPct: passPct(line),
      defence: isGk ? line.saves : line.tackles + line.interceptions + line.clearances,
    });
  }
  return out;
}

// ── 정렬 ─────────────────────────────────────────────────────────────────

export type SortKey = "rating" | "goals" | "shots" | "passPct" | "defence" | "num";

/** 정렬 칩 — 순서까지 계약이다(목업 ①). */
export const SORT_KEYS: readonly SortKey[] = ["rating", "goals", "shots", "passPct", "defence", "num"];

export const SORT_LABELS: Record<SortKey, string> = {
  rating: "평점",
  goals: "골",
  shots: "슈팅",
  passPct: "패스%",
  defence: "수비",
  num: "번호",
};

/**
 * 처음 열었을 때 고르는 축 = **평점**(목업 ① — 평점 칩이 눌린 채로 그려져 있다).
 * 값이 아니라 **의도**다: 표의 첫 질문은 "누가 잘했나"이고, 등번호 순은 그걸 안 알려 준다.
 * ⚠️ 계약이 이 값을 리터럴로 박고(`player-stats-view.test.ts`) 화면에서도 확인한다
 * (`e2e/p403-player-tab.spec.ts` ② — 칩 선택 + **실제 정렬 결과**). 예전엔 둘 다 없어서
 * `"goals"` 로 바꾸는 변이가 유닛 91 + e2e 14 를 전부 통과했다(독립검증 m2).
 */
export const DEFAULT_SORT: SortKey = "rating";

/**
 * 정렬. 수치 칩은 **내림차순**(잘한 순), `번호`만 오름차순(라인업 순으로 읽는 자리).
 *
 * ⚠️ 동점은 **평점 → 등번호 → 키** 로 끝까지 끊는다. 안 끊으면 같은 화면을 두 번 열었을 때
 * 순서가 달라 보이고(브라우저 sort 는 안정적이지만 입력 순서가 바뀌면 결과도 바뀐다) 계약을 못 쓴다.
 * `패스%` 의 null(시도 0)은 **항상 뒤**로 — 0% 로 취급하면 안 찬 선수가 최악으로 읽힌다.
 */
export function sortRows(rows: readonly PlayerRow[], key: SortKey): PlayerRow[] {
  const out = rows.slice();
  out.sort((a, b) => {
    if (key === "num") {
      const d = numValue(a) - numValue(b);
      if (d !== 0) return d;
    } else {
      const av = sortValue(a, key);
      const bv = sortValue(b, key);
      if (av !== bv) return bv - av;
      if (a.line.rating !== b.line.rating) return b.line.rating - a.line.rating;
      const d = numValue(a) - numValue(b);
      if (d !== 0) return d;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  return out;
}

/** 정렬 축의 값. `패스%` 의 null 은 -1 = 항상 맨 뒤(0% 와 구분된다). */
function sortValue(row: PlayerRow, key: Exclude<SortKey, "num">): number {
  switch (key) {
    case "rating":
      return row.line.rating;
    case "goals":
      return row.line.goals;
    case "shots":
      return row.line.shots;
    case "passPct":
      return row.passPct ?? -1;
    case "defence":
      return row.defence;
  }
}

/** 등번호 정렬값 — 번호가 없으면 맨 뒤. */
function numValue(row: PlayerRow): number {
  const n = row.num == null ? NaN : Number(row.num);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

// ── 표시 파생 ────────────────────────────────────────────────────────────

export type RatingTier = "motm" | "hi" | "mid" | "low";

/**
 * 평점 칩의 등급. 실축 앱 관례(7.5+ 호평 / 7.0+ 무난 / 그 아래 평범)를 그대로 쓰되,
 * **MOTM 은 값이 아니라 신분**이라 별도다(집계가 이미 뽑아 준다).
 */
export function ratingTier(rating: number, isMotm: boolean): RatingTier {
  if (isMotm) return "motm";
  if (rating >= 7.5) return "hi";
  if (rating >= 7.0) return "mid";
  return "low";
}

/** `72%` / 시도가 없으면 `—`. */
export function passPctLabel(v: number | null): string {
  return v == null ? "—" : `${Math.round(v)}%`;
}

/**
 * 패스 귀속이 불완전한가 — `passAttributionCoverage` 가 1 미만이면 참.
 *
 * ⚠️ **숨기지 않는 것이 이 화면의 입장이다**(W1 독립 검증 권고). 스냅샷이 성긴 로그(서버 트림·
 * 구 매치)에서는 소유 체인이 끊겨 패스 시도의 일부가 아무에게도 안 붙는다 — 그 상태에서 숫자만
 * 보여주면 "이 선수는 패스를 10번밖에 안 했다"는 **거짓**이 된다. 커버리지를 같이 말한다.
 * 커버리지를 모르면(시도 0) 경고하지 않는다 — 아직 아무 일도 안 일어난 화면이다.
 */
export function passIncomplete(coverage: number | null): boolean {
  return coverage != null && coverage < 0.999;
}

/** `기록 불완전 (패스 82% 귀속)` — 무엇이 불완전한지까지 말한다. */
export function coverageLabel(coverage: number | null): string | null {
  if (!passIncomplete(coverage)) return null;
  return `패스 귀속 ${Math.floor((coverage ?? 0) * 100)}%`;
}

// ── 팀 세그먼트 ──────────────────────────────────────────────────────────

export interface TeamSegment {
  side: TeamSide;
  label: string;
  /** 내 팀인가 — 칩은 **이름 바로 뒤**에 붙는다(#322 표식 자리 규칙). */
  mine: boolean;
}

/**
 * `우리 ↔ 상대` 세그먼트 (#403 결정 ② = 상대도 **완전히 동일**, 지시문만 비공개).
 *
 * ⚠️ **순서는 홈 먼저다 — 내 팀을 앞으로 당기지 않는다**(#322 hero 확정 안 C).
 * 스코어바·통계 탭이 이미 사이드 순서로 읽히는데 여기만 유저 시점으로 뒤집으면, 어웨이 라운드에서
 * 한 화면의 왼쪽/오른쪽이 탭마다 다른 팀을 뜻한다. 대신 **내 팀 칩**이 어느 쪽이 나인지 말한다.
 * 어느 쪽도 내 팀이 아니면(관전) 칩이 없다 — 거짓 표식을 달지 않는다.
 */
export function teamSegments(
  names: { home: string; away: string },
  myTeamSide: "home" | "away" | null | undefined,
): TeamSegment[] {
  return [
    { side: "home", label: names.home, mine: myTeamSide === "home" },
    { side: "away", label: names.away, mine: myTeamSide === "away" },
  ];
}

/** 처음 열었을 때 고를 팀 = **내 팀**(모르면 홈). 순서를 안 바꾸는 대신 선택으로 답한다. */
export function defaultSegment(myTeamSide: "home" | "away" | null | undefined): TeamSide {
  return myTeamSide === "away" ? "away" : "home";
}

/**
 * ── 집계 창(窓) — **상한과 캡션의 단일 출처** (#403 W2 독립검증 BL-1) ─────────────────────────
 *
 * 처음엔 상한(`uptoTick`)은 훅이, 캡션은 화면이 각각 만들었다. 그래서 **둘이 따로 놀았고**
 * 감독시간에서 정확히 그 사고가 났다: 무대가 `경기장면` 탭으로 내려가(#244) `MatchViewer` 가
 * 마운트되지 않으니 `tick === null` → 상한이 `0` 으로 폴백 → **전 선수 0** 인데, 캡션은
 * `headerMinute`(감독시간엔 하프 끝 분)을 받아 **"7분까지의 기록"** 이라고 말했다.
 * 헤더가 `0 : 1` 을 말하는 같은 화면에서 표는 전부 0 이었다 — #388 의 "한 화면이 두 시각을
 * 말했다"와 같은 부류이고, 요구 A·결정 ②가 가장 필요로 하는 자리다(하프타임 지시의 근거).
 *
 * 그래서 **하나가 둘을 같이 정한다.** 상한이 없으면 분을 말하지 않고, 분을 말하면 상한이 있다.
 *
 * ## 갈림의 축은 "매치가 끝났나"가 아니라 **"지금 보는 하프가 끝났나"** 다
 *  · 전반은 `HALFTIME`·`H1_BREAK`·`GEN2` 부터 이미 **확정**이다(헤더가 `scoreH1*` 로 말한다).
 *  · 후반은 `FINISHED` 에서 확정.
 * 확정된 하프에는 상한이 없다 — 재생 위치로 자를 이유가 없고, 자르면 위 결함이 된다.
 *
 * ## `tick === null` 은 0 이 아니다
 * "아직 모른다"와 "0틱까지"는 다른 사실이다. 확정 하프면 위 규칙이 먼저 답하고, **진행 중인데
 * 재생 위치를 모르면** `pending` 이다.
 * ⚠️ 독립검증은 이 경우 *"상한 없음이 안전하다"* 고 제안했지만 **그대로 따르지 않았다** —
 * 진행 중 하프에 상한이 없으면 그건 곧 **앞을 보여주는 것**이라 #233/#238 을 정면으로 어긴다.
 * 대신 `uptoTick: -1`(그 하프에서 아무것도 세지 않는다) + **"기다리는 중"이라고 말하는 캡션**으로
 * 간다. 0 을 데이터로 그리지도, 앞을 열지도 않는다. (도달 경로 = 라이브 하프의 첫 프레임, 그리고
 * 캔버스가 죽어 텍스트 폴백으로 떨어진 상태.)
 */
export type StatsWindowKind = "settled" | "live" | "pending";

export interface StatsWindow {
  kind: StatsWindowKind;
  /** 이 하프에 걸리는 상한(포함). **null = 상한 없음**(그 하프는 확정이다). */
  uptoTick: number | null;
  /** 선수 탭 캡션. null = 캡션 없음(확정 하프 — 목업 ①·③ "종료 경기면 붙지 않는다"). */
  caption: string | null;
  /** 피치 카드의 꼬리표(`26분까지`). 같은 창에서 나온다 — 두 화면이 다른 말을 하지 않게. */
  shortLabel: string | null;
}

/** 지금 무대가 보는 하프가 **이미 끝났나**. `halfForState` 와 같은 축으로 판정한다. */
export function currentHalfSettled(state: string | undefined): boolean {
  if (halfForState(state) === 2) return state === "FINISHED";
  // 전반을 보는 상태들 중 전반이 이미 끝난 것들.
  return isHalftimeState(state) || state === "GEN2";
}

/**
 * 상한 + 캡션. **`minute` 은 로그가 구운 값**(#388, `headerMinute` 이 준 것)을 그대로 받는다 —
 * 여기서 `floor(tick/60)` 같은 유도를 하지 마라.
 */
export function statsWindow(
  state: string | undefined,
  playheadTick: number | null,
  minute: number | null,
): StatsWindow {
  if (currentHalfSettled(state)) {
    return { kind: "settled", uptoTick: null, caption: null, shortLabel: null };
  }
  if (playheadTick == null) {
    // A-4(독립검증, 필수 아님): 어느 하프를 기다리는지 말한다. 후반 대기 화면에서 "재생 위치를
    // 기다리는 중"만 뜨면 유저는 **전반 기록도 없는 것**으로 읽는다(실제로는 전반은 이미 표에 있다).
    const label = halfForState(state) === 2 ? "후반" : "전반";
    return {
      kind: "pending",
      uptoTick: -1,
      caption: `${label} 재생 위치를 기다리는 중`,
      shortLabel: "재생 대기",
    };
  }
  return {
    kind: "live",
    uptoTick: playheadTick,
    caption: minute == null ? "지금까지의 기록" : `${minute}분까지의 기록`,
    shortLabel: minute == null ? "지금까지" : `${minute}분까지`,
  };
}

/** MOTM 인가 — 키 비교 한 곳(맨 id 비교로 되돌아가지 않게). */
export function isMotmKey(result: PlayerStatsResult, key: string): boolean {
  return result.motm != null && result.motm.key === key;
}

/**
 * **이 창에서 MOTM 으로 표시할 키** — 없으면 null (#403 W4).
 *
 * 게이트는 `kind === "settled"` 다: 진행 중인 경기에 *"이 경기 최우수 선수"* 는 없다(집계는
 * 상한까지의 값으로 MOTM 을 계속 뽑지만, 그건 "지금까지 1위"이지 이 경기의 결론이 아니다).
 *
 * ⚠️ **판정이 두 곳에 있으면 안 된다.** 선수 탭은 `win.kind === "settled" && isMotmKey(…)` 를
 * 인라인으로 쓰고 있었고, 결과 탭(W4)이 같은 식을 한 번 더 쓰면 한쪽만 낡는다 — 결과 탭은
 * `FINISHED` 전용이라 조건이 **항상 참**이어서 그 인라인이 조용히 게이트 없는 형태로 굳는다.
 * 그래서 두 화면 모두 이 함수를 통과한다(호출부에 `kind` 비교를 다시 적지 마라).
 */
export function motmKeyFor(result: PlayerStatsResult | null, win: StatsWindow): string | null {
  if (!result || win.kind !== "settled") return null;
  return result.motm?.key ?? null;
}

/**
 * **MOTM 한 줄이 가리킬 행** — 지금 고른 세그먼트와 무관하게 **양 팀에서** 찾는다 (#403 W4).
 *
 * 상대가 MOTM 인 경기가 실제로 있고(라이브 표본이 그렇다), 그때 이 줄이 비면 화면이 *"우리 중
 * 최고"* 라는 **다른 뜻**을 말한다.
 *
 * ⚠️ **화면이 아니라 여기 있는 이유** = 계약이 잴 수 있는 자리로 옮긴 것이다(R1, 독립검증
 * minor-1). 이 탐색이 `ResultPanel` 안에 있는 동안 *"`home` 항을 떨어뜨린다"* 는 변이가
 * 리포의 e2e 표본에서 **살아남았다** — 그 표본들은 MOTM 이 **언제나 away 사이드**라서다
 * (`away-fixture`·`home-fixture` 는 매치 메타의 **사이드 라벨만** 뒤집고 하프 로그는 같다).
 *
 * ⚠️ **R1 이 여기에 적었던 이유 설명은 거짓이었고 R2 에서 철회한다.** 그 문단은
 * *"평점이 10.0 에서 포화해 동점자가 여럿이고 `pickMotm` 의 마지막 tie-break 가 키 오름차순이라
 * `away:*` 가 항상 이긴다 = 실로그를 어떻게 relabel 해도 home MOTM 표본은 안 나온다"* 였다.
 * 직접 재보면 **기제부터 틀렸다** — 이 픽스처(출전 25명)에서 10.0 은 **2명**이고
 * (`home:P121` goals0/assists0 · `away:P079` goals0/assists1) 승부는 **assists 에서 갈린다**.
 * 키 tie-break 는 **한 번도 발화하지 않는다**. 그래서 relabel 이 실제로 먹힌다:
 * 팀 라벨을 뒤집으면 MOTM = `home:P079`, 전반 로그만 쓰면 MOTM = `home:P121`(그쪽은 최고 7.4 **단독**).
 *
 * 그러니 순수 계층에 둔 근거는 *"e2e 로는 불가능해서"* 가 아니라 **더 싸고 정확해서**다 —
 * 유닛은 home/away MOTM 을 **직접 먹여** 표본을 만들고(로그를 조작해 우연히 그 상태가 되기를
 * 기대하지 않는다) 브라우저 없이 그 축만 잰다. e2e 로도 **가능하다**(라벨을 뒤집은 하프 로그를
 * 서빙하면 home MOTM 이 나오고 위 변이가 죽는다) — `p403-result-players.spec.ts` ①의
 * "MOTM 이 home 사이드여도" 계약이 실제로 그렇게 잰다.
 */
export function motmRowOf(
  result: PlayerStatsResult | null,
  roster: ReadonlyMap<string, RosterMeta>,
  motmKey: string | null,
): PlayerRow | null {
  if (!result || motmKey == null) return null;
  for (const team of ["home", "away"] as const) {
    const row = rowsFor(result, team, roster).find((r) => r.key === motmKey);
    if (row) return row;
  }
  return null;
}

export { playerKey };
