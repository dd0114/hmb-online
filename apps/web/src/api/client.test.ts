// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  __resetRuntimeConfig,
  apiBase,
  apiFetch,
  apiUrl,
  clearToken,
  getProvider,
  getToken,
  isAuthEndpoint,
  isSessionNeutralEndpoint,
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

    /**
     * 공개(세션 중립) 경로 — #232. `/api/config` 는 재화 표기·상점 가격이라 유저 데이터가 0 이고
     * 서버에서 인증 제외돼 있다. 그런데 "인증 경로가 아닌 401 = 세션 만료" 규칙에 걸리면,
     * 프록시·CDN 이 이 경로에 401 을 끼우는 순간 **유저 데이터와 무관한 응답 하나가 로그인된
     * 유저를 튕겨낸다**. 에러는 던지되 세션은 건드리지 않는다.
     */
    it("공개 경로(/api/config) 401 은 세션을 파기하지 않는다", async () => {
      setToken("still-valid-token");
      setProvider("guest");
      const handler = vi.fn();
      setUnauthorizedHandler(handler);
      mock401();

      await expect(apiFetch("/api/config")).rejects.toBeInstanceOf(ApiError);

      expect(handler).not.toHaveBeenCalled();
      expect(getToken()).toBe("still-valid-token");
      expect(getProvider()).toBe("guest");
    });

    it("공개 경로 판별도 절대 URL·base 서브패스에서 같은 답을 낸다", () => {
      expect(isSessionNeutralEndpoint("/api/config")).toBe(true);
      expect(isSessionNeutralEndpoint("https://api.example.com/api/config")).toBe(true);
      // 접두만 겹치는 경로는 공개가 아니다.
      expect(isSessionNeutralEndpoint("/api/configuration")).toBe(false);
      expect(isSessionNeutralEndpoint("/api/me")).toBe(false);
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

  /* ── 런타임 백엔드 config (에픽 #183 접근 A + E) ──────────────────────────────
   * quick tunnel URL 은 터널이 죽을 때마다 바뀐다. 빌드타임 인라인만 쓰면 그 순간 배포된 web 이
   * 죽은 주소를 계속 부른다(테스터 전원 Failed to fetch). 그래서 배포 빌드는
   * VITE_RUNTIME_CONFIG_URL(=/config.json) 을 켜고, 자가복구 워치독이 그 파일만 갱신하면
   * 재빌드 없이 web 이 새 주소를 따라간다.
   *
   * 여기서 박제하는 계약 3가지:
   *   (1) 플래그 미설정 = 지금까지와 **완전히 동일**(추가 네트워크 호출 0) — dev·테스트·데모 무회귀
   *   (2) config 값이 빌드타임 값을 이긴다 / config 를 못 읽으면 빌드타임으로 폴백(앱이 죽지 않는다)
   *   (3) **자가복구**: 네트워크 도달 실패 시 config 재조회 → 주소가 바뀌었으면 그 주소로 1회 재시도.
   *       주소가 그대로면 재시도하지 않는다(무한 루프 금지).
   */
  describe("런타임 config (#183)", () => {
    const CONFIG_URL = "/config.json";

    /** config.json 과 API 를 URL 로 분기하는 fetch 목. */
    function mockRouted(opts: {
      configApiBase?: string | null; // null = config 조회 실패(404)
      apiResults?: Array<"ok" | "network-error">;
    }) {
      const apiResults = opts.apiResults ?? ["ok"];
      let apiCall = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).startsWith(CONFIG_URL)) {
          if (opts.configApiBase == null) return new Response("nope", { status: 404 });
          return new Response(JSON.stringify({ apiBase: opts.configApiBase }), { status: 200 });
        }
        const outcome = apiResults[Math.min(apiCall++, apiResults.length - 1)];
        if (outcome === "network-error") throw new TypeError("Failed to fetch");
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      global.fetch = fetchMock as unknown as typeof fetch;
      return fetchMock;
    }

    const apiCalls = (m: ReturnType<typeof vi.fn>) =>
      m.mock.calls.map((c) => String(c[0])).filter((u) => !u.startsWith(CONFIG_URL));
    const configCalls = (m: ReturnType<typeof vi.fn>) =>
      m.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith(CONFIG_URL));

    beforeEach(() => {
      __resetRuntimeConfig();
    });

    afterEach(() => {
      vi.unstubAllEnvs();
      __resetRuntimeConfig();
    });

    it("플래그 미설정이면 config 를 아예 조회하지 않는다 (dev·데모 무회귀)", async () => {
      vi.stubEnv("VITE_API_BASE", "https://build-time.example.com");
      const fetchMock = mockRouted({ configApiBase: "https://runtime.example.com" });

      await apiFetch("/api/me");

      expect(configCalls(fetchMock)).toHaveLength(0);
      expect(apiCalls(fetchMock)).toEqual(["https://build-time.example.com/api/me"]);
    });

    it("config 의 apiBase 가 빌드타임 값을 이긴다", async () => {
      vi.stubEnv("VITE_API_BASE", "https://stale-tunnel.example.com");
      vi.stubEnv("VITE_RUNTIME_CONFIG_URL", CONFIG_URL);
      const fetchMock = mockRouted({ configApiBase: "https://fresh-tunnel.example.com" });

      await apiFetch("/api/me");

      expect(apiCalls(fetchMock)).toEqual(["https://fresh-tunnel.example.com/api/me"]);
      expect(apiBase()).toBe("https://fresh-tunnel.example.com");
    });

    it("config 를 못 읽으면 빌드타임 값으로 폴백한다 (앱이 죽지 않는다)", async () => {
      vi.stubEnv("VITE_API_BASE", "https://build-time.example.com");
      vi.stubEnv("VITE_RUNTIME_CONFIG_URL", CONFIG_URL);
      const fetchMock = mockRouted({ configApiBase: null });

      await expect(apiFetch("/api/me")).resolves.toEqual({ ok: true });
      expect(apiCalls(fetchMock)).toEqual(["https://build-time.example.com/api/me"]);
    });

    it("config 는 한 번만 로드한다 (요청마다 재조회 금지)", async () => {
      vi.stubEnv("VITE_RUNTIME_CONFIG_URL", CONFIG_URL);
      const fetchMock = mockRouted({ configApiBase: "https://fresh.example.com" });

      await apiFetch("/api/me");
      await apiFetch("/api/deck");

      expect(configCalls(fetchMock)).toHaveLength(1);
    });

    it("네트워크 실패 시 config 를 재조회해 **새 주소로 1회 재시도**한다 (자가복구 핵심)", async () => {
      // 시나리오: 부팅 시 config = 터널A → 터널A 사망(도달 실패) → 워치독이 config 를 터널B 로 갱신
      vi.stubEnv("VITE_RUNTIME_CONFIG_URL", CONFIG_URL);
      let served = "https://tunnel-a.example.com";
      let apiCall = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (String(url).startsWith(CONFIG_URL)) {
          return new Response(JSON.stringify({ apiBase: served }), { status: 200 });
        }
        apiCall += 1;
        if (apiCall === 1) {
          served = "https://tunnel-b.example.com"; // 워치독이 그 사이 갱신
          throw new TypeError("Failed to fetch");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      await expect(apiFetch("/api/me")).resolves.toEqual({ ok: true });

      expect(apiCalls(fetchMock)).toEqual([
        "https://tunnel-a.example.com/api/me", // 죽은 주소로 1회
        "https://tunnel-b.example.com/api/me", // 재조회한 새 주소로 재시도 → 성공
      ]);
      expect(configCalls(fetchMock)).toHaveLength(2); // 부팅 1 + 실패 후 재조회 1
    });

    it("config 조회가 매달려도 앱이 멈추지 않는다 (타임아웃 → 빌드타임 폴백)", async () => {
      vi.stubEnv("VITE_API_BASE", "https://build-time.example.com");
      vi.stubEnv("VITE_RUNTIME_CONFIG_URL", CONFIG_URL);
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (String(url).startsWith(CONFIG_URL)) {
          // 영원히 안 끝나는 응답 — abort 시그널로만 풀린다.
          return await new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      });
      global.fetch = fetchMock as unknown as typeof fetch;

      vi.useFakeTimers();
      const pending = apiFetch("/api/me");
      await vi.advanceTimersByTimeAsync(3100);
      vi.useRealTimers();

      await expect(pending).resolves.toEqual({ ok: true });
      expect(apiCalls(fetchMock)).toEqual(["https://build-time.example.com/api/me"]);
    });

    it("재조회해도 주소가 그대로면 재시도하지 않고 원래 에러를 던진다 (무한 루프 금지)", async () => {
      vi.stubEnv("VITE_RUNTIME_CONFIG_URL", CONFIG_URL);
      const fetchMock = mockRouted({
        configApiBase: "https://same.example.com",
        apiResults: ["network-error"],
      });

      await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(TypeError);
      expect(apiCalls(fetchMock)).toHaveLength(1);
    });
  });
});
