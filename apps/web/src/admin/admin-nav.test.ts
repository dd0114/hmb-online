// @vitest-environment jsdom
/**
 * admin 진입점 노출 계약 — 운영 링크는 **admin 계정에만** 붙고, 비admin 에겐 DOM 에도 없다.
 * AdminFlagContext 는 react 만 쓰므로 AppNav 는 쿼리 컨텍스트 없이도 렌더된다(기존 페이지
 * 유닛 테스트 무회귀 — src/admin/admin-flag.ts 주석 참조).
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import {
  ADMIN_NAV_ITEM,
  AppNav,
  EVENTS_NAV_ITEM,
  NAV_ITEMS,
  activeNavKey,
  navItemsFor,
} from "../common/AppNav";
import { AdminFlagContext } from "./admin-flag";

afterEach(() => cleanup());

function renderNav(isAdmin: boolean, path = "/lobby") {
  return render(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(AdminFlagContext.Provider, { value: isAdmin }, h(AppNav)),
    ),
  );
}

describe("navItemsFor", () => {
  it("비admin 은 기본 항목만", () => {
    expect(navItemsFor(false)).toEqual(NAV_ITEMS);
  });

  it("admin 은 운영 항목 하나만 뒤에 추가 (#492 로 늘었다가 #498 로 되돌아왔다)", () => {
    // ⚠️ 이 단언은 `+1`(원래) → `+2`(#492) → **`+1`**(#498) 로 두 번 움직였다. 되돌린 것은
    //    취향이 아니라 폭이다(8칸 = 320px 40.0px < 44pt). 이벤트 보드는 AdminSubnav 로 갔다.
    const items = navItemsFor(true);
    expect(items.length).toBe(NAV_ITEMS.length + 1);
    expect(items.at(-1)).toEqual(ADMIN_NAV_ITEM);
    expect(items).not.toContain(EVENTS_NAV_ITEM);
  });

  it("/admin 은 admin 항목 목록에서만 활성 키를 갖는다", () => {
    expect(activeNavKey("/admin", navItemsFor(true))).toBe("admin");
    expect(activeNavKey("/admin", navItemsFor(false))).toBeNull();
  });
});

describe("AppNav admin 링크 노출", () => {
  it("프로바이더 없이 렌더해도 admin 링크가 없다(안전한 기본값)", () => {
    render(h(MemoryRouter, { initialEntries: ["/lobby"] }, h(AppNav)));
    expect(screen.queryAllByTestId("nav-admin").length).toBe(0);
  });

  it("비admin: 운영 링크 미노출", () => {
    renderNav(false);
    expect(screen.queryAllByTestId("nav-admin").length).toBe(0);
  });

  it("admin: 하단탭/사이드바 양쪽에 운영 링크", () => {
    renderNav(true);
    // 단일 소스라 두 nav 표현 모두에 렌더된다(CSS 로 하나만 보임).
    expect(screen.getAllByTestId("nav-admin").length).toBe(2);
  });

  it("이벤트 보드는 하단탭/사이드바 어디에도 없다 — admin 에게도 (#498)", () => {
    // #492 는 여기에 `nav-events` 를 2개(두 nav 표현) 그렸다. #498 이후 진입은 `운영` 탭 →
    // 화면 상단 서브탭이다. 이 단언이 없으면 두 진입점이 조용히 공존해도 아무도 모른다.
    renderNav(true);
    expect(screen.queryAllByTestId("nav-events").length).toBe(0);
    expect(screen.getAllByTestId("nav-admin").length).toBe(2);
  });

  it("/event-board 에서도 하단탭 활성은 [운영] (#498)", () => {
    renderNav(true, "/event-board");
    for (const btn of screen.getAllByTestId("nav-admin")) {
      expect(btn.getAttribute("aria-current")).toBe("page");
    }
  });
});
