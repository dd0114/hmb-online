// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  apiBase,
  apiFetch,
  apiUrl,
  clearToken,
  getProvider,
  getToken,
  isAuthEndpoint,
  setProvider,
  setToken,
  setUnauthorizedHandler,
} from "./client";

describe("apiFetch", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    setUnauthorizedHandler(() => {});
  });

  it("injects the Bearer token from storage", async () => {
    setToken("tok-123");
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch("/api/me");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.get("Authorization")).toBe("Bearer tok-123");
  });

  it("omits Authorization when there is no stored token", async () => {
    clearToken();
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await apiFetch("/api/modes");

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Headers;
    expect(headers.has("Authorization")).toBe(false);
  });

  it("parses the ApiError envelope ({code, message, detail}) on a non-2xx response", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          code: "DECK_INVALID",
          message: "선발이 11명이 아닙니다",
          detail: { starterCount: 10 },
        }),
        { status: 400 },
      ),
    );
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch("/api/deck", { method: "PUT", body: {} })).rejects.toMatchObject({
      status: 400,
      code: "DECK_INVALID",
      message: "선발이 11명이 아닙니다",
      detail: { starterCount: 10 },
    });
  });

  it("falls back to INTERNAL_ERROR when the error body isn't the expected JSON shape", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("oops", { status: 500, statusText: "Server Error" }));
    global.fetch = fetchMock as unknown as typeof fetch;

    const err = await apiFetch("/api/me").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("INTERNAL_ERROR");
  });

  it("on 401: clears the stored token and invokes the unauthorized handler", async () => {
    setToken("expired-token");
    const handler = vi.fn();
    setUnauthorizedHandler(handler);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: "UNAUTHORIZED", message: "expired" }), { status: 401 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
  });

  it("returns undefined for 204 No Content", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(apiFetch("/api/presets/abc")).resolves.toBeUndefined();
  });

  /* ── 401 = 세션 만료 vs 인증 실패 구분 (PRD-v4 §A 웨이브 W-A minor-1) ──
   * 자체 로그인 도입 전엔 /api/auth/login 401 이 사실상 없었다. 이제 **오타 비번 = 일상적 401**
   * 이라 인증 엔드포인트가 전역 세션 파기 경로를 타면 안 된다(유효 토큰 보유 상태로 /login 에서
   * 오답 → 기존 세션 삭제). 인증 실패는 폼 에러일 뿐 세션 만료가 아니다.
   * 다른 모든 경로의 401→로그아웃 동작은 그대로 유지돼야 한다(아래 회귀 케이스).
   */
  describe("401 side effects", () => {
    function mock401(code = "UNAUTHORIZED") {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ code, message: "nope" }), { status: 401 }));
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    it.each([
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/refresh",
    ])("인증 엔드포인트(%s) 401 은 세션을 파기하지 않는다", async (path) => {
      setToken("still-valid-token");
      setProvider("guest");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      mock401("BAD_CREDENTIALS");

      await expect(apiFetch(path, { method: "POST", body: {} })).rejects.toBeInstanceOf(ApiError);

      // 에러는 그대로 던져진다(폼이 잡아 필드 에러로 표면화).
      expect(handler).not.toHaveBeenCalled();
      expect(getToken()).toBe("still-valid-token");
      expect(getProvider()).toBe("guest");
    });

    it("인증 엔드포인트 401 도 ApiError code/status 는 그대로 전달한다", async () => {
      mock401("BAD_CREDENTIALS");
      await expect(apiFetch("/api/auth/login", { method: "POST", body: {} })).rejects.toMatchObject({
        status: 401,
        code: "BAD_CREDENTIALS",
      });
    });

    it.each([
      "/api/me",
      "/api/deck",
      "/api/matches/abc",
      "/api/authorized-thing", // '/api/auth' 접두만 겹치는 경로는 인증 엔드포인트가 아니다
    ])("그 외 경로(%s) 401 은 기존대로 세션을 파기한다 (무회귀)", async (path) => {
      setToken("expired-token");
      setProvider("mock:google");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      mock401();

      await expect(apiFetch(path)).rejects.toBeInstanceOf(ApiError);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(getToken()).toBeNull();
      expect(getProvider()).toBeNull();
    });

    it("절대 URL 로 호출해도 인증 엔드포인트 판별이 동작한다 (API base 환경변수화, P3-D1)", async () => {
      setToken("still-valid-token");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      mock401("BAD_CREDENTIALS");

      await expect(
        apiFetch("https://api.example.com/api/auth/login", { method: "POST", body: {} }),
      ).rejects.toBeInstanceOf(ApiError);

      expect(handler).not.toHaveBeenCalled();
      expect(getToken()).toBe("still-valid-token");
    });
  });

  /* ── VITE_API_BASE (PRD-v4 §G / P3-D1, 이슈 #129) ──
   * CF Pages 정적 배포는 /api 를 받아줄 서버가 없어 Tunnel 백엔드 오리진을 빌드 타임에 주입한다.
   * 두 가지를 함께 박제한다:
   *   (1) base 미설정 = 기존 상대경로 동작 그대로(무회귀).
   *   (2) base 가 붙어도 인증 엔드포인트 401 예외 판정이 **그대로** 동작(세션 파기 회귀 방지).
   */
  describe("API base prefix", () => {
    function mockOk() {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ ok: true }), { status: 200 }));
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    function mock401(code = "UNAUTHORIZED") {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response(JSON.stringify({ code, message: "nope" }), { status: 401 }));
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    afterEach(() => {
      vi.unstubAllEnvs();
    });

    it("미설정이면 상대경로 그대로 요청한다 (기존 동작 무회귀)", async () => {
      vi.stubEnv("VITE_API_BASE", "");
      const fetchMock = mockOk();
      await apiFetch("/api/me");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("/api/me");
      expect(apiBase()).toBe("");
      expect(apiUrl("/api/me")).toBe("/api/me");
    });

    it("설정되면 절대 오리진을 접두로 붙인다", async () => {
      vi.stubEnv("VITE_API_BASE", "https://api.example.com");
      const fetchMock = mockOk();
      await apiFetch("/api/me");
      expect(fetchMock.mock.calls[0]?.[0]).toBe("https://api.example.com/api/me");
    });

    it("base 의 끝 슬래시는 정규화되어 // 이중 슬래시를 만들지 않는다", () => {
      vi.stubEnv("VITE_API_BASE", "https://api.example.com/");
      expect(apiUrl("/api/me")).toBe("https://api.example.com/api/me");
    });

    it("이미 절대 URL 인 경로에는 base 를 덧붙이지 않는다", () => {
      vi.stubEnv("VITE_API_BASE", "https://api.example.com");
      expect(apiUrl("https://other.example.com/api/me")).toBe("https://other.example.com/api/me");
    });

    /* base 설정/미설정 × auth/비auth 4조합 — 판정이 base 에 흔들리면 안 된다. */
    it.each([
      ["", "/api/auth/login", true],
      ["", "/api/me", false],
      ["https://api.example.com", "/api/auth/login", true],
      ["https://api.example.com", "/api/me", false],
      // base 가 서브패스를 포함해도(/backend) 판정이 유지돼야 한다 — 가장 깨지기 쉬운 형태.
      ["https://api.example.com/backend", "/api/auth/login", true],
      ["https://api.example.com/backend", "/api/me", false],
      // 접두만 겹치는 경로는 여전히 인증 엔드포인트가 아니다.
      ["https://api.example.com", "/api/authorized-thing", false],
    ])("base=%s path=%s → isAuthEndpoint(base 적용 전/후 동일)=%s", (base, path, expected) => {
      vi.stubEnv("VITE_API_BASE", base);
      expect(isAuthEndpoint(path)).toBe(expected);
      // 실제 apiFetch 가 판별에 쓰는 형태(base 적용 후)도 같은 답이어야 한다.
      expect(isAuthEndpoint(apiUrl(path))).toBe(expected);
    });

    it("base 설정 상태에서도 인증 엔드포인트 401 은 세션을 파기하지 않는다", async () => {
      vi.stubEnv("VITE_API_BASE", "https://api.example.com");
      setToken("still-valid-token");
      setProvider("local");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      mock401("BAD_CREDENTIALS");

      await expect(
        apiFetch("/api/auth/login", { method: "POST", body: {} }),
      ).rejects.toBeInstanceOf(ApiError);

      expect(handler).not.toHaveBeenCalled();
      expect(getToken()).toBe("still-valid-token");
      expect(getProvider()).toBe("local");
    });

    it("base 설정 상태에서도 그 외 경로 401 은 기존대로 세션을 파기한다 (무회귀)", async () => {
      vi.stubEnv("VITE_API_BASE", "https://api.example.com");
      setToken("expired-token");
      setProvider("local");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      mock401();

      await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);

      expect(handler).toHaveBeenCalledTimes(1);
      expect(getToken()).toBeNull();
      expect(getProvider()).toBeNull();
    });

    it("서브패스 base 에서도 인증 401 이 세션을 파기하지 않는다", async () => {
      vi.stubEnv("VITE_API_BASE", "https://api.example.com/backend");
      setToken("still-valid-token");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      const fetchMock = mock401("BAD_CREDENTIALS");

      await expect(
        apiFetch("/api/auth/register", { method: "POST", body: {} }),
      ).rejects.toBeInstanceOf(ApiError);

      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://api.example.com/backend/api/auth/register",
      );
      expect(handler).not.toHaveBeenCalled();
      expect(getToken()).toBe("still-valid-token");
    });
  });
});
