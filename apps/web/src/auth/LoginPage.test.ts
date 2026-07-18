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

function renderLogin() {
  return render(h(MemoryRouter, { initialEntries: ["/login"] }, h(TokenProvider, null, h(LoginPage))));
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ token: "tok_1", user: { id: "u1", nickname: "테스터" }, isNew: false });
  window.localStorage.clear();
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
