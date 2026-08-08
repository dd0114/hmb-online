import { test, expect, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #477 실화면 캡처 — **판정이 아니라 눈으로 볼 증빙**이다(루트 CLAUDE §2-2 "좌표 추론 금지").
 * 계약은 `p477-maintenance.spec.ts` 가 진다.
 *
 *   cd apps/web && CI=1 WEB_E2E_PORT=5477 npx playwright test p477-capture --config=playwright.capture.config.ts
 */
const SHOTS = new URL("../.smoke/", import.meta.url).pathname;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

test.beforeAll(() => mkdirSync(SHOTS, { recursive: true }));

async function killBackend(page: Page) {
  // pathname 매칭 — 오리진 없는 글롭은 vite 에셋까지 삼킨다(CLAUDE.md).
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.abort("connectionrefused"));
}

test("캡처: 점검 안내 화면 (모바일·데스크탑)", async ({ page }) => {
  await killBackend(page);

  for (const [label, vp] of [["390", PHONE], ["desktop", DESKTOP]] as const) {
    await page.setViewportSize(vp);
    await page.goto("/login");
    await expect(page.getByTestId("maintenance-screen")).toBeVisible({ timeout: 30_000 });
    await page.screenshot({ path: `${SHOTS}p477-maintenance-${label}.png`, fullPage: false });
  }
});
