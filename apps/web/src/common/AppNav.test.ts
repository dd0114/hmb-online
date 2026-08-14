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
import {
  ADMIN_NAV_ITEM,
  AppNav,
  EVENTS_NAV_ITEM,
  NAV_ITEMS,
  activeNavKey,
  navItemLocked,
  navItemsFor,
} from "./AppNav";

function renderNav(path: string) {
  return render(h(MemoryRouter, { initialEntries: [path] }, h(AppNav)));
}

afterEach(() => cleanup());

describe("activeNavKey", () => {
  it("matches exact and nested paths (#286 6탭)", () => {
    expect(activeNavKey("/home")).toBe("home");
    expect(activeNavKey("/game")).toBe("game");
    expect(activeNavKey("/deck")).toBe("deck");
    expect(activeNavKey("/players")).toBe("players");
    expect(activeNavKey("/recruit")).toBe("recruit");
    expect(activeNavKey("/me")).toBe("me");
    expect(activeNavKey("/deck/anything")).toBe("deck");
    expect(activeNavKey("/nowhere")).toBeNull();
  });

  it("리그·원정은 [게임] 탭의 하위 페이지라 활성 표시가 게임에 남는다 (#286)", () => {
    // 이게 없으면 순위표를 보는 동안 어느 탭에 있는지 알 수 없다(어떤 탭도 활성이 아님).
    expect(activeNavKey("/league")).toBe("game");
    expect(activeNavKey("/away")).toBe("game");
  });
});

describe("navItemsFor — admin 전용 진입점 (#492 → #498)", () => {
  it("비admin 에게는 운영·이벤트 항목이 아예 없다", () => {
    const items = navItemsFor(false);
    expect(items).toEqual(NAV_ITEMS);
    expect(items.some((i) => i.key === "admin" || i.key === "events")).toBe(false);
  });

  it("admin 에게 붙는 칸은 [운영] **하나뿐**이다 (#498)", () => {
    // #492 는 여기에 이벤트 보드까지 더해 8칸을 만들었다. #498 이 그걸 되돌린 이유는 아래
    // 폭 계약이다 — 이벤트 보드 진입은 화면 안 서브탭(AdminSubnav)으로 옮겼다.
    const items = navItemsFor(true);
    expect(items).toHaveLength(NAV_ITEMS.length + 1);
    expect(items.at(-1)).toEqual(ADMIN_NAV_ITEM);
    expect(items.some((i) => i.key === "events")).toBe(false);
  });

  it("하단탭은 7칸을 넘지 않는다 — 320px 에서 44pt 를 지키는 상한 (#498)", () => {
    // `flex:1 1 0` 균등분할이라 칸 폭 = 뷰포트 / 칸수. 320px 기준:
    //   7칸 45.7px(iOS 44pt·Material 48dp 충족) / **8칸 40.0px**(미달) / 9칸 35.6px.
    // 이 단언이 red 면 늘릴 곳은 여기가 아니라 AdminSubnav 다(그쪽은 가로 스크롤이라 상한 없음).
    const count = navItemsFor(true).length;
    expect(count).toBeLessThanOrEqual(7);
    expect(320 / count).toBeGreaterThanOrEqual(44);
  });

  it("이벤트 보드는 라우트 상수로만 남는다 — 하단탭 항목이 아니다 (#498)", () => {
    // 상수를 지우지 않은 것은 AdminSubnav 가 경로 SoT 로 쓰기 때문이다(라우트 이중 기재 방지).
    expect(EVENTS_NAV_ITEM.to).toBe("/event-board");
    expect(navItemsFor(true)).not.toContain(EVENTS_NAV_ITEM);
  });

  it("/event-board 에서도 활성 탭은 [운영] 이다 — 어느 탭도 안 켜지면 길을 잃는다 (#498)", () => {
    // 리그/원정이 [게임] 에 남는 것과 같은 관용구(SUB_ROUTES). 이 화면으로 가는 하단탭 칸이
    // 없어졌으므로 이게 없으면 활성 표시가 통째로 비어 "어디에 있는지" 신호가 사라진다.
    expect(activeNavKey("/event-board", navItemsFor(true))).toBe("admin");
    expect(activeNavKey("/admin", navItemsFor(true))).toBe("admin");
    // 비admin 항목 집합에서는 어느 탭도 활성이 아니다(그 화면에 갈 수 없다).
    expect(activeNavKey("/event-board", navItemsFor(false))).toBeNull();
  });
});

describe("navItemLocked (#286 경기 중 잠금)", () => {
  it("경기 중에는 홈 외 전부 잠긴다", () => {
    for (const key of ["game", "deck", "players", "recruit", "me"]) {
      expect(navItemLocked(key, true)).toBe(true);
    }
  });

  it("홈은 절대 잠그지 않는다 — 이어하기·포기·로그아웃의 유일한 자리다", () => {
    // 홈까지 잠그면 회수 가능한 사고 매치에서 탈출구가 사라진다(#217 AC3 와 같은 함정).
    expect(navItemLocked("home", true)).toBe(false);
  });

  it("경기 중이 아니면 아무것도 안 잠근다", () => {
    expect(navItemLocked("deck", false)).toBe(false);
    expect(navItemLocked("home", false)).toBe(false);
  });
});

describe("AppNav render (LLD §7)", () => {
  it("renders both a bottom tab bar (mobile) and a sidebar (desktop) — single source", () => {
    renderNav("/home");
    expect(screen.getByTestId("nav-bottom")).toBeTruthy();
    expect(screen.getByTestId("nav-sidebar")).toBeTruthy();
  });

  it("renders all 6 items (홈/게임/덱/선수/영입/내 정보) in each nav (#286)", () => {
    renderNav("/home");
    // ⚠️ 라벨은 **축약형**이다 — 홈 타일은 풀 네임("덱 구성")을 쓴다. 6칸에 풀
    // 네임은 390px 에서 들어가지 않아 의도적으로 갈라 뒀다(docs/plan-v5/home-nav.md §3.1).
    expect(NAV_ITEMS.map((i) => i.label)).toEqual(["홈", "게임", "덱", "선수", "영입", "내 정보"]);
    for (const nav of [screen.getByTestId("nav-bottom"), screen.getByTestId("nav-sidebar")]) {
      const scope = within(nav);
      for (const item of NAV_ITEMS) {
        expect(scope.getByTestId(`nav-${item.key}`)).toBeTruthy();
      }
    }
  });

  it("has no '준비중' items — 6탭 전부 활성", () => {
    renderNav("/home");
    const bottom = within(screen.getByTestId("nav-bottom"));
    for (const key of ["game", "recruit", "me"]) {
      const btn = bottom.getByTestId(`nav-${key}`);
      expect(btn.getAttribute("aria-disabled")).toBeNull();
    }
    expect(NAV_ITEMS.every((i) => !i.pending)).toBe(true);
  });

  it("육성 탭은 사라졌다 — 선수(도감)로 병합 (#286)", () => {
    renderNav("/home");
    expect(NAV_ITEMS.some((i) => i.key === "growth")).toBe(false);
    expect(within(screen.getByTestId("nav-bottom")).queryByTestId("nav-growth")).toBeNull();
  });

  it("marks the active item for the current route (aria-current=page)", () => {
    renderNav("/deck");
    const bottom = within(screen.getByTestId("nav-bottom"));
    expect(bottom.getByTestId("nav-deck").getAttribute("aria-current")).toBe("page");
    expect(bottom.getByTestId("nav-home").getAttribute("aria-current")).toBeNull();
  });
});
