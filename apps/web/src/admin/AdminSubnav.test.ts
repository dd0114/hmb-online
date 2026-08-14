// @vitest-environment jsdom
/**
 * 운영 화면 서브탭 (#498, 안 A) — 하단탭에서 뺀 진입점이 **여기로 옮겨졌다**는 계약.
 *
 * ⚠️ 이 파일이 지키는 것은 "pill 이 예쁘게 그려지나"가 아니라 **진입점이 사라지지 않았나**다.
 * #498 은 `navItemsFor` 에서 이벤트 보드 칸을 뺐다 — 그 칸이 서브탭으로 오지 않으면 admin 은
 * `/event-board` 를 **URL 을 외워야만** 열 수 있다(=화면을 잃는다). 그래서 AppNav 쪽 단언
 * ("칸이 없다")과 이쪽 단언("서브탭에 있다")은 **짝**이고 한쪽만 있으면 공허하다.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { afterEach, describe, expect, it } from "vitest";
import { ADMIN_SUBNAV, AdminSubnav, adminSubnavKey } from "./AdminSubnav";
import { ADMIN_NAV_ITEM, EVENTS_NAV_ITEM } from "../common/AppNav";

afterEach(() => cleanup());

/** 현재 경로를 화면에 찍어 두는 프로브 — 클릭이 실제로 라우팅했는지 본다(스파이 아님). */
function Probe() {
  return h("div", { "data-testid": "probe-path" }, useLocation().pathname);
}

function renderAt(path: string) {
  return render(
    h(
      MemoryRouter,
      { initialEntries: [path] },
      h(Routes, null, h(Route, { path: "*", element: h("div", null, h(AdminSubnav), h(Probe)) })),
    ),
  );
}

describe("ADMIN_SUBNAV — 진입점 보존 (#498)", () => {
  it("두 운영 화면이 모두 있다 — 하단탭에서 뺀 이벤트 보드 포함", () => {
    expect(ADMIN_SUBNAV.map((i) => i.to)).toEqual([ADMIN_NAV_ITEM.to, EVENTS_NAV_ITEM.to]);
  });

  it("경로를 두 번 적지 않는다 — AppNav 상수가 SoT", () => {
    // 라우트를 여기에 리터럴로 박으면 App.tsx 나 AppNav 한쪽만 바뀌어 조용히 깨진다.
    expect(ADMIN_SUBNAV.find((i) => i.key === "events")?.to).toBe(EVENTS_NAV_ITEM.to);
    expect(ADMIN_SUBNAV.find((i) => i.key === "admin")?.to).toBe(ADMIN_NAV_ITEM.to);
  });
});

describe("adminSubnavKey", () => {
  it("두 운영 경로와 그 하위를 각각 집는다", () => {
    expect(adminSubnavKey("/admin")).toBe("admin");
    expect(adminSubnavKey("/admin/anything")).toBe("admin");
    expect(adminSubnavKey("/event-board")).toBe("events");
  });

  it("운영 화면이 아니면 null — 이 바는 다른 화면에 안 나온다", () => {
    expect(adminSubnavKey("/home")).toBeNull();
    expect(adminSubnavKey("/me")).toBeNull();
  });
});

describe("AdminSubnav 렌더", () => {
  it("현재 화면이 활성으로 표시된다 (라우트가 SoT — 내부 state 아님)", () => {
    renderAt("/event-board");
    expect(screen.getByTestId("admin-subnav-events").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("admin-subnav-admin").getAttribute("aria-current")).toBeNull();
  });

  it("직접 URL 진입에서도 어긋나지 않는다 — /admin 으로 들어오면 운영 액션이 활성", () => {
    renderAt("/admin");
    expect(screen.getByTestId("admin-subnav-admin").getAttribute("aria-current")).toBe("page");
  });

  it("반대쪽 pill 을 누르면 그 라우트로 간다 — 이게 유일한 진입 경로다", () => {
    renderAt("/admin");
    fireEvent.click(screen.getByTestId("admin-subnav-events"));
    expect(screen.getByTestId("probe-path").textContent).toBe("/event-board");
    fireEvent.click(screen.getByTestId("admin-subnav-admin"));
    expect(screen.getByTestId("probe-path").textContent).toBe("/admin");
  });
});
