import { expect, test, type Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #473 캡처 — **라이브 공지 본문을 그대로** 폰 화면에 띄워 두 가지를 눈으로 본다.
 *
 *  ① 석다이크 "here we go" 공지에 히어로 이미지(증명사진)가 실제로 그려지는가
 *  ② [닫기] 하나 + 억제 안내 한 줄이 첫 화면 안에 있는가
 *
 * ⚠️ **본문을 지어내지 않는다.** 운영 백엔드(`HMB_API`, 기본 로컬 18080)의 `/api/notices/active`
 * 를 그대로 받아 목으로 흘리고, 본문이 참조하는 자산 바이트도 같은 서버에서 프록시한다 —
 * 목이 실제와 다른 모양을 흉내내면 그 캡처는 자기가 만든 화면을 찍는다(#342 의 교훈).
 * 백엔드가 없으면 **스킵**한다(거짓 초록보다 낫다).
 *
 * 실행:
 *   cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts
 */
const API = process.env.HMB_API ?? "http://localhost:18080";
const OUT = "test-results/p473";

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function liveNotices(): Promise<unknown | null> {
  try {
    const res = await fetch(`${API}/api/notices/active`, { signal: AbortSignal.timeout(4000) });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

async function mockHome(page: Page, notices: unknown) {
  await page.addInitScript(() => window.localStorage.setItem("hmb.auth.token", "tok_user"));
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
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/notices/active", (route) =>
    route.fulfill(json(notices)),
  );
  // 자산은 **실제 바이트**를 흘린다 — 더미를 넣으면 "이미지가 뜬다"가 공허해진다(#292 선례).
  await page.route(
    (url) => url.pathname.startsWith("/api/notices/assets/"),
    async (route, request) => {
      const res = await fetch(API + new URL(request.url()).pathname);
      route.fulfill({
        status: res.status,
        contentType: res.headers.get("content-type") ?? "image/webp",
        body: Buffer.from(await res.arrayBuffer()),
      });
    },
  );
}

test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

test("#473 — 라이브 공지 팝업(히어로 이미지 + 닫기 하나)", async ({ page }) => {
  const notices = await liveNotices();
  test.skip(notices === null, `백엔드(${API})가 없어 라이브 본문을 못 받았다`);

  await mockHome(page, notices);
  await page.goto("/home");
  await expect(page.getByTestId("home-page")).toBeVisible();
  await expect(page.getByTestId("notice-popup")).toBeVisible();

  // 첫 장이 석다이크가 아니면(우선순위/기간이 바뀌면) 그 장까지 넘긴다.
  for (let i = 0; i < 6; i++) {
    if ((await page.getByTestId("notice-title").innerText()).includes("석다이크")) break;
    await page.getByTestId("notice-close").click();
  }
  await expect(page.getByTestId("notice-title")).toContainText("석다이크");

  const img = page.getByTestId("notice-image").first();
  await expect(img).toBeVisible();
  // 깨진 이미지는 `toBeVisible()` 을 통과한다 — 실제로 디코드됐는지를 본다.
  const drawn = await img.evaluate((el) => {
    const i = el as HTMLImageElement;
    return { complete: i.complete, w: i.naturalWidth, h: i.naturalHeight };
  });
  expect(drawn.w).toBeGreaterThan(0);
  console.log(`[p473] hero image natural = ${drawn.w}x${drawn.h}`);

  await expect(page.getByTestId("notice-dismiss-hint")).toBeVisible();
  await expect(page.getByTestId("notice-close")).toBeVisible();
  await expect(page.getByTestId("notice-dismiss-24h")).toHaveCount(0);

  await page.screenshot({ path: `${OUT}/popup-390x844.png` });

  // 본문 끝(이미지 아래 문단)까지 내려 하단 크롬이 계속 화면 안인지 같이 본다.
  await page.getByTestId("notice-body").evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await page.screenshot({ path: `${OUT}/popup-390x844-scrolled.png` });

  const hint = (await page.getByTestId("notice-dismiss-hint").boundingBox())!;
  console.log(`[p473] hint bottom = ${Math.round(hint.y + hint.height)} / viewport 844`);
  expect(hint.y + hint.height).toBeLessThanOrEqual(844);
});
