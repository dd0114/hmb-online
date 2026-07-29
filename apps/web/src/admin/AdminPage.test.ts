// @vitest-environment jsdom
/**
 * admin 렌더 계약 (PRD-v4 §C) — 훅은 wholesale mock, 화면 계약만 본다:
 * (1) RequireAdmin 가드 3분기(비admin 노출 0), (2) 목록·검색 렌더, (3) 사유 없으면 제출 불가,
 * (4) 큰 값 확인 모달 경유, (5) 403 → 안내 배너(리다이렉트 트리거).
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../api/client";
import type { AdminUserDetail, AdminUserListResponse } from "../api/p3";

const fx = {
  token: "t" as string | null,
  me: { isLoading: false, isError: false, user: undefined as { isAdmin?: boolean } | undefined },
  list: { data: undefined as AdminUserListResponse | undefined, isLoading: false, isError: false, error: null as unknown },
  detail: { data: undefined as AdminUserDetail | undefined, isLoading: false, isError: false, error: null as unknown },
  grantError: null as unknown,
  mutate: vi.fn(),
  lastQuery: "" as string,
};

vi.mock("../auth/TokenContext", () => ({
  useToken: () => ({ token: fx.token, logout: vi.fn(), provider: "local" }),
}));

vi.mock("../api/admin-hooks", () => ({
  useAdminMe: () => ({ isLoading: fx.me.isLoading, isError: fx.me.isError, user: fx.me.user }),
  useAdminUsers: (q: string) => {
    fx.lastQuery = q;
    return fx.list;
  },
  useAdminUserDetail: () => fx.detail,
  useGrantPoints: () => ({ mutate: fx.mutate, isPending: false, error: fx.grantError }),
  // #209 B안 패널이 페이지에 붙었다. 이 파일의 주제는 **유저 운영**이므로 economy 훅은
  // 비어 있는 상태로만 준다(패널 자체의 동작은 economy-logic.test + e2e 가 본다).
  useAdminEconomy: () => ({ data: undefined, isLoading: false }),
  useAdminEconomyHistory: () => ({ data: [] }),
  useEconomyOps: () => ({
    replaceStarterTop: { mutate: vi.fn(), isPending: false },
    reload: { mutate: vi.fn(), isPending: false },
    clearOverride: { mutate: vi.fn(), isPending: false },
  }),
}));

// 유닛 카탈로그 섹션(#207)은 자체 훅 모듈을 쓴다 — 여기선 렌더만 확인하므로 전부 스텁.
vi.mock("../api/admin-unit-hooks", () => ({
  ADMIN_UNITS_PATH: "/api/admin/units",
  newIdempotencyKey: () => "key-1",
  useAdminUnits: () => ({ data: undefined, isLoading: false, isError: false }),
  useAdminUnitDetail: () => ({ data: undefined, isLoading: false, isError: false }),
  useUpdateUnit: () => ({ mutate: vi.fn(), isPending: false }),
  useCreateUnit: () => ({ mutate: vi.fn(), isPending: false }),
  useSetUnitActive: () => ({ mutate: vi.fn(), isPending: false }),
}));

import { AdminPage } from "./AdminPage";
import { RequireAdmin } from "./RequireAdmin";

const USERS: AdminUserListResponse = {
  users: [
    { userId: "u1", nickname: "테스터A", provider: "local", points: 1200, wins: 3, draws: 1, losses: 2, createdAt: "2026-07-01T00:00:00Z" },
    { userId: "u2", nickname: "테스터B", provider: "guest", points: 0, wins: 0, draws: 0, losses: 0, createdAt: "2026-07-02T00:00:00Z" },
  ],
};

const DETAIL: AdminUserDetail = {
  user: USERS.users[0]!,
  ownedPlayers: 34,
  deckFormation: "4-3-3",
  deckStarters: 11,
  recentLedger: [
    { id: "L1", delta: 500, reason: "충전 요청 수동 처리", actor: "admin", createdAt: "2026-07-19T09:00:00Z" },
    { id: "L2", delta: -200, reason: "오지급 회수", actor: "admin", createdAt: "2026-07-19T10:00:00Z" },
  ],
};

/** RequireAdmin 을 실제 라우트에 물려 리다이렉트 목적지까지 관측한다. */
function renderGuarded(initial = "/admin") {
  return render(
    h(
      MemoryRouter,
      { initialEntries: [initial] },
      h(
        Routes,
        null,
        h(Route, { path: "/login", element: h("div", { "data-testid": "at-login" }) }),
        h(Route, { path: "/home", element: h("div", { "data-testid": "at-lobby" }) }),
        h(Route, {
          path: "/admin",
          element: h(RequireAdmin, null, h("div", { "data-testid": "admin-child" })),
        }),
      ),
    ),
  );
}

function renderPage() {
  return render(h(MemoryRouter, { initialEntries: ["/admin"] }, h(AdminPage)));
}

beforeEach(() => {
  fx.token = "t";
  fx.me = { isLoading: false, isError: false, user: { isAdmin: true } };
  fx.list = { data: USERS, isLoading: false, isError: false, error: null };
  fx.detail = { data: DETAIL, isLoading: false, isError: false, error: null };
  fx.grantError = null;
  fx.mutate = vi.fn();
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("RequireAdmin 가드 (AC-C2 클라 측)", () => {
  it("미로그인 → /login", () => {
    fx.token = null;
    renderGuarded();
    expect(screen.getByTestId("at-login")).toBeTruthy();
    expect(screen.queryByTestId("admin-child")).toBeNull();
  });

  it("로그인 + 비admin → /home, admin 화면 노출 0", () => {
    fx.me.user = { isAdmin: false };
    renderGuarded();
    expect(screen.getByTestId("at-lobby")).toBeTruthy();
    expect(screen.queryByTestId("admin-child")).toBeNull();
  });

  it("isAdmin 필드가 아예 없는 응답(구 서버)도 비admin 취급 → /home", () => {
    fx.me.user = {};
    renderGuarded();
    expect(screen.getByTestId("at-lobby")).toBeTruthy();
    expect(screen.queryByTestId("admin-child")).toBeNull();
  });

  it("me 로딩 중에는 admin 화면도 리다이렉트도 아직 없다", () => {
    fx.me = { isLoading: true, isError: false, user: undefined };
    renderGuarded();
    expect(screen.getByTestId("admin-guard-pending")).toBeTruthy();
    expect(screen.queryByTestId("admin-child")).toBeNull();
    expect(screen.queryByTestId("at-lobby")).toBeNull();
  });

  it("admin 이면 통과", () => {
    renderGuarded();
    expect(screen.getByTestId("admin-child")).toBeTruthy();
  });
});

describe("AdminPage 목록·검색", () => {
  it("유저 표를 행 testid 로 렌더한다", () => {
    renderPage();
    expect(screen.getByTestId("admin-page")).toBeTruthy();
    expect(screen.getByTestId("admin-user-row-u1")).toBeTruthy();
    expect(screen.getByTestId("admin-user-row-u2")).toBeTruthy();
    expect(screen.getByTestId("admin-user-row-u1").textContent).toContain("테스터A");
    expect(screen.getByTestId("admin-user-row-u1").textContent).toContain("3승 1무 2패");
  });

  it("검색어 입력이 (디바운스 후) 질의로 전달된다", async () => {
    vi.useFakeTimers();
    try {
      renderPage();
      fireEvent.change(screen.getByTestId("admin-search"), { target: { value: "테스터B" } });
      await vi.advanceTimersByTimeAsync(400);
    } finally {
      vi.useRealTimers();
    }
    expect(fx.lastQuery).toBe("테스터B");
  });

  it("빈 결과는 안내 문구", () => {
    fx.list = { data: { users: [] }, isLoading: false, isError: false, error: null };
    renderPage();
    expect(screen.getByTestId("admin-users-empty")).toBeTruthy();
  });
});

describe("AdminPage 포인트 지급/차감 (AC-C1)", () => {
  function selectUser() {
    fireEvent.click(screen.getByTestId("admin-user-select-u1"));
  }

  it("유저를 고르면 상세·원장이 뜬다", () => {
    renderPage();
    selectUser();
    expect(screen.getByTestId("admin-user-detail")).toBeTruthy();
    expect(screen.getByTestId("admin-detail-owned").textContent).toBe("34");
    expect(screen.getByTestId("admin-detail-formation").textContent).toBe("4-3-3");
    const ledger = screen.getByTestId("admin-ledger");
    expect(ledger.textContent).toContain("충전 요청 수동 처리");
    expect(ledger.textContent).toContain("admin");
    expect(screen.getByTestId("admin-ledger-row-L2").textContent).toContain("−200");
  });

  it("사유가 비면 제출 불가", () => {
    renderPage();
    selectUser();
    fireEvent.change(screen.getByTestId("admin-grant-delta"), { target: { value: "500" } });
    expect((screen.getByTestId("admin-grant-submit") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByTestId("admin-grant-reason"), { target: { value: "충전 대응" } });
    expect((screen.getByTestId("admin-grant-submit") as HTMLButtonElement).disabled).toBe(false);
  });

  it("정상 제출 → mutate 에 delta/사유 전달, 확인 모달 없음", () => {
    renderPage();
    selectUser();
    fireEvent.change(screen.getByTestId("admin-grant-delta"), { target: { value: "-300" } });
    fireEvent.change(screen.getByTestId("admin-grant-reason"), { target: { value: "오지급 회수" } });
    fireEvent.click(screen.getByTestId("admin-grant-submit"));
    expect(screen.queryByTestId("admin-grant-confirm")).toBeNull();
    expect(fx.mutate).toHaveBeenCalledTimes(1);
    expect(fx.mutate.mock.calls[0]![0]).toEqual({
      userId: "u1",
      body: { delta: -300, reason: "오지급 회수" },
    });
  });

  it("|delta| > 100000 은 확인 모달을 거쳐야 mutate 된다", () => {
    renderPage();
    selectUser();
    fireEvent.change(screen.getByTestId("admin-grant-delta"), { target: { value: "100001" } });
    fireEvent.change(screen.getByTestId("admin-grant-reason"), { target: { value: "대량 지급" } });
    fireEvent.click(screen.getByTestId("admin-grant-submit"));
    expect(fx.mutate).not.toHaveBeenCalled();
    expect(screen.getByTestId("admin-grant-confirm")).toBeTruthy();

    fireEvent.click(screen.getByTestId("admin-grant-confirm-ok"));
    expect(fx.mutate).toHaveBeenCalledTimes(1);
    expect(fx.mutate.mock.calls[0]![0].body).toEqual({ delta: 100001, reason: "대량 지급" });
  });

  it("확인 모달 취소는 아무것도 보내지 않는다", () => {
    renderPage();
    selectUser();
    fireEvent.change(screen.getByTestId("admin-grant-delta"), { target: { value: "-999999" } });
    fireEvent.change(screen.getByTestId("admin-grant-reason"), { target: { value: "회수" } });
    fireEvent.click(screen.getByTestId("admin-grant-submit"));
    fireEvent.click(screen.getByTestId("admin-grant-confirm-cancel"));
    expect(fx.mutate).not.toHaveBeenCalled();
    expect(screen.queryByTestId("admin-grant-confirm")).toBeNull();
  });
});

describe("AdminPage 섹션 탭 (#207 유닛 카탈로그)", () => {
  it("기본은 유저 운영 — 유닛 섹션은 아직 없다(기존 화면 무회귀)", () => {
    renderPage();
    expect(screen.getByTestId("admin-users")).toBeTruthy();
    expect(screen.queryByTestId("admin-units")).toBeNull();
  });

  it("유닛 카탈로그 탭으로 전환하면 유저 섹션 대신 유닛 섹션이 뜬다", () => {
    renderPage();
    fireEvent.click(screen.getByTestId("admin-tab-units"));
    expect(screen.getByTestId("admin-units")).toBeTruthy();
    expect(screen.queryByTestId("admin-users")).toBeNull();
    expect(screen.queryByTestId("admin-search")).toBeNull();
  });
});

describe("AdminPage 서버 403 (AC-C2)", () => {
  it("목록 403 → 데이터 화면 대신 안내만 노출", () => {
    fx.list = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(403, { code: "FORBIDDEN", message: "admin only" }),
    };
    renderPage();
    expect(screen.getByTestId("admin-forbidden")).toBeTruthy();
    expect(screen.queryByTestId("admin-page")).toBeNull();
    expect(screen.queryByTestId("admin-users")).toBeNull();
  });

  it("403 이 아닌 오류는 페이지를 유지하고 인라인 안내만", () => {
    fx.list = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new ApiError(500, { code: "INTERNAL_ERROR", message: "boom" }),
    };
    renderPage();
    expect(screen.queryByTestId("admin-forbidden")).toBeNull();
    expect(screen.getByTestId("admin-page")).toBeTruthy();
  });
});
