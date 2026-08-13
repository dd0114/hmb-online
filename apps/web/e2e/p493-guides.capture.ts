import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { skipSplash } from "./splash-mock";

/**
 * #493 W2 실화면 캡처 — AC5 증빙(계약 아님). 화면별 가이드 코치마크 3장 + 다시 보기 진입점.
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts e2e/p493-guides.capture.ts
 */
const OUT = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function newUserPastOnboarding(page: Page) {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: "u493c", nickname: "캡처감독", tutorialDone: false },
          wallet: { points: 3000 },
          records: { wins: 0, draws: 0, losses: 0 },
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/me/starter-grant",
    (route) => route.fulfill(json({ granted: false, player: null })),
  );
  await page.route(
    (url) => url.pathname === "/api/me/tutorial-complete",
    (route) => route.fulfill(json({ tutorialDone: true, deckGranted: false })),
  );
  await page.route(
    (url) => url.pathname === "/api/auth/register",
    (route) =>
      route.fulfill(json({ token: "tok_c", user: { id: "u493c", nickname: "캡처감독" }, isNew: true })),
  );
  await skipSplash(page);
  await page.goto("/login");
  await page.getByTestId("provider-local").click();
  await page.getByTestId("local-mode-toggle").click();
  await page.getByTestId("local-nickname").fill("cap493g");
  await page.getByTestId("local-password").fill("sup3rs3cret");
  await page.getByTestId("local-submit").click();
  await page.getByTestId("starter-reveal-close").click();
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.getByTestId("tutorial-skip").click();
}

test("#493 가이드 캡처 — 390×844", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await page.setViewportSize({ width: 390, height: 844 });
  await newUserPastOnboarding(page);

  await page.goto("/game");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}p493-guide-game-phone.png` });

  await page.getByTestId("tutorial-next").click(); // 리그 스텝
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}p493-guide-game-step2-phone.png` });

  await page.goto("/recruit");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}p493-guide-recruit-phone.png` });

  await page.goto("/me");
  await expect(page.getByTestId("tutorial-overlay")).toBeVisible();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}p493-guide-me-phone.png` });

  // 다시 보기 진입점 — 가이드를 닫고 버튼이 보이는 상태.
  await page.getByTestId("tutorial-skip").click();
  await page.getByTestId("guide-replay").scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}p493-guide-replay-entry-phone.png` });
});
