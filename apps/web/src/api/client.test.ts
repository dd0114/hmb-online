// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, apiFetch, clearToken, getToken, setToken, setUnauthorizedHandler } from "./client";

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
});
