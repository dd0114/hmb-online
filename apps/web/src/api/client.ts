/**
 * Thin fetch wrapper for the server-java API (docs/plan-v2/api/openapi.yaml).
 * - Injects `Authorization: Bearer <token>` from localStorage.
 * - Parses the shared `ApiError` envelope ({code, message, detail}) on non-2xx.
 * - On 401: clears the stored token and triggers the unauthorized handler
 *   (wired by App.tsx to a router redirect to /login; defaults to a hard redirect
 *   so the wrapper is still correct if used outside the React tree).
 */

export const TOKEN_STORAGE_KEY = "hmb.auth.token";

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
    clearToken();
    const body = await parseErrorBody(res);
    onUnauthorized();
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
