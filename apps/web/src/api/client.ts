/**
 * Thin fetch wrapper for the server-java API (docs/plan-v2/api/openapi.yaml).
 * - Injects `Authorization: Bearer <token>` from localStorage.
 * - Parses the shared `ApiError` envelope ({code, message, detail}) on non-2xx.
 * - On 401: clears the stored token and triggers the unauthorized handler
 *   (wired by App.tsx to a router redirect to /login; defaults to a hard redirect
 *   so the wrapper is still correct if used outside the React tree).
 */

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

/**
 * 인증 엔드포인트 접두 — 이 경로들의 401 은 **인증 실패**(잘못된 자격)이지 **세션 만료**가 아니다.
 * 자체 로그인(PRD-v4 §A) 도입으로 "오타 비번 = 일상적 401" 이 생겼기 때문에 구분이 필요하다.
 * 여기 걸리면 401 부수효과(토큰 클리어 + onUnauthorized 리다이렉트)를 건너뛰고 ApiError 만 던진다
 * — 유효 세션을 보유한 채 /login 에서 오답을 내도 기존 세션이 파기되지 않는다.
 * 그 외 모든 경로의 401 은 기존대로 세션 파기(회귀 테스트로 박제 — client.test.ts).
 */
const AUTH_PATH_PREFIX = "/api/auth/";

/** 상대/절대 URL 모두에서 pathname 을 뽑는다(API base 환경변수화 대비 — P3-D1). */
function pathnameOf(path: string): string {
  const base =
    typeof window !== "undefined" && window.location ? window.location.origin : "http://localhost";
  try {
    return new URL(path, base).pathname;
  } catch {
    return path;
  }
}

export function isAuthEndpoint(path: string): boolean {
  return pathnameOf(path).startsWith(AUTH_PATH_PREFIX);
}

export async function apiFetch<T>(path: string, options: ApiFetchOptions = {}): Promise<T> {
  const token = getToken();
  const headers = new Headers(options.headers);
  if (options.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) {
    headers.set("Authorization", `Bearer ${token}`);
  }

  const res = await fetch(path, {
    ...options,
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  if (res.status === 401) {
    const body = await parseErrorBody(res);
    // 인증 엔드포인트의 401 = 자격 오류(폼 에러) → 세션을 건드리지 않고 호출자에게 위임.
    if (!isAuthEndpoint(path)) {
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
