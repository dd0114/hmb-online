/**
 * 선수명 **단일 초크포인트** (#406 요구 6 — 전역 한글화의 실제 작업 형태).
 *
 * <p>여기가 생기기 전엔 `playersById.get(id)?.name ?? id` 가 **8개 파일에 각자** 선언돼 있었다.
 * 규칙(무엇을 우선하나 · 못 찾으면 뭘 보여주나 · 짧은 이름을 어디에 쓰나)이 화면마다 따로
 * 살아 있으면, 이름 정책을 한 번 바꿀 때 여덟 곳을 같이 고쳐야 하고 하나를 빠뜨리면
 * **그 화면만** 옛 규칙으로 남는다(#285 `icon-policy` 가 등급 판정으로 겪은 것과 같은 축).
 *
 * <h3>두 축 — 어디에 무엇을 쓰나</h3>
 * <ul>
 *   <li><b>짧은 이름</b>(`short`) = <b>밀집 UI</b>. 덱 리스트 행 · 전술보드 슬롯 · 경기 토큰 ·
 *       <b>로그줄</b>. 폭이 고정이거나 한 줄에 여러 조각이 같이 앉는 자리다.</li>
 *   <li><b>풀네임</b>(`full`) = <b>넓은 자리</b>. 카드 상세 · 상대 분석 표 · 프롬프트/지시 헤더 ·
 *       결과·스냅샷 목록 · 오류 메시지처럼 한 줄을 통째로 쓰는 자리.</li>
 * </ul>
 * 판단 기준은 "이름 옆에 다른 조각이 같이 앉는가"다. 같이 앉으면 짧은 이름.
 *
 * <h3>폴백 사다리 (계약 = `player-names.test.ts`)</h3>
 * <ol>
 *   <li><b>카탈로그</b>(`GET /api/players`, playerId 조인) — SoT. 이름을 고치면 여기부터 바뀐다.</li>
 *   <li><b>호출부가 준 이름</b>(`given`) — 서버 응답·스냅샷이 같이 실어 보낸 값. 과거 매치의
 *       `select_data_json` 에는 <b>옛 영어 이름이 박제</b>돼 있으므로(라이브 152/152) 이건
 *       <b>2순위</b>다. 카탈로그가 아는 선수면 카탈로그 이름이 이긴다 — W0 결정
 *       ("저장을 고치지 않고 조회 시 덮는다")이 web 쪽에서 뜻하는 바가 정확히 이 우선순위다.</li>
 *   <li><b>{@link UNKNOWN_PLAYER_NAME}</b> — <b>playerId 를 절대 화면에 내보내지 않는다</b>.
 *       `P077` 이 이름 자리에 뜬 실적이 있다(#334 는 로그 등번호에서 같은 사고를 겪었다).</li>
 * </ol>
 *
 * <h3>⚠️ 짧은 이름 축은 <b>지금 전 사이트에서 폴백(=풀네임)으로 돌고 있다</b></h3>
 * 발행물(`data/players/players.v2.5.json`)에는 182/182 명의 `shortName` 이 실려 있다. 그런데
 * <b>서버가 그 값을 실어 나르지 않는다</b> — 확인한 결손이 넷이다:
 * <ol>
 *   <li>`players` 테이블에 <b>`short_name` 컬럼이 없다</b>(V1 이후 어떤 마이그레이션도 추가하지 않았다)</li>
 *   <li>시드 임포트 upsert 가 그 값을 쓰지 않는다</li>
 *   <li>`CatalogPlayer` DTO 에 필드가 없다</li>
 *   <li>`docs/plan-v2/api/openapi.yaml` 의 `CatalogPlayer` 스키마에도 없다(그래서 생성물
 *       `schema.d.ts` 에도 없다 — 그 파일은 생성물이라 손으로 고치지 않는다)</li>
 * </ol>
 * <b>네 가지 전부 서버 쪽 작업이고 #411 에 요청해 뒀다.</b> 넷이 들어오면 web 은 손댈 곳이 없다 —
 * 카탈로그 행을 <b>관용적으로</b>(구조 판정, {@link nameEntryOf}) 읽으므로 값이 실려 오는 순간
 * 짧은 축이 살아난다. <b>그 전까지는 발행물 버전(파일 포인터)만 올려도 풀네임만 도착한다</b>
 * — 여기 한때 *"스위치가 켜지면 코드 변경 없이 짧은 이름이 살아난다"* 고 적혀 있었는데, 그 말은
 * <b>web 안에서만 참</b>이었다. 밀집 UI 가 지금 풀네임을 그리고 있는 것은 결함이 아니라
 * <b>설계된 폴백</b>이다(계약 = `player-names.test.ts` "#411 스위치 전 무회귀").
 */
import { useMemo } from "react";
import { usePlayers } from "../api/hooks";

/** 이름을 어디서도 못 찾았을 때 — id 대신 이걸 보여준다. */
export const UNKNOWN_PLAYER_NAME = "미상 선수";

export type NameAxis = "full" | "short";
/** 사다리 어디서 왔나. 호출부가 "이름을 못 찾았다"를 분기해야 할 때 쓴다(로그줄이 그렇다). */
export type NameSource = "catalog" | "given" | "unknown";

export interface PlayerNameEntry {
  /** 넓은 자리용 풀네임. */
  full: string;
  /** 밀집 UI 용 짧은 이름. 발행물에 없으면 `full` 과 같다. */
  short: string;
}

export interface ResolvedPlayerName {
  text: string;
  source: NameSource;
}

/**
 * 카탈로그 id 로 읽히는 문자열인가 — `P077`(카탈로그) · `H9`/`A11`(엔진 픽스처).
 *
 * <p>사다리 2단(`given`)에 이게 들어오면 <b>버린다</b>. 호출부가 옛 습관대로 `?? playerId` 를
 * 넘겨도 화면에 id 가 새지 않게 하는 백스톱이다 — 그 습관이 정확히 이 초크포인트가 없앤 것이다.
 */
export function looksLikePlayerId(value: string): boolean {
  return /^[A-Za-z]{1,2}\d{1,4}$/.test(value.trim());
}

function cleaned(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * 카탈로그 행 → 두 축. **구조 판정**이라 `shortName` 을 모르는 타입(현행 openapi 생성물)에서도
 * 값이 실려 오면 읽는다. 이름이 없는 행은 표에 넣지 않는다(빈 문자열이 이름 행세를 하면
 * 사다리 2·3단이 통째로 죽는다).
 */
export function nameEntryOf(row: unknown): PlayerNameEntry | null {
  if (!row || typeof row !== "object") return null;
  const r = row as { name?: unknown; shortName?: unknown };
  const full = cleaned(r.name);
  if (!full) return null;
  return { full, short: cleaned(r.shortName) ?? full };
}

/**
 * **행을 이미 손에 든 경우**의 창구 — 조회 없이 두 축 + 사다리만 적용한다.
 *
 * <p>전술보드 토큰처럼 부품이 `CatalogPlayer` 를 프롭으로 이미 받는 자리에서 쓴다. 여기가 없으면
 * 그런 자리는 `player?.name ?? playerId` 로 되돌아간다 — 초크포인트가 <b>id 조회 경로만</b>
 * 덮으면 절반만 막은 것이다.
 *
 * <p>⚠️ 이 부품들은 API 훅을 쓰지 않는 **프레젠테이션 컴포넌트**다(테스트가 Provider 없이
 * 단독 렌더한다). 그래서 훅이 아니라 순수 함수여야 한다.
 */
export function playerNameOf(
  row: unknown,
  axis: NameAxis = "full",
  given?: string | null,
): string {
  const entry = nameEntryOf(row);
  if (entry) return axis === "short" ? entry.short : entry.full;
  const fallback = cleaned(given);
  if (fallback && !looksLikePlayerId(fallback)) return fallback;
  return UNKNOWN_PLAYER_NAME;
}

export interface PlayerNameBook {
  /** 표에 들어간 선수 수 — 0 이면 카탈로그가 아직/영영 없다는 뜻(테스트·진단용). */
  readonly size: number;
  /** 카탈로그가 이 선수를 아는가. */
  has(playerId: string | null | undefined): boolean;
  entry(playerId: string | null | undefined): PlayerNameEntry | null;
  /** 사다리 전체를 돌려준다(출처 포함). */
  resolve(
    playerId: string | null | undefined,
    axis?: NameAxis,
    given?: string | null,
  ): ResolvedPlayerName;
  /** 넓은 자리 — 풀네임. */
  full(playerId: string | null | undefined, given?: string | null): string;
  /** 밀집 UI — 짧은 이름. */
  short(playerId: string | null | undefined, given?: string | null): string;
}

/** 카탈로그 소스 정규화 — 배열(`/api/players`) 이든 `playersById` Map 이든 같은 표를 만든다. */
function rowsOf(source: unknown): Array<[string | null, unknown]> {
  if (Array.isArray(source)) {
    return source.map((row) => [cleaned((row as { id?: unknown } | null)?.id), row]);
  }
  if (source instanceof Map) {
    return [...source.entries()].map(([id, row]) => [cleaned(id) ?? cleaned((row as { id?: unknown } | null)?.id), row]);
  }
  return [];
}

/**
 * 순수 판정 — 카탈로그(배열 또는 `playersById` Map)에서 이름표를 만든다.
 *
 * <p>Map 도 받는 이유: 화면들이 이미 `playersById` 를 들고 있고, 그걸 못 받으면 훅을 쓸 수 없는
 * 프레젠테이션 컴포넌트가 초크포인트 밖으로 나간다.
 *
 * <p>⚠️ `/api/players` 가 배열이 아닐 수 있다(구 서버·목의 `{}`) — `apps/web/CLAUDE.md` §285 가
 * 같은 가드를 요구한다. 여기서 막지 않으면 이름 하나 때문에 화면이 통째로 흰색이 된다.
 */
/**
 * 같은 카탈로그 배열이면 같은 이름표를 돌려준다.
 *
 * <p>초크포인트를 <b>프롭 드릴링 없이</b> 쓰게 하려는 캐시다. 전술보드 토큰처럼 화면 하나에
 * 18개가 뜨는 부품이 각자 `usePlayerNames()` 를 부르면, 캐시가 없을 땐 렌더마다 182행 표를
 * 18번 다시 만든다. 그러면 "이름은 초크포인트로만"이 성능을 이유로 우회당한다.
 * 키가 배열 참조라 react-query 캐시가 갱신되면(새 배열) 자동으로 새 표가 만들어진다.
 */
const BOOK_CACHE = new WeakMap<object, PlayerNameBook>();

export function buildPlayerNames(rows: unknown): PlayerNameBook {
  const cached = typeof rows === "object" && rows !== null ? BOOK_CACHE.get(rows) : undefined;
  if (cached) return cached;
  const map = new Map<string, PlayerNameEntry>();
  for (const [id, row] of rowsOf(rows)) {
    const entry = nameEntryOf(row);
    if (id && entry && !map.has(id)) map.set(id, entry);
  }

  const entry = (playerId: string | null | undefined): PlayerNameEntry | null => {
    const id = cleaned(playerId);
    return id ? (map.get(id) ?? null) : null;
  };

  const resolve = (
    playerId: string | null | undefined,
    axis: NameAxis = "full",
    given?: string | null,
  ): ResolvedPlayerName => {
    const hit = entry(playerId);
    if (hit) return { text: axis === "short" ? hit.short : hit.full, source: "catalog" };
    const fallback = cleaned(given);
    // 스냅샷 이름은 카탈로그가 모르는 선수에게만 쓴다(사다리 2단). id 를 이름으로 넘긴 호출부는
    // 여기서 걸러 3단으로 보낸다 — 화면에 `P077` 이 뜨지 않게 하는 것이 이 사다리의 목적이다.
    if (fallback && fallback !== cleaned(playerId) && !looksLikePlayerId(fallback)) {
      return { text: fallback, source: "given" };
    }
    return { text: UNKNOWN_PLAYER_NAME, source: "unknown" };
  };

  const book: PlayerNameBook = {
    size: map.size,
    has: (playerId) => entry(playerId) !== null,
    entry,
    resolve,
    full: (playerId, given) => resolve(playerId, "full", given).text,
    short: (playerId, given) => resolve(playerId, "short", given).text,
  };
  if (typeof rows === "object" && rows !== null) BOOK_CACHE.set(rows, book);
  return book;
}

/**
 * 화면용 창구 — `GET /api/players` 를 소비해 이름표를 만든다.
 *
 * <p>react-query 캐시라 화면마다 불러도 요청이 늘지 않는다. 이름 이외의 정보(포지션·등급·능력치)가
 * 필요하면 기존 `playersById` 를 그대로 쓰되 <b>이름만</b> 이 창구로 물어라.
 */
export function usePlayerNames(): PlayerNameBook {
  const { data } = usePlayers();
  return useMemo(() => buildPlayerNames(data), [data]);
}
