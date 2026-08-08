import { expect, test, type Page } from "@playwright/test";
import { appConfigPayload } from "./app-config-mock";

/**
 * #477 — **백엔드가 죽어도 web(CF Pages)은 뜬다.** 그때 유저가 보는 것이 빈 화면·정체불명 에러가
 * 아니라 "점검 중 + 연락처" 여야 한다.
 *
 * 두 가지 죽는 방식을 모두 태운다 — 실제 운영에서 둘 다 겪는다:
 *  a. **터널 사망** → 응답 자체가 없다(fetch reject = playbook §4 의 "Failed to fetch").
 *  b. **터널은 살고 도커만 사망** → Cloudflare 가 502/503 을 준다(fetch 는 성공한다).
 *
 * 그리고 **오탐 가드**가 같은 무게로 중요하다 — 백엔드가 멀쩡하면 이 화면은 절대 뜨면 안 된다.
 *
 * ⚠️ 라우트는 **pathname** 으로 잡는다(오리진 없는 글롭은 vite 에셋까지 삼켜 흰 화면 — CLAUDE.md).
 */

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const isApi = (url: URL) => url.pathname.startsWith("/api/");

/** 백엔드가 정상일 때의 최소 응답(로그인 화면이 뜨는 데 필요한 만큼). */
async function serveHealthy(page: Page) {
  await page.route(
    (url) => isApi(url),
    (route) => {
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/config") return route.fulfill(json(appConfigPayload()));
      return route.fulfill(json({}));
    },
  );
}

test("터널 사망(응답 없음) → 점검 안내 + 연락처가 뜬다", async ({ page }) => {
  await page.route((url) => isApi(url), (route) => route.abort("connectionrefused"));

  await page.goto("/login");

  const screen = page.getByTestId("maintenance-screen");
  await expect(screen).toBeVisible({ timeout: 30_000 });
  await expect(page.getByTestId("maintenance-contact")).toHaveAttribute(
    "href",
    /open\.kakao\.com\//,
  );
  await expect(page.getByTestId("maintenance-retry")).toBeVisible();
});

test("백엔드만 사망(502) → 같은 점검 안내가 뜬다", async ({ page }) => {
  await page.route(
    (url) => isApi(url),
    (route) => route.fulfill({ status: 502, contentType: "text/html", body: "<h1>Bad gateway</h1>" }),
  );

  await page.goto("/login");

  await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });
});

test("복구: 백엔드가 살아난 뒤 [다시 시도] 를 누르면 점검 화면이 사라진다", async ({ page }) => {
  let alive = false;
  await page.route(
    (url) => isApi(url),
    (route) => {
      if (!alive) return route.abort("connectionrefused");
      const p = new URL(route.request().url()).pathname;
      if (p === "/api/config") return route.fulfill(json(appConfigPayload()));
      return route.fulfill(json({}));
    },
  );

  await page.goto("/login");
  await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });

  alive = true; // 워치독이 터널을 되살렸다
  await page.getByTestId("maintenance-retry").click();

  await expect(page.getByTestId("maintenance-screen")).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });
});

test("오탐 가드: 백엔드가 정상이면 점검 화면이 뜨지 않는다", async ({ page }) => {
  await serveHealthy(page);

  await page.goto("/login");
  await expect(page.getByTestId("provider-choose")).toBeVisible({ timeout: 30_000 });
  // 확인 프로브 창(2회 × 2s)보다 넉넉히 기다린 뒤에도 뜨면 안 된다.
  await page.waitForTimeout(7_000);
  await expect(page.getByTestId("maintenance-screen")).toHaveCount(0);
});
