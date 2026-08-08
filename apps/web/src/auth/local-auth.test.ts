// @vitest-environment jsdom
/**
 * 자체 로그인(id/비번) — PRD-v4 §A (AC-A1, AC-A2).
 * apiFetch 를 스텁해 요청 shape·에러 매핑·비밀번호 비노출을 단언한다(실제 서버 호출 없음).
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

import { ApiError } from "../api/client";
import { LoginPage } from "./LoginPage";
import { TokenProvider } from "./TokenContext";
import { SPLASH_SEEN_KEY } from "../splash/splash-gate";
import { bypassSplash } from "../splash/splash-test-bypass";

const PASSWORD = "sup3rs3cret";
/** 로그인 id 겸 표시 닉네임 — 서버가 식별자를 하나만 둔다(RegisterRequest.java). */
const NICKNAME = "테스터01";

function renderLogin() {
  return render(h(MemoryRouter, { initialEntries: ["/login"] }, h(TokenProvider, null, h(LoginPage))));
}

/** provider 선택 → "아이디로 로그인" 진입. */
function openLocalPanel() {
  renderLogin();
  fireEvent.click(screen.getByTestId("provider-local"));
}

function type(testId: string, value: string) {
  fireEvent.change(screen.getByTestId(testId), { target: { value } });
}

function fillLogin(nickname = NICKNAME, password = PASSWORD) {
  type("local-nickname", nickname);
  type("local-password", password);
}

beforeEach(() => {
  apiFetch.mockReset();
  apiFetch.mockResolvedValue({ token: "tok_local", user: { id: "u1", nickname: "테스터" }, isNew: false });
  window.localStorage.clear();
  window.sessionStorage.clear();
  /**
   * ⚠️ #479 부터 `LoginPage` 의 첫 화면은 **스플래시**다 — 이 파일의 스펙들은 그 뒤의
   * 자체 로그인 패널을 보므로 "이미 봤다"에서 출발시킨다. 스플래시 동선 자체는
   * `LoginPage.test.ts` 의 `#479` describe + `e2e/p479-splash.spec.ts` 소관.
   */
  bypassSplash();
});

afterEach(() => cleanup());

describe("local auth entry point (AC-A1, additive)", () => {
  it("provider 선택 화면에 기존 3버튼 + 아이디 진입점이 함께 있다 (무회귀)", () => {
    renderLogin();
    expect(screen.getByTestId("provider-mock:google")).toBeTruthy();
    expect(screen.getByTestId("provider-mock:apple")).toBeTruthy();
    expect(screen.getByTestId("provider-guest")).toBeTruthy();
    expect(screen.getByTestId("provider-local")).toBeTruthy();
  });

  it("아이디 경로는 OAuth 동의 모달을 거치지 않고 바로 아이디/비번 폼", () => {
    openLocalPanel();
    expect(screen.queryByTestId("consent-modal")).toBeNull();
    expect(screen.getByTestId("local-auth-form").getAttribute("data-mode")).toBe("login");
    expect(screen.getByTestId("local-nickname")).toBeTruthy();
    expect(screen.getByTestId("local-password")).toBeTruthy();
  });

  it("서버 계약대로 식별자 입력은 **하나뿐**이다 (아이디/닉네임 이중 입력 없음)", () => {
    // 서버 RegisterRequest = {nickname, password}. 별도 loginId 입력이 남아 있으면 계약 이탈.
    openLocalPanel();
    expect(screen.queryByTestId("local-login-id")).toBeNull();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    expect(screen.getByTestId("local-auth-form").getAttribute("data-mode")).toBe("register");
    expect(screen.queryByTestId("local-login-id")).toBeNull();
    // 회원가입 모드의 텍스트 입력 = 식별자 1 + 비번 1, 총 2개.
    const inputs = screen
      .getByTestId("local-auth-form")
      .querySelectorAll("input");
    expect(inputs.length).toBe(2);
  });

  it("평문 목업 안내가 화면에 명시된다 (AC-A2)", () => {
    openLocalPanel();
    expect(screen.getByTestId("local-plaintext-notice").textContent).toContain("평문");
  });

  it("뒤로 가면 기존 provider 선택 화면으로 복귀 (무회귀)", () => {
    openLocalPanel();
    fireEvent.click(screen.getByTestId("local-back"));
    expect(screen.getByTestId("provider-choose")).toBeTruthy();
    expect(screen.queryByTestId("local-auth-form")).toBeNull();
  });
});

describe("register (AC-A1)", () => {
  it("성공 시 POST /api/auth/register {nickname,password} (서버 2필드 계약)", async () => {
    apiFetch.mockResolvedValue({ token: "tok_new", user: { id: "u2", nickname: "신규" }, isNew: true });
    openLocalPanel();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    fillLogin("신규감독");
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/register", {
      method: "POST",
      body: { nickname: "신규감독", password: PASSWORD },
    });
    // isNew=true → 기존과 동일하게 스타터팩 모달.
    await waitFor(() => expect(screen.getByText("스타터 팩 지급")).toBeTruthy());
    expect(window.localStorage.getItem("hmb.auth.token")).toBe("tok_new");
    expect(window.localStorage.getItem("hmb.auth.provider")).toBe("local");
  });

  it("409 DUPLICATE_NICKNAME → 아이디 필드 에러", async () => {
    apiFetch.mockRejectedValue(
      new ApiError(409, { code: "DUPLICATE_NICKNAME", message: "duplicate" }),
    );
    openLocalPanel();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    fillLogin("신규감독");
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("local-error-nickname").textContent).toBe("이미 사용 중인 아이디입니다"),
    );
    expect(window.localStorage.getItem("hmb.auth.token")).toBeNull();
  });

  it("클라 검증 실패(짧은 아이디/비번)는 요청을 막는다", () => {
    openLocalPanel();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    fillLogin("x", "1");
    fireEvent.click(screen.getByTestId("local-submit"));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("local-error-nickname")).toBeTruthy();
    expect(screen.getByTestId("local-error-password")).toBeTruthy();
  });

  it("64자 초과 비밀번호도 왕복 전에 막는다 (서버 max 미러)", () => {
    openLocalPanel();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    fillLogin("신규감독", "a".repeat(65));
    fireEvent.click(screen.getByTestId("local-submit"));

    expect(apiFetch).not.toHaveBeenCalled();
    expect(screen.getByTestId("local-error-password")).toBeTruthy();
  });
});

describe("login (AC-A1)", () => {
  it("성공 시 POST /api/auth/login {nickname,provider:'local',password}", async () => {
    openLocalPanel();
    fillLogin();
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(apiFetch).toHaveBeenCalledWith("/api/auth/login", {
      method: "POST",
      body: { nickname: NICKNAME, provider: "local", password: PASSWORD },
    });
    await waitFor(() => expect(window.localStorage.getItem("hmb.auth.token")).toBe("tok_local"));
    expect(window.localStorage.getItem("hmb.auth.provider")).toBe("local");
  });

  it("401 BAD_CREDENTIALS → 폼 전역 에러 (어느 필드가 틀렸는지 노출 안 함)", async () => {
    apiFetch.mockRejectedValue(
      new ApiError(401, { code: "BAD_CREDENTIALS", message: "bad" }),
    );
    openLocalPanel();
    fillLogin(NICKNAME, "wrongpw");
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() =>
      expect(screen.getByTestId("local-error-form").textContent).toBe(
        "아이디 또는 비밀번호가 올바르지 않습니다",
      ),
    );
    expect(screen.queryByTestId("local-error-nickname")).toBeNull();
    expect(screen.queryByTestId("local-error-password")).toBeNull();
  });
});

describe("AC-A2 — 비밀번호가 어디에도 남지 않는다", () => {
  function keysOf(store: Storage): string[] {
    return Array.from({ length: store.length }, (_, i) => store.key(i)!);
  }

  function dumpStorage(store: Storage): string {
    return keysOf(store)
      .map((key) => `${key}=${store.getItem(key)}`)
      .join("\n");
  }

  const dumpLocalStorage = () => dumpStorage(window.localStorage);

  it("로그인 성공 후 localStorage 전체에 비밀번호 문자열이 없다", async () => {
    openLocalPanel();
    fillLogin();
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() => expect(window.localStorage.getItem("hmb.auth.token")).toBe("tok_local"));
    const dump = dumpLocalStorage();
    expect(dump).toContain("tok_local"); // 토큰은 저장된다(기존 계약)
    expect(dump).not.toContain(PASSWORD);
    /**
     * ⚠️ 원래 이 줄은 `sessionStorage.length === 0` 이었다 — "비밀번호가 **세션** 저장소에도
     * 안 남는다"를 *"세션 저장소가 텅 비었다"* 로 대리 측정한 것이다. #479 가 그 저장소에
     * 스플래시 1회 노출 플래그를 정당하게 넣으면서 그 대리값이 깨졌다.
     *
     * 임계를 지우는 대신 **원래 의도로 좁힌다** — 비밀번호가 없고, 키는 그 플래그 하나뿐이다.
     * 화이트리스트라 `length` 판정보다 오히려 강하다(예상 밖의 키가 들어오면 여기서 걸린다).
     */
    expect(dumpStorage(window.sessionStorage)).not.toContain(PASSWORD);
    expect(keysOf(window.sessionStorage)).toEqual([SPLASH_SEEN_KEY]);
  });

  it("회원가입 성공 후에도 localStorage 에 비밀번호가 없다", async () => {
    apiFetch.mockResolvedValue({ token: "tok_new", user: { id: "u2", nickname: "신규" }, isNew: true });
    openLocalPanel();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    fillLogin("신규감독");
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() => expect(apiFetch).toHaveBeenCalledTimes(1));
    expect(dumpLocalStorage()).not.toContain(PASSWORD);
  });

  it("제출 후 비밀번호 입력값이 폼 상태에서 비워진다 (성공/실패 모두)", async () => {
    openLocalPanel();
    fillLogin();
    const input = screen.getByTestId("local-password") as HTMLInputElement;
    expect(input.value).toBe(PASSWORD);
    fireEvent.click(screen.getByTestId("local-submit"));
    await waitFor(() => expect((screen.getByTestId("local-password") as HTMLInputElement).value).toBe(""));

    cleanup();
    apiFetch.mockRejectedValue(new ApiError(401, { code: "BAD_CREDENTIALS", message: "bad" }));
    openLocalPanel();
    fillLogin();
    fireEvent.click(screen.getByTestId("local-submit"));
    await waitFor(() => expect(screen.getByTestId("local-error-form")).toBeTruthy());
    expect((screen.getByTestId("local-password") as HTMLInputElement).value).toBe("");
  });

  it("모드 전환 시에도 비밀번호가 남지 않는다", () => {
    openLocalPanel();
    fillLogin();
    fireEvent.click(screen.getByTestId("local-mode-toggle"));
    expect((screen.getByTestId("local-password") as HTMLInputElement).value).toBe("");
    // 아이디는 유지(재입력 부담 완화).
    expect((screen.getByTestId("local-nickname") as HTMLInputElement).value).toBe(NICKNAME);
  });

  it("비밀번호를 console 로 출력하지 않는다", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {}),
    );
    apiFetch.mockRejectedValue(new ApiError(401, { code: "BAD_CREDENTIALS", message: "bad" }));
    openLocalPanel();
    fillLogin();
    fireEvent.click(screen.getByTestId("local-submit"));
    await waitFor(() => expect(screen.getByTestId("local-error-form")).toBeTruthy());

    const printed = spies.flatMap((spy) => spy.mock.calls.flat()).map((arg) => JSON.stringify(arg)).join(" ");
    expect(printed).not.toContain(PASSWORD);
    spies.forEach((spy) => spy.mockRestore());
  });

  it("서버가 에러 message 에 비밀번호를 에코해도 화면에 노출하지 않는다", async () => {
    apiFetch.mockRejectedValue(
      new ApiError(401, { code: "BAD_CREDENTIALS", message: `password ${PASSWORD} is wrong` }),
    );
    openLocalPanel();
    fillLogin();
    fireEvent.click(screen.getByTestId("local-submit"));

    await waitFor(() => expect(screen.getByTestId("local-error-form")).toBeTruthy());
    expect(document.body.textContent).not.toContain(PASSWORD);
  });
});
