/**
 * 공지 팝업의 **순수 판정 로직** (#248 W2). 렌더에서 분리해 계약으로 박제한다.
 *
 * ⚠️ **활성 판정은 서버가 한다.** `GET /api/notices/active` 는 이미 기간(`startsAt`/`endsAt`)·
 * 운영 스위치(`active`)·삭제(`deleted_at`)로 걸러 **정렬까지 마친 목록**을 준다. 여기서 다시
 * `startsAt <= now` 같은 걸 계산하면 **기기 시계가 진실이 된다** — 폰 시계가 하루 빠른 유저에게
 * 점검 공지가 안 뜬다. 규칙이 바뀔 때 조용히 어긋나기도 한다(`locked`/`abandonable` 을 서버가
 * 판정하는 #217 원칙과 같다). 이 모듈이 쓰는 시각은 **오직 로컬 억제 만료**뿐이다.
 *
 * ⚠️ **응답 형태를 믿지 않는다.** 이 엔드포인트가 없는 구 서버·프록시가 200 `{}` 를 주면
 * `data.notices.length` 가 예외를 던져 **로비 전체가 흰 화면**이 된다(#245 가 같은 회귀 계약을
 * 갖고 있다). 부가 기능 하나가 앱 진입점을 죽이는 건 허용되지 않는다.
 */

export interface Notice {
  id: string;
  /** 제목·본문이 바뀔 때만 서버가 +1 한다 — 억제 키의 일부(수정본 재표시의 열쇠). */
  revision: number;
  title: string;
  body: string;
  startsAt?: string | null;
  endsAt?: string | null;
  priority?: number;
}

export interface ActiveNoticesResponse {
  notices: Notice[];
}

/** [닫기] — 이 **탭 세션** 동안만 억제. 로비는 덱·상점에서 계속 돌아오는 화면이라 인메모리면 매번 뜬다. */
export const NOTICE_CLOSED_KEY = "hmb.notice.closed.v1";
/** [24시간 동안 안 보기] — 만료 epoch(ms) 를 기기에 저장. */
export const NOTICE_DISMISSED_KEY = "hmb.notice.dismissed.v1";
export const NOTICE_DISMISS_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * 억제 키 = `id@revision`.
 *
 * `id` 만 쓰면 **오탈자를 고쳐도 24시간 억제한 유저는 수정본을 못 본다**. 반대로 `updatedAt` 을
 * 쓰면 노출 토글·우선순위 조정 같은 내용 무관 변경에도 전원 재표시가 된다. 그래서 서버가
 * **제목·본문이 실제로 바뀔 때만** 올리는 `revision` 을 키에 넣는다.
 */
export function noticeSuppressionKey(n: { id: string; revision: number }): string {
  return `${n.id}@${n.revision}`;
}

/**
 * 카드 상단 메타 문구 — "2026-07-29 게시 · 07-31 까지"(목업 A/B).
 *
 * ⚠️ 이건 **표시**일 뿐 판정이 아니다. 여기 뜬 기간이 지났는지 여부로 공지를 걸러내면
 * 서버 판정을 클라가 재계산하는 셈이 된다 — 그 판단은 `visibleNotices` 도 하지 않는다.
 * 시각이 파싱되지 않으면 그 조각을 조용히 뺀다(깨진 문자열을 화면에 흘리지 않는다).
 */
export function noticeMetaText(n: Pick<Notice, "startsAt" | "endsAt">): string {
  const parts: string[] = [];
  const at = (iso: string | null | undefined) => {
    if (!iso) return null;
    const t = Date.parse(iso);
    return Number.isNaN(t) ? null : new Date(t);
  };
  const p = (v: number) => String(v).padStart(2, "0");
  const start = at(n.startsAt);
  if (start) parts.push(`${start.getFullYear()}-${p(start.getMonth() + 1)}-${p(start.getDate())} 게시`);
  const end = at(n.endsAt);
  if (end) parts.push(`${p(end.getMonth() + 1)}-${p(end.getDate())} 까지`);
  return parts.join(" · ");
}

export interface NoticeStores {
  session: Storage | null;
  local: Storage | null;
}

/**
 * 기본 저장소. Safari 프라이빗·iframe 정책에서 접근 자체가 throw 하므로 여기서 흡수한다 —
 * 저장소를 못 쓰는 브라우저에서는 억제가 안 될 뿐, 공지는 계속 보인다.
 */
export function defaultNoticeStores(): NoticeStores {
  const pick = (get: () => Storage): Storage | null => {
    try {
      return get();
    } catch {
      return null;
    }
  };
  if (typeof window === "undefined") return { session: null, local: null };
  return { session: pick(() => window.sessionStorage), local: pick(() => window.localStorage) };
}

function readJson(storage: Storage | null, key: string): unknown {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    // 손상된 JSON·접근 거부 — **조용히 무시하고 표시한다**. 저장소 오염이 공지를 영구히
    // 못 보게 만드는 것이 못 억제하는 것보다 나쁘다.
    return null;
  }
}

function writeJson(storage: Storage | null, key: string, value: unknown): void {
  if (!storage) return;
  try {
    storage.setItem(key, JSON.stringify(value));
  } catch {
    // 용량 초과·프라이빗 모드 — 억제가 저장되지 않을 뿐, 화면은 정상 동작한다.
  }
}

/** 이 세션에서 [닫기] 로 처리한 키 집합. 깨진 값은 빈 집합으로 흡수. */
export function readClosedKeys(storage: Storage | null): Set<string> {
  const raw = readJson(storage, NOTICE_CLOSED_KEY);
  if (!Array.isArray(raw)) return new Set();
  return new Set(raw.filter((v): v is string => typeof v === "string"));
}

/**
 * [24시간 안 보기] 기록 — **읽을 때 만료분을 청소**한다(무한 증가 방지).
 *
 * ⚠️ localStorage 는 유저별이 아니다 — 같은 브라우저에서 계정을 바꾸면 억제가 공유된다.
 * 공지는 전체 브로드캐스트라 내용이 같으므로 실해는 없다(서버 "읽음" 테이블을 두지 않는 이유).
 */
export function readDismissedMap(storage: Storage | null, now: number): Record<string, number> {
  const raw = readJson(storage, NOTICE_DISMISSED_KEY);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value === "number" && Number.isFinite(value) && value > now) out[key] = value;
  }
  return out;
}

/**
 * 억제 저장소는 **React 상태 밖의 공유 가변 상태**다 — 쓰는 쪽(팝업)과 읽는 쪽(헤더의 안 읽음
 * 점)이 서로 다른 컴포넌트다. 변경 신호가 없으면 팝업에서 공지를 닫아도 헤더의 점은 그대로
 * 남는다(실제로 e2e 가 잡았다). 그래서 쓰기 함수가 **한 곳에서** 버전을 올리고, 읽는 쪽은
 * `useSyncExternalStore` 로 구독한다.
 *
 * ⚠️ 새 쓰기 함수를 추가하면 `bumpSuppression()` 도 같이 불러라 — 안 부르면 그 경로만 조용히
 * 화면과 어긋난다.
 */
let suppressionVersion = 0;
const suppressionListeners = new Set<() => void>();

function bumpSuppression(): void {
  suppressionVersion += 1;
  for (const listener of suppressionListeners) listener();
}

/** 현재 억제 상태의 버전(값 자체에 의미는 없다 — 바뀌었다는 사실만 쓴다). */
export function noticeSuppressionVersion(): number {
  return suppressionVersion;
}

export function subscribeNoticeSuppression(listener: () => void): () => void {
  suppressionListeners.add(listener);
  return () => void suppressionListeners.delete(listener);
}

export function markNoticeClosed(stores: NoticeStores, key: string): void {
  const next = readClosedKeys(stores.session);
  next.add(key);
  writeJson(stores.session, NOTICE_CLOSED_KEY, [...next]);
  bumpSuppression();
}

/** 만료 시각을 기록하면서 이미 만료된 항목을 함께 정리한다. */
export function markNoticeDismissed(stores: NoticeStores, key: string, now: number): number {
  const expiresAt = now + NOTICE_DISMISS_WINDOW_MS;
  const next = { ...readDismissedMap(stores.local, now), [key]: expiresAt };
  writeJson(stores.local, NOTICE_DISMISSED_KEY, next);
  bumpSuppression();
  return expiresAt;
}

/**
 * 응답 → 화면이 쓸 수 있는 목록. **모양이 아니면 빈 배열**(팝업만 안 뜨고 로비는 산다).
 *
 * 서버 정렬(`priority DESC, startsAt DESC, id DESC`)을 **그대로 보존**한다 — 여기서 다시 정렬하면
 * 규칙이 두 곳에 생긴다.
 */
export function normalizeNotices(raw: unknown): Notice[] {
  if (!raw || typeof raw !== "object") return [];
  const list = (raw as { notices?: unknown }).notices;
  if (!Array.isArray(list)) return [];
  const out: Notice[] = [];
  for (const item of list) {
    const n = normalizeNotice(item);
    if (n) out.push(n);
  }
  return out;
}

/**
 * **공지 한 건**의 정규화 — 목록(`normalizeNotices`)과 단건 조회(`GET /api/notices/{id}`, #297)가
 * 같은 함수를 쓴다. 모양이 아니면 `null`.
 *
 * ⚠️ 단건 경로를 위해 따로 파싱하지 마라 — 두 곳에 규칙이 생기면 "목록에선 보이는데 딥링크로는
 * 안 보인다"(혹은 그 반대)로 조용히 갈린다. 그리고 **모양을 믿지 않는 것**이 여기 존재 이유다:
 * 200 `{}` 하나가 화면을 통째로 흰 화면으로 만드는 부류(#274)를 이 경계에서 흡수한다.
 */
export function normalizeNotice(item: unknown): Notice | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const n = item as Record<string, unknown>;
  const id = typeof n.id === "string" ? n.id.trim() : "";
  if (!id) return null;
  const title = typeof n.title === "string" ? n.title : "";
  const body = typeof n.body === "string" ? n.body : "";
  if (!title && !body) return null; // 빈 모달을 띄우지 않는다
  return {
    id,
    // revision 이 빠진 응답(구 서버)은 1 로 본다 — 억제 키가 생기기만 하면 되고,
    // 여기서 공지를 숨기면 "안 뜨는 이유"를 아무도 못 찾는다.
    revision: typeof n.revision === "number" && Number.isFinite(n.revision) ? n.revision : 1,
    title,
    body,
    startsAt: typeof n.startsAt === "string" ? n.startsAt : null,
    endsAt: typeof n.endsAt === "string" ? n.endsAt : null,
    priority: typeof n.priority === "number" ? n.priority : 0,
  };
}

/**
 * 이번 진입에 보여줄 공지 목록 = 서버가 준 활성 목록 − (이 세션에서 닫은 것) − (24h 억제 중인 것).
 * 순서는 서버 순서 그대로.
 */
export function visibleNotices(
  raw: unknown,
  now: number,
  stores: NoticeStores = defaultNoticeStores(),
): Notice[] {
  const closed = readClosedKeys(stores.session);
  const dismissed = readDismissedMap(stores.local, now);
  return normalizeNotices(raw).filter((n) => {
    const key = noticeSuppressionKey(n);
    return !closed.has(key) && dismissed[key] === undefined;
  });
}

/**
 * 공지 목록(다시 보기) 화면이 쓰는 뷰.
 *
 * ⚠️ **억제는 팝업에만 적용된다.** `all` 은 서버가 준 활성 목록 **그대로**다 — [24시간 안 보기]를
 * 누른 공지도 여기엔 남는다. 그게 이 화면의 존재 이유다: 팝업은 한 번 닫으면 끝이고, 24시간
 * 억제 중에 노출 기간이 끝나면 **영영 못 본다**. "점검이 몇 시부터랬지?" 에 답할 곳이 필요하다.
 *
 * `unread` 는 **팝업이 아직 처리하지 않은 공지** = `visibleNotices` 와 정확히 같은 집합이다.
 * 같은 함수를 재사용하는 것이 계약이다 — 목록 쪽에서 따로 세면 "점은 켜져 있는데 팝업은 안 뜬다"
 * (혹은 그 반대)로 조용히 갈라진다.
 */
export interface NoticeCenterView {
  /** 목록에 보여줄 전체 활성 공지(억제 무시, 서버 순서 그대로). */
  all: Notice[];
  /** 아직 팝업으로 처리하지 않은 공지 — 안 읽음 점의 근거. */
  unread: Notice[];
  /** `unread` 의 억제 키 집합 — 행 단위 안 읽음 표시용. */
  unreadKeys: Set<string>;
}

export function noticeCenterView(
  raw: unknown,
  now: number,
  stores: NoticeStores = defaultNoticeStores(),
): NoticeCenterView {
  const all = normalizeNotices(raw);
  const unread = visibleNotices(raw, now, stores);
  return { all, unread, unreadKeys: new Set(unread.map(noticeSuppressionKey)) };
}
