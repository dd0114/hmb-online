/**
 * Thin fetch wrapper for the server-java API (docs/plan-v2/api/openapi.yaml).
 * - Injects `Authorization: Bearer <token>` from localStorage.
 * - Parses the shared `ApiError` envelope ({code, message, detail}) on non-2xx.
 * - On 401: clears the stored token and triggers the unauthorized handler
 *   (wired by App.tsx to a router redirect to /login; defaults to a hard redirect
 *   so the wrapper is still correct if used outside the React tree).
 */

import {
  reportBackendReachable,
  reportBackendUnreachable,
  setBackendProbe,
} from "./backend-health";

export const TOKEN_STORAGE_KEY = "hmb.auth.token";
/**
 * 로그인에 쓴 provider(guest|mock:google|mock:apple)를 클라에 보관 — /api/me 는 provider 를
 * 돌려주지 않으므로(V1 MeResponse 미포함) 로비 provider 뱃지는 로그인 시점 값에서 읽는다.
 * (서버가 me 에 provider 를 추가하면 그 쪽을 SoT 로 옮길 수 있다 — 이슈 레이즈 후보.)
 */
export const PROVIDER_STORAGE_KEY = "hmb.auth.provider";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function setToken(token: string): void {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
}

export function clearToken(): void {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
}

export function getProvider(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(PROVIDER_STORAGE_KEY);
}

export function setProvider(provider: string): void {
  window.localStorage.setItem(PROVIDER_STORAGE_KEY, provider);
}

export function clearProvider(): void {
  window.localStorage.removeItem(PROVIDER_STORAGE_KEY);
}

/** Mirrors components.schemas.ErrorCode in openapi.yaml. */
export type ErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "DECK_INVALID"
  | "INSUFFICIENT_POINTS"
  | "INVALID_STATE"
  | "SUBSTITUTION_INVALID"
  | "AI_JOB_FAILED"
  // Phase2 superset (openapi-v2 §ErrorCode) — added on the trade/league waves (v2.ts W0 note).
  | "TRADE_INVALID"
  | "LEAGUE_INVALID"
  // #217 매치 잠금 — 끝나지 않은 매치가 있어 이 요청을 받을 수 없다. detail={matchId,state,action}
  | "MATCH_IN_PROGRESS"
  | "INTERNAL_ERROR";

export interface ApiErrorBody {
  code: ErrorCode | string;
  message: string;
  detail?: Record<string, unknown> | null;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail: Record<string, unknown> | null;

  constructor(status: number, body: ApiErrorBody) {
    super(body.message);
    this.name = "ApiError";
    this.status = status;
    this.code = body.code;
    this.detail = body.detail ?? null;
  }
}

async function parseErrorBody(res: Response): Promise<ApiErrorBody> {
  try {
    const data = await res.json();
    if (data && typeof data.code === "string" && typeof data.message === "string") {
      return data as ApiErrorBody;
    }
  } catch {
    // response wasn't JSON (or was empty) — fall through to the generic error below
  }
  return { code: "INTERNAL_ERROR", message: res.statusText || `HTTP ${res.status}` };
}

/** Side effect run after a 401 is observed. Defaults to a hard redirect; App.tsx
 * overrides this with a router-based navigate so the SPA doesn't full-reload. */
let onUnauthorized: () => void = () => {
  if (typeof window !== "undefined" && window.location.pathname !== "/login") {
    window.location.assign("/login");
  }
};

export function setUnauthorizedHandler(handler: () => void): void {
  onUnauthorized = handler;
}

export interface ApiFetchOptions extends Omit<RequestInit, "body"> {
  /** Plain object body — JSON-serialized automatically. */
  body?: unknown;
}

/* ─────────────────────────── API base (PRD-v4 §G / P3-D1, 이슈 #129) ───────────────────────────
 * CF Pages 는 web 을 **정적**으로만 서빙한다 — /api 를 받아줄 서버가 그 오리진에 없다.
 * 그래서 배포 빌드는 `VITE_API_BASE` 로 Tunnel 백엔드 오리진(예: https://api.example.com)을
 * 주입하고, 모든 요청이 그리로 나간다. **빌드 타임 인라인**이므로 오리진이 바뀌면 재빌드가
 * 필요하다(docs/plan-v4/deploy.md §6.1 과 동일한 변수명·빌드 방식).
 *
 * 기본값 `""` = 지금까지와 **완전히 동일한 상대경로 동작**(vite dev proxy / 데모 8080 무회귀).
 * 적용 지점은 apiFetch **한 곳**뿐이다 — 호출부는 계속 "/api/..." 를 넘긴다.
 */

/* ─────────────────── 런타임 백엔드 config (에픽 #183, 접근 A) ───────────────────
 * 빌드타임 인라인만으로는 **터널이 죽는 순간 앱이 통째로 먹통**이 된다: quick tunnel 은 사망할
 * 때마다 새 URL 을 받는데(유휴 중에도 죽는다 — deploy-log 2026-07-22·07-25), 배포된 web 은
 * 죽은 주소를 계속 부른다. 그래서 배포 빌드는 `VITE_RUNTIME_CONFIG_URL`(=/config.json)을 켜고
 * 현재 백엔드 오리진을 **런타임에** 읽는다. 자가복구 워치독(infra/tunnel-heal.sh)이 터널을
 * 되살린 뒤 이 파일만 갱신하면 web 은 재빌드 없이 새 주소를 따라간다.
 *
 * 플래그가 없으면(dev·테스트·데모 8080) 추가 네트워크 호출 **0** — 기존 동작과 완전히 동일하다.
 * 빌드타임 `VITE_API_BASE` 는 config 를 못 읽었을 때의 폴백으로 계속 살아 있다.
 */

interface RuntimeConfig {
  apiBase?: unknown;
}

/** config 에서 읽어 온 오리진(런타임 승자). 미로드/실패면 null → 빌드타임 폴백. */
let runtimeBase: string | null = null;
/** 부팅 1회 로드 메모이즈 — 요청마다 config 를 다시 읽지 않는다. */
let runtimeLoad: Promise<void> | null = null;

/** 테스트 전용 상태 리셋(모듈 스코프 캐시 때문에 필요). */
export function __resetRuntimeConfig(): void {
  runtimeBase = null;
  runtimeLoad = null;
}

function runtimeConfigUrl(): string {
  const raw: unknown = import.meta.env?.VITE_RUNTIME_CONFIG_URL;
  return typeof raw === "string" ? raw.trim() : "";
}

function normalizeBase(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim().replace(/\/+$/, "");
  return trimmed || null; // "" 는 "지정 안 함"으로 본다 — 빌드타임 폴백을 지우지 않는다
}

/** config 조회 상한(ms). 이게 없으면 config 가 매달릴 때 **모든 API 호출이 같이 멈춘다**. */
const RUNTIME_CONFIG_TIMEOUT_MS = 3000;

/** config 를 읽어 오리진을 돌려준다. **절대 throw 하지 않는다**(config 장애가 앱을 죽이면 안 됨). */
async function fetchRuntimeConfig(bust: boolean): Promise<string | null> {
  const url = runtimeConfigUrl();
  if (!url) return null;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), RUNTIME_CONFIG_TIMEOUT_MS) : null;
  try {
    const target = bust ? `${url}${url.includes("?") ? "&" : "?"}t=${Date.now()}` : url;
    const res = await fetch(target, { cache: "no-store", signal: ctrl?.signal });
    if (!res.ok) return null;
    return normalizeBase((await res.json() as RuntimeConfig)?.apiBase);
  } catch {
    return null; // 오프라인·404·JSON 깨짐·타임아웃 — 전부 폴백으로 흡수
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 첫 API 호출 전에 한 번만 로드. 실패는 조용히 폴백. */
function ensureRuntimeConfig(): Promise<void> {
  if (!runtimeConfigUrl()) return Promise.resolve();
  runtimeLoad ??= fetchRuntimeConfig(false).then((base) => {
    if (base) runtimeBase = base;
  });
  return runtimeLoad;
}

/**
 * 네트워크 도달 실패 후 config 재조회(캐시버스팅). **주소가 실제로 바뀌었을 때만** true —
 * 같은 주소면 재시도해도 또 실패하므로 무한 루프를 막는다.
 */
async function refreshRuntimeConfig(): Promise<boolean> {
  const next = await fetchRuntimeConfig(true);
  if (!next || next === apiBase()) return false;
  runtimeBase = next;
  runtimeLoad = Promise.resolve();
  return true;
}

/* ─────────────────── 백엔드 도달 상태 프로브 (#477) ───────────────────
 * 점검 안내(MaintenanceGate)가 쓰는 헬스 프로브를 여기서 등록한다 — 도달 판정에 필요한
 * 지식(현재 base·런타임 config 재조회)이 전부 이 모듈에 있고, backend-health 는 fetch 를
 * 몰라야 순환 import 가 안 생긴다.
 *
 * ⚠️ 프로브는 **먼저 `/config.json` 을 다시 읽는다**. 터널이 죽고 새 주소로 살아났을 때
 * (quick tunnel 은 살아날 때마다 주소가 바뀐다 — #183) 옛 주소만 두드리면 복구를 영영 못 본다.
 *
 * 대상은 `/api/config` — 공개(세션 중립) 경로라 미로그인 상태에서도 안전하고, 401 이 와도
 * 세션을 건드리지 않는다(SESSION_NEUTRAL_PATHS).
 *
 * ⚠️ **단일 카나리아인 것은 의도다.** "엔드포인트 하나가 죽었는데 카나리아가 살아 있으면 점검
 * 화면이 안 뜬다"는 결함이 아니라 이 설계의 목적이다 — 부분 장애(그 화면만 에러)에 앱 전체를
 * 덮으면 멀쩡한 기능까지 못 쓰게 만든다. 이 화면이 대신하는 것은 **전면 장애**뿐이고, 개별
 * 요청 실패는 각 화면의 에러 처리가 계속 맡는다. 반대 방향(카나리아만 죽음)은 확인 프로브가
 * 실패하므로 점검으로 뜨는데, 그건 부트스트랩 config 를 못 받는 상태 = 실제로 앱이 못 뜬다.
 */
const HEALTH_PROBE_TIMEOUT_MS = 5000;
/** 이 상태코드는 "백엔드가 죽었다" 다 — 앱 버그가 아니라 게이트웨이가 오리진에 못 닿은 것. */
const GATEWAY_DOWN_STATUS = new Set([502, 503, 504]);

setBackendProbe(async () => {
  await refreshRuntimeConfig(); // 주소가 바뀌었으면 새 주소로 두드린다
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), HEALTH_PROBE_TIMEOUT_MS) : null;
  try {
    const res = await fetch(apiUrl("/api/config"), { cache: "no-store", signal: ctrl?.signal });
    return !GATEWAY_DOWN_STATUS.has(res.status);
  } catch {
    return false;
  } finally {
    if (timer) clearTimeout(timer);
  }
});

/** 끝 슬래시를 제거한 API base. 런타임 config > 빌드타임 값 > "". */
export function apiBase(): string {
  if (runtimeBase) return runtimeBase;
  const raw: unknown = import.meta.env?.VITE_API_BASE;
  return typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
}

/**
 * 호출부 경로("/api/me")에 base 를 붙인다.
 * 이미 절대 URL 이거나 base 가 없으면 그대로 — 중복 접두를 만들지 않는다.
 */
export function apiUrl(path: string): string {
  if (!path.startsWith("/")) return path; // 절대 URL(http…) 또는 상대 세그먼트 — 손대지 않는다
  const base = apiBase();
  return base ? `${base}${path}` : path;
}

/**
 * 인증 엔드포인트 접두 — 이 경로들의 401 은 **인증 실패**(잘못된 자격)이지 **세션 만료**가 아니다.
 * 자체 로그인(PRD-v4 §A) 도입으로 "오타 비번 = 일상적 401" 이 생겼기 때문에 구분이 필요하다.
 * 여기 걸리면 401 부수효과(토큰 클리어 + onUnauthorized 리다이렉트)를 건너뛰고 ApiError 만 던진다
 * — 유효 세션을 보유한 채 /login 에서 오답을 내도 기존 세션이 파기되지 않는다.
 * 그 외 모든 경로의 401 은 기존대로 세션 파기(회귀 테스트로 박제 — client.test.ts).
 */
const AUTH_PATH_PREFIX = "/api/auth/";

/**
 * **세션과 무관한 공개 경로** — 401 이 와도 세션을 파기하지 않는다 (#232).
 *
 * `/api/config`(재화 표기·상점 가격)는 유저 데이터가 0 이고 서버에서 인증 제외돼 있다. 그런데 이
 * 클라이언트는 "인증 경로가 아닌 401 = 세션 만료"로 해석해 **토큰을 지우고 로그인으로 보낸다** —
 * 프록시·CDN·미래 미들웨어가 이 경로에 401 을 끼우면, 유저 데이터와 아무 상관 없는 응답 하나가
 * 로그인된 유저를 튕겨내게 된다. 공개 경로는 그 판정에서 빼 둔다(에러는 그대로 던진다).
 *
 * `/api/notices/active`(#248)도 같은 처지다 — 유저 데이터 0 인 공개 조회이고, **점검 공지는
 * 로그인이 안 될 때 가장 필요하다**. 그 응답의 401 이 로그인된 유저의 토큰을 지우면 부가 기능
 * 하나가 세션을 파괴한다.
 */
const SESSION_NEUTRAL_PATHS = ["/api/config", "/api/notices/active"];

/** 상대/절대 URL 모두에서 pathname 을 뽑는다(API base 환경변수화 — P3-D1). */
function pathnameOf(path: string): string {
  const origin =
    typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";
  try {
    return new URL(path, origin).pathname;
  } catch {
    return path;
  }
}

/**
 * VITE_API_BASE 의 **경로 부분**("https://api.x/backend" → "/backend"). 오리진만이면 "".
 * base 가 서브패스를 포함하면 붙인 뒤의 pathname 이 "/backend/api/auth/login" 이 되어
 * 접두 판별이 조용히 깨진다 — 그래서 판별 전에 이 부분을 되벗긴다.
 */
function basePathname(): string {
  const base = apiBase();
  if (!base) return "";
  const p = pathnameOf(base);
  return p === "/" ? "" : p.replace(/\/+$/, "");
}

/**
 * 인증 엔드포인트 판별. base 적용 **전/후 어느 형태를 넘겨도** 같은 답이 나와야 한다
 * (상대경로 / 절대 URL / base 서브패스 포함) — 틀리면 로그인 오답 401 이 다시 전역 세션을
 * 파기한다. client.test.ts 가 4조합 전부 박제.
 */
export function isAuthEndpoint(path: string): boolean {
  const pathname = normalizedPathname(path);
  return pathname.startsWith(AUTH_PATH_PREFIX);
}

/** 공개(세션 중립) 경로 판별 — 401 부수효과(토큰 클리어·리다이렉트)를 건너뛴다. */
export function isSessionNeutralEndpoint(path: string): boolean {
  return SESSION_NEUTRAL_PATHS.includes(normalizedPathname(path));
}

function normalizedPathname(path: string): string {
  let pathname = pathnameOf(path);
  const prefix = basePathname();
  if (prefix && pathname.startsWith(prefix)) {
    pathname = pathname.slice(prefix.length) || "/";
  }
  return pathname;
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  // 파일 업로드(#309 공지 이미지)는 **Content-Type 을 우리가 정하면 안 된다** — multipart 는
  // 본문에 boundary 토큰이 필요하고 그건 브라우저가 FormData 를 직렬화하며 만든다. 손으로
  // "multipart/form-data" 를 넣으면 boundary 가 빠져 서버가 파트를 하나도 못 읽는다.
  const isForm = typeof FormData !== "undefined" && options.body instanceof FormData;
  if (options.body !== undefined && !isForm && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  // 배포 빌드는 여기서 현재 백엔드 오리진을 확보한다(#183). 플래그가 없으면 즉시 resolve.
  await ensureRuntimeConfig();

  const init: RequestInit = {
    ...options,
    headers,
    body: options.body === undefined
      ? undefined
      : isForm
        ? (options.body as FormData) // 그대로 넘긴다(직렬화하면 "[object FormData]" 문자열이 간다)
        : JSON.stringify(options.body),
  };

  // API base 적용 지점은 여기 **한 곳**뿐이다(#129).
  let url = apiUrl(path);

  let res: Response;
  try {
    res = await fetch(url, init);
  } catch (err) {
    // 응답 자체가 안 온다 = 터널 사망/주소 스테일이 유력하다(playbook §4 의 "Failed to fetch").
    // 워치독이 이미 새 터널을 올려 config 를 갱신했을 수 있으니 재조회 → 바뀌었으면 1회만 재시도.
    if (!(await refreshRuntimeConfig())) {
      // 여기가 "백엔드에 못 닿았다"의 유일한 종점이다(#477). 확정은 backend-health 가 프로브로
      // 한 번 더 확인한 뒤에 한다 — 여기서 바로 점검 화면을 띄우면 순간 끊김이 장애가 된다.
      reportBackendUnreachable();
      throw err;
    }
    url = apiUrl(path);
    try {
      res = await fetch(url, init);
    } catch (retryErr) {
      reportBackendUnreachable();
      throw retryErr;
    }
  }

  // 터널은 살아 있는데 오리진(도커)만 죽으면 fetch 는 성공하고 게이트웨이가 5xx 를 준다 —
  // 유저에게는 같은 장애이고, 실제 운영에서 더 자주 보는 형태다.
  if (GATEWAY_DOWN_STATUS.has(res.status)) {
    reportBackendUnreachable();
  } else {
    reportBackendReachable();
  }

  if (res.status === 401) {
    const body = await parseErrorBody(res);
    // 인증 엔드포인트의 401 = 자격 오류(폼 에러) → 세션을 건드리지 않고 호출자에게 위임.
    // 판별은 base 가 붙은 최종 url 로 한다(붙기 전 path 로 해도 같은 답이어야 함 — 테스트 박제).
    if (!isAuthEndpoint(url) && !isSessionNeutralEndpoint(url)) {
      clearToken();
      clearProvider();
      onUnauthorized();
    }
    throw new ApiError(401, body);
  }

  if (!res.ok) {
    const body = await parseErrorBody(res);
    throw new ApiError(res.status, body);
  }

  if (res.status === 204) {
    return undefined as T;
  }

  return (await res.json()) as T;
}
