// @vitest-environment jsdom
/**
 * LoginPage provider 플로우(AC-A1): 3버튼 → (OAuth) mock 동의 모달 → 닉네임 → POST 요청 shape.
 * apiFetch 를 스텁해 요청 body({nickname, provider})를 단언한다. 실제 서버 호출 없음.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const apiFetch = vi.fn();

vi.mock("../api/client", async () => {
  const actual = await vi.importActual<typeof import("../api/client")>("../api/client");
  return { ...actual, apiFetch: (...args: unknown[]) => apiFetch(...args) };
});

import { LoginPage } from "./LoginPage";
import { TokenProvider } from "./TokenContext";
import { SPLASH_SEEN_KEY } from "../splash/splash-gate";
import { bypassSplash } from "../splash/splash-test-bypass";

function renderLogin(entry = "/login") {
  return render(h(MemoryRouter, { initialEntries: [entry] }, h(TokenProvider, null, h(LoginPage))));
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ token: "tok_1", user: { id: "u1", nickname: "테스터" }, isNew: false });
  window.localStorage.clear();
  window.sessionStorage.clear();
  /**
   * ⚠️ #479 부터 **첫 진입은 스플래시**다 — 이 블록의 스펙들은 그 뒤의 provider 플로우를
   * 보는 것이라 "이미 봤다"에서 출발시킨다. 스플래시 자체의 동선은 아래 `#479` describe 와
   * `e2e/p479-splash.spec.ts` 가 실경로로 검증한다(여기서 겸하면 두 관심사가 엉킨다).
   */
  bypassSplash();
});

afterEach(() => cleanup());

describe("LoginPage OAuth mock flow (AC-A1)", () => {
  it("shows 3 auth buttons (google, apple, guest)", () => {
    renderLogin();
    expect(screen.getByTestId("provider-mock:google")).toBeTruthy();
    expect(screen.getByTestId("provider-mock:apple")).toBeTruthy();
    expect(screen.getByTestId("provider-guest")).toBeTruthy();
  });

  it("guest path skips consent modal and goes straight to nickname input", () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("provider-guest"));
    expect(screen.queryByTestId("consent-modal")).toBeNull();
    expect(screen.getByPlaceholderText("2~16자")).toBeTruthy();
  });

  it("google path shows a generic mock consent modal before nickname", () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("provider-mock:google"));
    expect(screen.getByTestId("consent-modal")).toBeTruthy();
    expect(screen.getByText("구글 계정으로 계속")).toBeTruthy();
    // 동의 전에는 닉네임 입력이 아직 없다.
    expect(screen.queryByPlaceholderText("2~16자")).toBeNull();
  });

  it("google flow POSTs /api/auth/login with {nickname, provider: 'mock:google'}", async () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("provider-mock:google"));
    fireEvent.click(screen.getByTestId("consent-continue"));
    fireEvent.change(screen.getByPlaceholderText("2~16자"), { target: { value: "손민수" } });
    fireEvent.click(screen.getByRole("button", { name: "계속" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      body: { nickname: "손민수", provider: "mock:google" },
    });
    // 로그인 시점 provider 를 클라에 보관(로비 뱃지 SoT).
    expect(window.localStorage.getItem("hmb.auth.provider")).toBe("mock:google");
  });

  it("guest flow POSTs provider: 'guest'", async () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("provider-guest"));
    fireEvent.change(screen.getByPlaceholderText("2~16자"), { target: { value: "게스트1" } });
    fireEvent.click(screen.getByRole("button", { name: "계속" }));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      body: { nickname: "게스트1", provider: "guest" },
    });
  });

  it("invalid nickname blocks the request (client-side validation)", () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("provider-guest"));
    fireEvent.change(screen.getByPlaceholderText("2~16자"), { target: { value: "a" } });
    fireEvent.click(screen.getByRole("button", { name: "계속" }));
    expect(apiFetch).not.toHaveBeenCalled();
  });
});

/**
 * #479 — 첫 진입 스플래시가 로그인 폼 **앞에** 선다.
 *
 * ⚠️ 위 블록이 `SPLASH_SEEN_KEY` 를 미리 심으므로 여기서는 **매 스펙이 직접 지운다** — 안 지우면
 * 스플래시가 애초에 마운트되지 않아 이 describe 전체가 "검사하는 척"만 한다.
 */
describe("#479 첫 진입 스플래시", () => {
  beforeEach(() => window.sessionStorage.clear());

  it("첫 진입에는 스플래시가 뜨고 로그인 폼은 렌더되지 않는다", () => {
    renderLogin();
    expect(screen.getByTestId("splash")).toBeTruthy();
    // ⚠️ 오버레이로 덮는 것이 아니라 **대체**다 — 폼이 뒤에 살아 있으면 탭 순서가 두 화면을 읽는다.
    expect(screen.queryByTestId("provider-choose")).toBeNull();
    expect(screen.queryByTestId("provider-guest")).toBeNull();
  });

  it("[게임 시작] 을 누르면 현행 로그인 폼이 그대로 나온다", () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("splash-start"));
    expect(screen.queryByTestId("splash")).toBeNull();
    expect(screen.getByTestId("provider-choose")).toBeTruthy();
    expect(screen.getByTestId("provider-mock:google")).toBeTruthy();
    expect(screen.getByTestId("provider-mock:apple")).toBeTruthy();
    expect(screen.getByTestId("provider-local")).toBeTruthy();
    expect(screen.getByTestId("provider-guest")).toBeTruthy();
  });

  it("[게임 시작] 이 세션 플래그를 남긴다 (세션당 1회)", () => {
    renderLogin();
    fireEvent.click(screen.getByTestId("splash-start"));
    expect(window.sessionStorage.getItem(SPLASH_SEEN_KEY)).toBe("1");
    // 같은 세션에서 다시 마운트되면 스플래시 없이 폼으로 간다.
    cleanup();
    renderLogin();
    expect(screen.queryByTestId("splash")).toBeNull();
    expect(screen.getByTestId("provider-choose")).toBeTruthy();
  });

  /** 공유 딥링크(#298)로 들어온 사람은 광고보다 목적지가 먼저다. */
  it("?returnTo= 로 들어오면 스플래시를 건너뛴다", () => {
    renderLogin("/login?returnTo=%2Fshare%2Fnotice%2Fabc");
    expect(screen.queryByTestId("splash")).toBeNull();
    expect(screen.getByTestId("provider-choose")).toBeTruthy();
  });
});
