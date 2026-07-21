import { expect, test, type Page } from "@playwright/test";

/**
 * Phase3 admin 페이지 route-mock E2E (PRD-v4 §C, AC-C1/AC-C2).
 *
 * server-java(p3srv) 의 admin API 가 미완이라 **백엔드 없이** vite dev + page.route 로
 * `src/api/p3.ts` admin 계약(잠정 SoT)을 그대로 목킹해 web 측 계약을 박제한다.
 * 라이브 왕복은 서버 발행 후 통합 게이트에서 별도.
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다. glob('**\/api\/**')는 vite 소스 /src/api/*.ts 까지
 * 잡아 모듈 로딩을 깨고 흰 화면이 된다(프로젝트 기지식).
 */

interface AdminUserRow {
  userId: string;
  nickname: string;
  provider: string;
  points: number;
  wins: number;
  draws: number;
  losses: number;
  createdAt: string;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  actor: string;
  createdAt: string;
}

interface MockState {
  isAdmin: boolean;
  /** true 면 admin API 만 403 — 클라 가드를 우회해 들어온 상황(AC-C2 서버 게이트). */
  forbidAdminApi: boolean;
  users: AdminUserRow[];
  ledger: Record<string, LedgerEntry[]>;
  seq: number;
}

function freshState(): MockState {
  return {
    isAdmin: true,
    forbidAdminApi: false,
    users: [
      { userId: "u1", nickname: "테스터A", provider: "local", points: 1200, wins: 3, draws: 1, losses: 2, createdAt: "2026-07-01T09:00:00Z" },
      { userId: "u2", nickname: "테스터B", provider: "guest", points: 50, wins: 0, draws: 0, losses: 1, createdAt: "2026-07-02T09:00:00Z" },
      { userId: "u3", nickname: "관리자", provider: "local", points: 999, wins: 1, draws: 0, losses: 0, createdAt: "2026-07-03T09:00:00Z" },
    ],
    ledger: {
      u1: [
        { id: "L1", delta: 1000, reason: "가입 보너스", actor: "system", createdAt: "2026-07-01T09:05:00Z" },
      ],
      u2: [],
      u3: [],
    },
    seq: 100,
  };
}

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const forbidden = () =>
  json({ code: "FORBIDDEN", message: "운영자 전용 API 입니다", detail: null }, 403);

async function mockApi(page: Page, state: MockState) {
  // catch-all 먼저 — Playwright 는 나중에 등록한 핸들러가 우선이므로 구체 라우트는 뒤에 온다.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );

  await page.route(
    (url) => url.pathname === "/api/me",
    (route) => {
      const me = state.users[2]!;
      return route.fulfill(
        json({
          // isAdmin 은 Phase3 additive — 비admin 케이스에선 **필드 자체를 넣지 않는다**(부재=비admin).
          user: state.isAdmin
            ? { id: me.userId, nickname: me.nickname, isAdmin: true }
            : { id: "u2", nickname: "테스터B" },
          wallet: { points: state.isAdmin ? me.points : 50 },
          records: { wins: 1, draws: 0, losses: 0 },
        }),
      );
    },
  );

  await page.route(
    (url) => url.pathname === "/api/admin/users",
    (route) => {
      if (state.forbidAdminApi) return route.fulfill(forbidden());
      const q = new URL(route.request().url()).searchParams.get("q")?.trim().toLowerCase() ?? "";
      const users = q
        ? state.users.filter(
            (u) => u.nickname.toLowerCase().includes(q) || u.userId.toLowerCase().includes(q),
          )
        : state.users;
      return route.fulfill(json({ users }));
    },
  );

  await page.route(
    (url) => /^\/api\/admin\/users\/[^/]+$/.test(url.pathname),
    (route) => {
      if (state.forbidAdminApi) return route.fulfill(forbidden());
      const id = new URL(route.request().url()).pathname.split("/").pop()!;
      const user = state.users.find((u) => u.userId === id);
      if (!user) return route.fulfill(json({ code: "NOT_FOUND", message: "no user" }, 404));
      return route.fulfill(
        json({
          user,
          ownedPlayers: 34,
          deckFormation: "4-3-3",
          deckStarters: 11,
          recentLedger: state.ledger[id] ?? [],
        }),
      );
    },
  );

  await page.route(
    (url) => /^\/api\/admin\/users\/[^/]+\/points$/.test(url.pathname),
    (route) => {
      if (state.forbidAdminApi) return route.fulfill(forbidden());
      const id = new URL(route.request().url()).pathname.split("/").slice(-2)[0]!;
      const body = route.request().postDataJSON() as { delta: number; reason: string };
      const user = state.users.find((u) => u.userId === id)!;
      user.points += body.delta;
      const entry: LedgerEntry = {
        id: `L${++state.seq}`,
        delta: body.delta,
        reason: body.reason,
        actor: "관리자",
        createdAt: "2026-07-20T12:00:00Z",
      };
      state.ledger[id] = [entry, ...(state.ledger[id] ?? [])];
      return route.fulfill(json({ userId: id, points: user.points, entry }));
    },
  );
}

async function seedToken(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
}

test.describe("Phase3 admin (route-mock)", () => {
  test("(a) 비admin 토큰으로 /admin 직접 진입 → /lobby 리다이렉트, admin 화면 노출 0", async ({ page }) => {
    const state = freshState();
    state.isAdmin = false; // /api/me 에 isAdmin 필드 없음
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/admin");
    await page.waitForURL("**/lobby");
    await expect(page.getByTestId("admin-page")).toHaveCount(0);
    // 네비의 운영 진입점도 비admin 에겐 DOM 에 없다.
    await expect(page.getByTestId("nav-admin")).toHaveCount(0);
  });

  test("(a2) 미로그인 상태로 /admin → /login", async ({ page }) => {
    await mockApi(page, freshState());
    await page.goto("/admin");
    await page.waitForURL("**/login");
    await expect(page.getByTestId("admin-page")).toHaveCount(0);
  });

  test("(b) admin: 목록 렌더 + 검색 필터 + 모바일 가로 오버플로 0", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);
    await page.setViewportSize({ width: 390, height: 844 });

    await page.goto("/admin");
    await expect(page.getByTestId("admin-page")).toBeVisible();
    await expect(page.getByTestId("admin-user-row-u1")).toBeVisible();
    await expect(page.getByTestId("admin-user-row-u2")).toBeVisible();
    await expect(page.getByTestId("admin-user-row-u3")).toBeVisible();
    await expect(page.getByTestId("admin-user-row-u1")).toContainText("테스터A");
    await expect(page.getByTestId("admin-user-row-u1")).toContainText("3승 1무 2패");

    // 검색: 닉네임 부분일치.
    await page.getByTestId("admin-search").fill("테스터B");
    await expect(page.getByTestId("admin-user-row-u2")).toBeVisible();
    await expect(page.getByTestId("admin-user-row-u1")).toHaveCount(0);

    // 아이디로도 검색된다.
    await page.getByTestId("admin-search").fill("u3");
    await expect(page.getByTestId("admin-user-row-u3")).toBeVisible();
    await page.getByTestId("admin-search").fill("");
    await expect(page.getByTestId("admin-user-row-u1")).toBeVisible();

    // 표는 컨테이너 안에서만 스크롤 — body 가로 오버플로 0.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - window.innerWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    // admin 계정에는 네비 운영 진입점이 보인다.
    await expect(page.getByTestId("nav-admin").first()).toBeAttached();
  });

  test("(c) 포인트 지급/차감 → 지갑·원장 즉시 반영, 사유 없으면 제출 불가, 큰 값은 확인 모달", async ({ page }) => {
    const state = freshState();
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/admin");
    await page.getByTestId("admin-user-select-u1").click();
    await expect(page.getByTestId("admin-user-detail")).toBeVisible();
    await expect(page.getByTestId("admin-detail-points")).toHaveText("1,200");
    await expect(page.getByTestId("admin-ledger")).toContainText("가입 보너스");

    // 사유가 비면 제출 불가(감사 로그 공백 방지, AC-C1).
    await page.getByTestId("admin-grant-delta").fill("500");
    await expect(page.getByTestId("admin-grant-submit")).toBeDisabled();

    // 지급.
    await page.getByTestId("admin-grant-reason").fill("충전 요청 수동 처리");
    await expect(page.getByTestId("admin-grant-submit")).toBeEnabled();
    await page.getByTestId("admin-grant-submit").click();

    // 지갑 즉시 반영(invalidate) + 원장에 actor/사유 기록.
    await expect(page.getByTestId("admin-detail-points")).toHaveText("1,700");
    await expect(page.getByTestId("admin-ledger")).toContainText("충전 요청 수동 처리");
    await expect(page.getByTestId("admin-ledger")).toContainText("관리자");
    await expect(page.getByTestId("admin-ledger")).toContainText("+500");
    await expect(page.getByTestId("admin-grant-notice")).toContainText("+500");

    // 차감(음수).
    await page.getByTestId("admin-grant-delta").fill("-200");
    await page.getByTestId("admin-grant-reason").fill("오지급 회수");
    await page.getByTestId("admin-grant-submit").click();
    await expect(page.getByTestId("admin-detail-points")).toHaveText("1,500");
    await expect(page.getByTestId("admin-ledger")).toContainText("오지급 회수");

    // 큰 값(|delta| > 100000)은 확인 모달을 거친다 — 취소하면 아무 변화 없음.
    await page.getByTestId("admin-grant-delta").fill("100001");
    await page.getByTestId("admin-grant-reason").fill("대량 지급");
    await page.getByTestId("admin-grant-submit").click();
    await expect(page.getByTestId("admin-grant-confirm")).toBeVisible();
    await page.getByTestId("admin-grant-confirm-cancel").click();
    await expect(page.getByTestId("admin-grant-confirm")).toHaveCount(0);
    await expect(page.getByTestId("admin-detail-points")).toHaveText("1,500");

    // 확인하면 적용된다.
    await page.getByTestId("admin-grant-submit").click();
    await page.getByTestId("admin-grant-confirm-ok").click();
    await expect(page.getByTestId("admin-detail-points")).toHaveText("101,501");
  });

  test("(d) 서버 403(AC-C2) → 안내 노출 후 /lobby", async ({ page }) => {
    const state = freshState();
    state.isAdmin = true; // 클라 가드는 통과 — 서버 게이트만 거부(가드 우회 상황)
    state.forbidAdminApi = true;
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/admin");
    await expect(page.getByTestId("admin-forbidden")).toBeVisible();
    // 운영 데이터는 전혀 그리지 않는다.
    await expect(page.getByTestId("admin-users")).toHaveCount(0);
    await expect(page.getByTestId("admin-grant-form")).toHaveCount(0);
    // 안내 후 자동으로 로비로.
    await page.waitForURL("**/lobby");
  });
});
