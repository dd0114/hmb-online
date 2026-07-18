// @vitest-environment jsdom
/**
 * AppNav (P2-D2, LLD-p2-web §7): 반응형 네비 — 항목/활성상태/'준비중' 비활성 렌더 계약.
 * 반응형 표현(하단탭 vs 사이드바)은 CSS 미디어쿼리 소관이라 두 nav 요소가 모두 DOM 에
 * 렌더되는지(단일 소스)와 라우팅 로직만 검증한다.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { AppNav, NAV_ITEMS, activeNavKey } from "./AppNav";

function renderNav(path: string) {
  return render(h(MemoryRouter, { initialEntries: [path] }, h(AppNav)));
}

afterEach(() => cleanup());

describe("activeNavKey", () => {
  it("matches exact and nested paths, ignoring pending routes", () => {
    expect(activeNavKey("/lobby")).toBe("home");
    expect(activeNavKey("/deck")).toBe("deck");
    expect(activeNavKey("/codex")).toBe("codex");
    expect(activeNavKey("/trade")).toBe("trade"); // W3 활성
    expect(activeNavKey("/deck/anything")).toBe("deck");
    expect(activeNavKey("/shop")).toBeNull(); // 상점은 nav 항목 아님
  });
});

describe("AppNav render (LLD §7)", () => {
  it("renders both a bottom tab bar (mobile) and a sidebar (desktop) — single source", () => {
    renderNav("/lobby");
    expect(screen.getByTestId("nav-bottom")).toBeTruthy();
    expect(screen.getByTestId("nav-sidebar")).toBeTruthy();
  });

  it("renders all 5 items (홈/덱/트레이드/로그/도감) in each nav", () => {
    renderNav("/lobby");
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["홈", "덱", "트레이드", "로그", "도감"]);
    for (const nav of [screen.getByTestId("nav-bottom"), screen.getByTestId("nav-sidebar")]) {
      const scope = within(nav);
      for (const item of NAV_ITEMS) {
        expect(scope.getByTestId(`nav-${item.key}`)).toBeTruthy();
      }
    }
  });

  it("marks pending items (로그) as '준비중' + aria-disabled", () => {
    renderNav("/lobby");
    const bottom = within(screen.getByTestId("nav-bottom"));
    for (const key of ["logs"]) {
      const btn = bottom.getByTestId(`nav-${key}`);
      expect(btn.getAttribute("aria-disabled")).toBe("true");
      expect(within(btn).getByText("준비중")).toBeTruthy();
    }
    // 트레이드(W3)는 더 이상 '준비중'이 아니다.
    const tradeBtn = bottom.getByTestId("nav-trade");
    expect(tradeBtn.getAttribute("aria-disabled")).toBeNull();
  });

  it("marks the active item for the current route (aria-current=page)", () => {
    renderNav("/deck");
    const bottom = within(screen.getByTestId("nav-bottom"));
    expect(bottom.getByTestId("nav-deck").getAttribute("aria-current")).toBe("page");
    expect(bottom.getByTestId("nav-home").getAttribute("aria-current")).toBeNull();
  });
});
