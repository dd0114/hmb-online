import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * 공지 공유 딥링크 `/share/notice/{id}` E2E 계약 (#298, 에픽 #293).
 *
 * 축은 넷이다:
 *  ① **딥링크는 억제를 뚫는다** — 24h 숨김·닫기로 억제된 공지도 링크로 들어오면 열린다.
 *    그런데 **억제 저장소는 건드리지 않는다**(명시 요청은 "봤다"의 기록 대상이 아니다).
 *  ② **미로그인 딥링크가 목적지를 잃지 않는다** — 로그인 후 로비가 아니라 **원래 링크**로 돌아온다.
 *  ③ **복귀 경로는 오픈 리다이렉트가 아니다** — 외부/프로토콜 상대/비허용 경로는 로비로 폴백.
 *  ④ **없는/만료 공지에 흰 화면이 없다** — 안내 문구 + 하단 네비 생존 + 로비 이동(#274 부류 방지).
 *
 * ⚠️ 라우트 매칭은 **pathname 술어**로 한다(glob 은 vite 소스까지 잡아 흰 화면이 된다 — 프로젝트 기지식).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const DISMISSED_KEY = "hmb.notice.dismissed.v1";
const CLOSED_KEY = "hmb.notice.closed.v1";

function notice(id: string, over: Record<string, unknown> = {}) {
  return {
    id,
    revision: 1,
    title: `${id} 제목`,
    body: `${id} 본문입니다`,
    startsAt: null,
    endsAt: null,
    priority: 0,
    ...over,
  };
}

interface DeeplinkMock {
  /** `GET /api/notices/{id}` 응답. status 가 200 이 아니면 에러 봉투. */
  byId?: Record<string, { payload: unknown; status: number }>;
  /** 토큰을 심을지 — false 면 미로그인 진입. */
  authed?: boolean;
}

async function mockApp(page: Page, mock: DeeplinkMock) {
  if (mock.authed !== false) {
    await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
  }
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page);
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "u1", nickname: "감독님", tutorialDone: true },
        wallet: { points: 62000, gems: 120 },
        records: { wins: 3, draws: 1, losses: 2 },
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/me/active-match", (route) =>
    route.fulfill(json({ match: null, locked: false, abandonable: false })),
  );
  await page.route((url) => url.pathname === "/api/me/away-reports", (route) =>
    route.fulfill(json({ reports: [], summary: null, rating: 1200, unseen: 0 })),
  );
  await page.route((url) => url.pathname === "/api/notices/active", (route) =>
    route.fulfill(json({ notices: [] })),
  );
  // 게스트 로그인(AC2/AC3) — 캐치올 `{}` 면 토큰이 undefined 라 로그인이 성립하지 않는다.
  await page.route((url) => url.pathname === "/api/auth/login", (route) =>
    route.fulfill(json({ token: "tok_user", isNew: false, user: { id: "u1", nickname: "감독님" } })),
  );
  for (const [id, res] of Object.entries(mock.byId ?? {})) {
    await page.route(
      (url) => url.pathname === `/api/notices/${id}`,
      (route) => route.fulfill(json(res.payload, res.status)),
    );
  }
}

/** 억제 저장소 두 키의 현재 값 — 변화 여부를 문자열 그대로 비교한다. */
async function suppressionDump(page: Page) {
  return page.evaluate(
    ([dismissed, closed]) => ({
      dismissed: window.localStorage.getItem(dismissed),
      closed: window.sessionStorage.getItem(closed),
    }),
    [DISMISSED_KEY, CLOSED_KEY],
  );
}

/** 게스트 로그인 1회 통과 — provider 선택 → 닉네임 → 제출. */
async function loginAsGuest(page: Page) {
  await expect(page.getByTestId("provider-choose")).toBeVisible();
  await page.getByTestId("provider-guest").click();
  await page.locator("#nickname").fill("감독님");
  await page.getByRole("button", { name: "계속" }).click();
}

test.describe("#298 AC1 — 로그인 상태 딥링크", () => {
  test("억제된 공지도 딥링크로 열리고, 억제 저장소는 변하지 않는다", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await mockApp(page, {
      byId: {
        N1: { payload: notice("N1", { title: "정기 점검", body: "03:00 ~ 05:00" }), status: 200 },
      },
    });
    // **이미 24h 숨김 + 닫기로 억제된 상태**를 심는다 — 딥링크는 이걸 뚫어야 한다.
    await page.addInitScript(
      ([dismissed, closed]) => {
        window.localStorage.setItem(dismissed, JSON.stringify({ "N1@1": Date.now() + 86_400_000 }));
        window.sessionStorage.setItem(closed, JSON.stringify(["N1@1"]));
      },
      [DISMISSED_KEY, CLOSED_KEY],
    );

    await page.goto("/share/notice/N1");

    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-title")).toHaveText("정기 점검");
    await expect(page.getByTestId("notice-body")).toContainText("03:00 ~ 05:00");

    const before = await suppressionDump(page);
    // 심어 둔 억제가 그대로 살아 있다(딥링크가 뚫었을 뿐 지우지 않았다).
    expect(Object.keys(JSON.parse(before.dismissed!))).toEqual(["N1@1"]);
    expect(JSON.parse(before.closed!)).toEqual(["N1@1"]);

    // 닫아도 억제 저장소는 그대로다 — 명시 요청은 "봤다"를 기록하지 않는다.
    await page.getByTestId("notice-close").click();
    await expect(page).toHaveURL(/\/lobby$/);
    const after = await suppressionDump(page);
    expect(after).toEqual(before);

    expect(errors, "렌더 중 예외 0").toEqual([]);
  });

  test("딥링크 팝업에는 [24시간 안 보기]가 없다 — 억제 개념이 걸리지 않는다", async ({ page }) => {
    await mockApp(page, { byId: { N1: { payload: notice("N1"), status: 200 } } });
    await page.goto("/share/notice/N1");
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-dismiss-24h")).toHaveCount(0);
    await expect(page.getByTestId("notice-close")).toBeVisible();
  });
});

test.describe("#298 AC2 — 미로그인 딥링크 → 로그인 → 원래 링크 복귀", () => {
  test("로그인 후 로비가 아니라 딥링크로 돌아온다 (쿼리 보존)", async ({ page }) => {
    await mockApp(page, {
      authed: false,
      byId: { N2: { payload: notice("N2", { title: "신규 유닛" }), status: 200 } },
    });

    await page.goto("/share/notice/N2?from=kakao");
    // 목적지를 잃지 않았다 — 로그인 URL 이 복귀 경로를 들고 있다.
    await expect(page).toHaveURL(/\/login\?returnTo=/);
    expect(decodeURIComponent(page.url())).toContain("/share/notice/N2?from=kakao");

    await loginAsGuest(page);

    // 로비 착지가 아니라 원래 딥링크로 복귀 — 쿼리까지 그대로다.
    await expect(page).toHaveURL(/\/share\/notice\/N2\?from=kakao$/);
    await expect(page.getByTestId("notice-popup")).toBeVisible();
    await expect(page.getByTestId("notice-title")).toHaveText("신규 유닛");
  });
});

test.describe("#298 AC3 — 오픈 리다이렉트 차단", () => {
  const hostile = [
    { name: "외부 절대 URL", raw: "https://evil.test/share/notice/N1" },
    { name: "프로토콜 상대", raw: "//evil.test" },
    { name: "비허용 내부 경로", raw: "/nope/deep" },
  ];

  for (const c of hostile) {
    test(`${c.name} → 로비로 폴백한다`, async ({ page }) => {
      await mockApp(page, { authed: false });
      await page.goto(`/login?returnTo=${encodeURIComponent(c.raw)}`);
      await loginAsGuest(page);

      await expect(page).toHaveURL(/\/lobby$/);
      // 외부 오리진으로 나가지 않았다.
      expect(new URL(page.url()).hostname).toBe("localhost");
    });
  }
});

test.describe("#298 AC4 — 없는·만료 공지에 흰 화면 0", () => {
  const cases = [
    {
      name: "410 만료",
      status: 410,
      payload: { code: "GONE", message: "expired" },
      copy: "기간이 지난 공지입니다",
      state: "gone",
    },
    {
      name: "404 없는 id",
      status: 404,
      payload: { code: "NOT_FOUND", message: "no" },
      copy: "찾을 수 없는 공지입니다",
      state: "notfound",
    },
    {
      // #274 부류 — 200 인데 모양이 아니다. 여기서 흰 화면이 나면 안 된다.
      name: "200 인데 빈 객체",
      status: 200,
      payload: {},
      copy: "찾을 수 없는 공지입니다",
      state: "notfound",
    },
  ];

  for (const c of cases) {
    test(`${c.name} → 안내 문구 + 하단 네비 생존 + 로비 이동`, async ({ page }) => {
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(String(e)));
      await mockApp(page, { byId: { NX: { payload: c.payload, status: c.status } } });

      await page.goto("/share/notice/NX");

      const msg = page.getByTestId("share-notice-message");
      await expect(msg).toBeVisible();
      await expect(msg).toContainText(c.copy);
      await expect(msg).toHaveAttribute("data-state", c.state);

      // 팝업은 열리지 않는다(빈 모달 금지).
      await expect(page.getByTestId("notice-popup")).toHaveCount(0);
      // 하단 네비가 살아 있다 = 막다른 길이 아니다.
      await expect(page.getByTestId("nav-bottom")).toBeVisible();
      // 화면이 비어 있지 않다.
      const text = (await page.evaluate(() => document.body.innerText)).trim();
      expect(text.length, "body 텍스트가 비지 않는다").toBeGreaterThan(0);

      // 로비로 나갈 수 있다.
      await page.getByTestId("share-notice-to-lobby").click();
      await expect(page).toHaveURL(/\/lobby$/);

      expect(errors, "JS 에러 0").toEqual([]);
    });
  }

  test("410 과 404 의 문구가 서로 다르다", async ({ page }) => {
    await mockApp(page, {
      byId: {
        NG: { payload: { code: "GONE", message: "expired" }, status: 410 },
        NF: { payload: { code: "NOT_FOUND", message: "no" }, status: 404 },
      },
    });
    await page.goto("/share/notice/NG");
    const gone = await page.getByTestId("share-notice-message").innerText();
    await page.goto("/share/notice/NF");
    const notFound = await page.getByTestId("share-notice-message").innerText();
    expect(gone).not.toBe(notFound);
  });
});
