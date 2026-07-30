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
  id: string;
  nickname: string;
  authProvider: string;
  isAdmin: boolean;
  points: number;
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
    // ⚠️ **서버가 실제로 주는 모양**이다(#342). 예전엔 `{userId, provider, wins…}` 였는데 서버는
    //    `{id, authProvider, isAdmin, points, createdAt}` 를 준다 — 목이 거짓이라 **화면이 라이브에서
    //    통째로 비어 있는데도** 이 e2e 가 green 이었다. 목은 계약의 일부다.
    users: [
      { id: "u1", nickname: "테스터A", authProvider: "local", isAdmin: false, points: 1200, createdAt: "2026-07-01T09:00:00Z" },
      { id: "u2", nickname: "테스터B", authProvider: "guest", isAdmin: false, points: 50, createdAt: "2026-07-02T09:00:00Z" },
      { id: "u3", nickname: "관리자", authProvider: "local", isAdmin: true, points: 999, createdAt: "2026-07-03T09:00:00Z" },
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
            (u) => u.nickname.toLowerCase().includes(q) || u.id.toLowerCase().includes(q),
          )
        : state.users;
      // 서버는 **페이지 객체**를 준다 — `{users:[…]}` 가 아니다(#342).
      return route.fulfill(json({ items: users, total: users.length, limit: 50, offset: 0 }));
    },
  );

  await page.route(
    (url) => /^\/api\/admin\/users\/[^/]+$/.test(url.pathname),
    (route) => {
      if (state.forbidAdminApi) return route.fulfill(forbidden());
      const id = new URL(route.request().url()).pathname.split("/").pop()!;
      const user = state.users.find((u) => u.id === id);
      if (!user) return route.fulfill(json({ code: "NOT_FOUND", message: "no user" }, 404));
      // 상세도 서버 모양 그대로: players{distinct,total} · deck(null 가능) · presets · records.
      // ⚠️ `recentLedger` 는 **서버에 없다** — 목이 그걸 주던 탓에 화면의 원장 표가 살아 있었다(#342).
      return route.fulfill(
        json({
          user,
          players: { distinct: 34, total: 41 },
          deck: { id: "d1", name: "기본 덱", formation: "4-3-3", starters: 11, bench: 2,
                  updatedAt: "2026-07-19T09:00:00Z" },
          presets: { promptPresets: 2, teamPresets: 1 },
          records: { wins: 3, draws: 1, losses: 2 },
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
      const user = state.users.find((u) => u.id === id)!;
      user.points += body.delta;
      // ⚠️ 서버 모양 그대로(`AdminPointsService.GrantResult`) — 예전 목은 `{points, entry}` 였고
      //    그 거짓 때문에 "지급 직후 화면이 터진다"를 아무도 못 봤다(#342).
      state.seq += 1;
      return route.fulfill(
        json({
          userId: id,
          delta: body.delta,
          applied: true,
          balance: user.points,
          idempotencyKey: `IDEM${state.seq}`,
          auditId: `A${state.seq}`,
        }),
      );
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
  test("(a) 비admin 토큰으로 /admin 직접 진입 → /home 리다이렉트, admin 화면 노출 0", async ({ page }) => {
    const state = freshState();
    state.isAdmin = false; // /api/me 에 isAdmin 필드 없음
    await mockApi(page, state);
    await seedToken(page);

    await page.goto("/admin");
    await page.waitForURL("**/home");
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
    // ⚠️ 전적 열은 **없다** — 서버 행에 wins/draws/losses 가 없다(#342). 전적은 상세에서 본다.
    await expect(page.getByTestId("admin-user-row-u1")).toContainText("local");
    await expect(page.getByTestId("admin-user-row-u1")).not.toContainText("승");

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
    // ⚠️ 원장 표는 **없다** — 서버가 안 주므로 화면에서 뺐다(#342). 있는 척 그리면 "지급 이력
    //    없음"이라는 거짓이 된다. 지급 결과는 아래 지갑 숫자와 notice 로 확인한다.
    await expect(page.getByTestId("admin-ledger")).toHaveCount(0);
    await expect(page.getByTestId("admin-detail-record")).toContainText("3승");

    // 사유가 비면 제출 불가(감사 로그 공백 방지, AC-C1).
    await page.getByTestId("admin-grant-delta").fill("500");
    await expect(page.getByTestId("admin-grant-submit")).toBeDisabled();

    // 지급.
    await page.getByTestId("admin-grant-reason").fill("충전 요청 수동 처리");
    await expect(page.getByTestId("admin-grant-submit")).toBeEnabled();
    await page.getByTestId("admin-grant-submit").click();

    // 지갑 즉시 반영(invalidate) + 결과 문구.
    await expect(page.getByTestId("admin-detail-points")).toHaveText("1,700");
    await expect(page.getByTestId("admin-grant-notice")).toContainText("+500");

    // 차감(음수).
    await page.getByTestId("admin-grant-delta").fill("-200");
    await page.getByTestId("admin-grant-reason").fill("오지급 회수");
    await page.getByTestId("admin-grant-submit").click();
    await expect(page.getByTestId("admin-detail-points")).toHaveText("1,500");
    // 화면은 유니코드 마이너스(−)를 쓴다(`formatSignedDelta`) — ASCII 하이픈으로 찾으면 못 만난다.
    await expect(page.getByTestId("admin-grant-notice")).toContainText("−200");

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

  test("(d) 서버 403(AC-C2) → 안내 노출 후 /home", async ({ page }) => {
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
    await page.waitForURL("**/home");
  });
});
