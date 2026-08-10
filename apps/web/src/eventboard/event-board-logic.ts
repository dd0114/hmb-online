/**
 * `/event-board` (에픽 #492) 의 **순수 로직** — 네트워크·렌더·시계 접근 0.
 *
 * 화면(`EventBoardPage`)은 여기 결과를 그리기만 하고, 판정은 전부 `event-board-logic.test.ts`
 * 가 박제한다(`logs/logs-logic.ts` 선례).
 *
 * ── 서버 계약(#492 §Plan D3 동결본) ─────────────────────────────────────────
 * `GET /api/admin/events?event=&userId=&limit=&offset=`
 *   → `{ items:[{id,event,userId,nickname,occurredAt,props}], total, limit, offset }`
 *     · `props` 는 **파싱된 객체**로 온다(문자열 아님) · 정렬 = 최신순 · limit 기본 50 / 최대 200
 * `GET /api/admin/events/funnel`
 *   → `{ generatedAt, users:[{userId,nickname,firstSeenAt,lastSeenAt,
 *        reached:{signup,tutorial,deck,gacha,practice,league,away},matchesFinished,eventCount}] }`
 *     · 정렬 = `lastSeenAt DESC` (**서버가 정렬해서 준다** — 여기서 다시 정렬하지 않는다)
 *
 * ⚠️ 이 파일은 계약을 **읽는 쪽**이다. 필드가 늘면 여기와 e2e 목 페이로드를 같이 고쳐라 —
 * 목이 거짓이면 화면이 라이브에서 비어 있는데도 e2e 가 green 이다(#342 의 실제 사고).
 */

// ─────────────────────────── 이벤트 종류 ───────────────────────────

/** 기록되는 비즈니스 이벤트 7종 (#492 D1). 순서 = 필터 드롭다운 순서 = 유저 여정 순서. */
export const EVENT_TYPES = [
  "user_signup",
  "tutorial_complete",
  "deck_save",
  "gacha_pull",
  "match_start",
  "match_finish",
  "league_season_start",
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export const EVENT_LABELS: Record<EventType, string> = {
  user_signup: "가입",
  tutorial_complete: "튜토리얼 완료",
  deck_save: "덱 저장",
  gacha_pull: "뽑기",
  match_start: "경기 시작",
  match_finish: "경기 종료",
  league_season_start: "리그 시즌 시작",
};

/**
 * 서버가 **모르는 이벤트명을 줄 수도 있다**(서버가 먼저 나가는 것이 이 리포의 정상 상태다).
 * 라벨이 없으면 원문 그대로 — 화면에서 사라지게 두면 "기록됐는데 안 보인다"가 된다.
 */
export function eventLabel(event: string): string {
  return (EVENT_LABELS as Record<string, string | undefined>)[event] ?? event;
}

export function isKnownEvent(event: string): event is EventType {
  return (EVENT_TYPES as readonly string[]).includes(event);
}

// ─────────────────────────── 응답 모양 ───────────────────────────

export interface EventRow {
  id: string;
  event: string;
  userId: string;
  nickname?: string | null;
  occurredAt: string;
  props?: unknown;
}

export interface EventPage {
  items?: unknown;
  total?: number;
  limit?: number;
  offset?: number;
}

/** 퍼널 단계 7개 — 화면 컬럼 순서이자 "어디까지 갔나"의 순서다(왼→오 = 여정 진행). */
export const FUNNEL_STAGES = [
  "signup",
  "tutorial",
  "deck",
  "gacha",
  "practice",
  "league",
  "away",
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export const FUNNEL_LABELS: Record<FunnelStage, string> = {
  signup: "가입",
  tutorial: "튜토리얼",
  deck: "덱",
  gacha: "뽑기",
  practice: "연습",
  league: "리그",
  away: "원정",
};

export interface FunnelUser {
  userId: string;
  nickname?: string | null;
  firstSeenAt?: string | null;
  lastSeenAt?: string | null;
  reached?: unknown;
  matchesFinished?: number;
  eventCount?: number;
}

export interface FunnelResponse {
  generatedAt?: string;
  users?: unknown;
}

/** 화면이 실제로 그리는 한 행 — 결측이 전부 메워진 형태. */
export interface FunnelRow {
  userId: string;
  nickname: string;
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  /** 7단계 전부 채워진 boolean 맵. 서버가 일부만 줘도 나머지는 false(fail-closed). */
  reached: Record<FunnelStage, boolean>;
  matchesFinished: number;
  eventCount: number;
}

// ─────────────────────────── 배열 가드 ───────────────────────────

/**
 * 배열이 아닌 응답(구 서버·목의 `{}`)에 `.map` 을 걸면 화면이 통째로 흰 화면이 된다.
 * `logs/LogsPage.tsx` 의 `asList<T>()` 와 같은 역할 — apps/web 전역 규율(모듈 CLAUDE.md).
 */
export function asList<T>(value: unknown): T[] {
  return Array.isArray(value) ? (value as T[]) : [];
}

// ─────────────────────────── 필터 → 쿼리스트링 ───────────────────────────

/** 서버 기본 limit (#492 D3). */
export const EVENT_PAGE_SIZE = 50;
/** 서버 상한 (#492 D3) — 넘겨 보내면 서버가 거부하거나 조용히 깎는다. 여기서 먼저 막는다. */
export const EVENT_LIMIT_MAX = 200;

export interface EventFilter {
  /** "" = 종류 전체. */
  event: EventType | "";
  /** "" = 유저 전체. */
  userId: string;
  limit: number;
  offset: number;
}

export const DEFAULT_EVENT_FILTER: EventFilter = {
  event: "",
  userId: "",
  limit: EVENT_PAGE_SIZE,
  offset: 0,
};

function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return EVENT_PAGE_SIZE;
  return Math.max(1, Math.min(EVENT_LIMIT_MAX, Math.trunc(limit)));
}

/**
 * 필터 → `GET /api/admin/events` 쿼리스트링. 순수·결정론(같은 입력 = 같은 문자열).
 *
 * - 빈 `event`/`userId` 는 **파라미터를 아예 보내지 않는다**(빈 문자열을 보내면 서버가
 *   "빈 이벤트명" 필터로 읽어 400 이 될 수 있다 — 미지 event 는 400 이 계약이다).
 * - `limit` 은 1..200 으로 클램프, `offset` 은 음수를 0 으로.
 * - 키 순서는 `event,userId,limit,offset` 고정 — 쿼리키·캐시가 순서로 갈리지 않게.
 */
export function eventQuery(filter: EventFilter): string {
  const params = new URLSearchParams();
  if (filter.event) params.set("event", filter.event);
  if (filter.userId.trim()) params.set("userId", filter.userId.trim());
  params.set("limit", String(clampLimit(filter.limit)));
  params.set("offset", String(Math.max(0, Math.trunc(filter.offset) || 0)));
  return `?${params.toString()}`;
}

/** 종류 변경 — **offset 을 0 으로 되돌린다**(3페이지에서 필터를 바꾸면 빈 화면이 뜬다). */
export function setEventFilterEvent(filter: EventFilter, event: EventType | ""): EventFilter {
  return { ...filter, event, offset: 0 };
}

/** 유저 변경 — 같은 이유로 offset 리셋. 퍼널 행 클릭이 이 경로를 탄다. */
export function setEventFilterUser(filter: EventFilter, userId: string): EventFilter {
  return { ...filter, userId, offset: 0 };
}

export function setEventFilterOffset(filter: EventFilter, offset: number): EventFilter {
  return { ...filter, offset: Math.max(0, Math.trunc(offset) || 0) };
}

// ─────────────────────────── 페이저 ───────────────────────────

export interface PagerView {
  /** 1-based 현재 페이지. */
  page: number;
  /** 전체 페이지 수(최소 1 — 0건이어도 "1 / 1"). */
  pages: number;
  canPrev: boolean;
  canNext: boolean;
  prevOffset: number;
  nextOffset: number;
  /** "1–50 / 137" (0건이면 "0 / 0"). */
  rangeLabel: string;
}

/**
 * 서버가 준 `total/limit/offset` 으로 페이저를 계산한다.
 *
 * ⚠️ **클라가 total 을 추측하지 않는다** — 받은 items 길이로 "다음이 있나"를 판단하면
 * 마지막 페이지가 정확히 꽉 찼을 때 빈 페이지로 넘어간다.
 */
export function pagerView(total: number, limit: number, offset: number, shown: number): PagerView {
  const lim = clampLimit(limit);
  const off = Math.max(0, Math.trunc(offset) || 0);
  const tot = Math.max(0, Math.trunc(total) || 0);
  const pages = Math.max(1, Math.ceil(tot / lim));
  const page = Math.min(pages, Math.floor(off / lim) + 1);
  const from = tot === 0 ? 0 : off + 1;
  const to = tot === 0 ? 0 : off + shown;
  return {
    page,
    pages,
    canPrev: off > 0,
    canNext: off + lim < tot,
    prevOffset: Math.max(0, off - lim),
    nextOffset: off + lim,
    rangeLabel: tot === 0 ? "0 / 0" : `${from}–${to} / ${tot}`,
  };
}

// ─────────────────────────── props 요약 ───────────────────────────

/**
 * 표에 먼저 보여줄 키 순서. **서버 JSON 의 키 순서에 기대지 않기 위해** 있다 —
 * 기대면 같은 이벤트가 행마다 다른 순서로 요약돼 눈으로 비교할 수 없다.
 * 목록에 없는 키는 뒤에 사전순으로 붙는다(=새 prop 이 조용히 사라지지 않는다).
 */
export const PROP_KEY_PRIORITY: readonly string[] = [
  "mode",
  "result",
  "goalsFor",
  "goalsAgainst",
  "pointsAwarded",
  "kind",
  "count",
  "cost",
  "currency",
  "grades",
  "formation",
  "slotCount",
  "source",
  "provider",
  "nickname",
  "seasonNo",
  "division",
];

export function formatPropValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (Array.isArray(value)) return value.map(formatPropValue).join("/");
  if (typeof value === "object") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

/**
 * `props` 를 표 셀 한 줄로 요약한다.
 *
 * - 계약상 **객체**로 오지만, 문자열(JSON)로 오는 구 서버도 삼킨다 — 파싱 실패는 원문 그대로.
 *   (이 관용은 방어이지 계약이 아니다. 서버가 문자열을 주기 시작하면 그건 회귀다.)
 * - `null`/`undefined`/`""` 값 키는 뺀다(빈 칸이 줄을 잡아먹는다).
 * - `max` 개까지만 보이고 나머지는 `+N`.
 */
export function summarizeProps(props: unknown, max = 4): string {
  let obj = props;
  if (typeof obj === "string") {
    const s = obj.trim();
    if (s === "") return "";
    try {
      obj = JSON.parse(s);
    } catch {
      return s;
    }
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return "";

  const entries = Object.entries(obj as Record<string, unknown>).filter(
    ([, v]) => v !== null && v !== undefined && v !== "",
  );
  entries.sort(([a], [b]) => {
    const ia = PROP_KEY_PRIORITY.indexOf(a);
    const ib = PROP_KEY_PRIORITY.indexOf(b);
    const ra = ia === -1 ? PROP_KEY_PRIORITY.length : ia;
    const rb = ib === -1 ? PROP_KEY_PRIORITY.length : ib;
    if (ra !== rb) return ra - rb;
    return a < b ? -1 : a > b ? 1 : 0;
  });

  const shown = entries.slice(0, max).map(([k, v]) => `${k}=${formatPropValue(v)}`);
  const rest = entries.length - shown.length;
  return rest > 0 ? `${shown.join(" · ")} +${rest}` : shown.join(" · ");
}

/** 매치 이벤트의 모드(연습/리그/원정) — 없으면 null. 스트림 행의 모드 뱃지가 쓴다. */
export function modeOf(props: unknown): string | null {
  if (!props || typeof props !== "object" || Array.isArray(props)) return null;
  const m = (props as Record<string, unknown>).mode;
  return typeof m === "string" && m !== "" ? m : null;
}

// ─────────────────────────── 퍼널 파생 ───────────────────────────

function bool(v: unknown): boolean {
  return v === true;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * 서버 퍼널 응답 → 화면 행.
 *
 * ⚠️ **다시 정렬하지 않는다.** 정렬(`lastSeenAt DESC`)은 서버 계약이고, 클라가 한 번 더 정렬하면
 * 서버 정렬이 깨져도 화면이 멀쩡해 보여 회귀를 못 잡는다(#262 계열 규율 — 서버 규칙을 클라에 복제 금지).
 * 여기서 하는 일은 **결측 메우기와 형태 방어**뿐이다.
 *
 * - `reached` 가 통째로 없거나 객체가 아니면 7단계 전부 false(fail-closed).
 * - `userId` 가 문자열이 아닌 행은 버린다 — 키가 없으면 행 클릭 필터가 성립하지 않는다.
 */
export function funnelRows(res: FunnelResponse | undefined | null): FunnelRow[] {
  return asList<FunnelUser>(res?.users)
    .filter((u) => typeof u?.userId === "string" && u.userId !== "")
    .map((u) => {
      const raw =
        u.reached && typeof u.reached === "object" && !Array.isArray(u.reached)
          ? (u.reached as Record<string, unknown>)
          : {};
      const reached = {} as Record<FunnelStage, boolean>;
      for (const stage of FUNNEL_STAGES) reached[stage] = bool(raw[stage]);
      return {
        userId: u.userId,
        nickname: str(u.nickname) ?? u.userId,
        firstSeenAt: str(u.firstSeenAt),
        lastSeenAt: str(u.lastSeenAt),
        reached,
        matchesFinished: num(u.matchesFinished),
        eventCount: num(u.eventCount),
      };
    });
}

/** 도달한 단계 수(0..7) — 진행 막대의 분자. */
export function reachedCount(row: Pick<FunnelRow, "reached">): number {
  return FUNNEL_STAGES.filter((s) => row.reached[s]).length;
}

/**
 * "어디까지 갔나" — **단계 순서상 가장 뒤에 도달한 단계**.
 *
 * ⚠️ 연속 도달을 가정하지 않는다(뽑기를 건너뛰고 연습을 한 유저가 실제로 나온다).
 * 첫 미도달에서 끊으면 그 유저가 연습까지 간 사실이 화면에서 사라진다.
 */
export function furthestStage(row: Pick<FunnelRow, "reached">): FunnelStage | null {
  for (let i = FUNNEL_STAGES.length - 1; i >= 0; i -= 1) {
    const stage = FUNNEL_STAGES[i]!;
    if (row.reached[stage]) return stage;
  }
  return null;
}

/** 표 셀 한 줄 — "원정까지" / "기록 없음". 심사위원 진척을 한눈에 읽는 자리. */
export function furthestLabel(row: Pick<FunnelRow, "reached">): string {
  const stage = furthestStage(row);
  return stage ? `${FUNNEL_LABELS[stage]}까지` : "기록 없음";
}

/**
 * 유저 필터 드롭다운 옵션. 퍼널에 없는 userId 가 현재 선택돼 있으면(스트림에만 있는 유저)
 * **그 값을 잃지 않도록** 맨 뒤에 덧붙인다 — 안 그러면 select 가 값을 못 찾아 필터가 조용히 풀린다.
 */
export function userOptions(
  rows: readonly FunnelRow[],
  selected: string,
): { userId: string; label: string }[] {
  const opts = rows.map((r) => ({
    userId: r.userId,
    label: r.nickname === r.userId ? r.userId : `${r.nickname} (${r.userId})`,
  }));
  if (selected && !opts.some((o) => o.userId === selected)) {
    opts.push({ userId: selected, label: selected });
  }
  return opts;
}
