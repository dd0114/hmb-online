import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAll } from "./p286-mocks";

/**
 * #286 W3 실화면 캡처 — hero 컨펌·시각 확인용(판정용 아님, 루트 §2-2).
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5294 npx playwright test --config=playwright.capture.config.ts p286-w3
 */
const OUT = new URL("../.smoke/w3/", import.meta.url).pathname;

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAll(page);
});

async function tall(page: import("@playwright/test").Page, name: string) {
  await page.waitForTimeout(600);
  const h = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, 844));
  await page.setViewportSize({ width: 390, height: Math.min(h, 3200) });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
}

test("w3: 선수 탭 — 보유(전신)", async ({ page }) => {
  await page.goto("/players");
  await page.getByTestId("codex-owned-total").waitFor();
  await tall(page, "01-players-owned");
});

test("w3: 선수 탭 — 전체(미보유 실루엣)", async ({ page }) => {
  await page.goto("/players");
  await page.getByTestId("codex-scope-all").click();
  await tall(page, "02-players-all");
});

test("w3: 덱 지시 레일 — [선수 강화] 줄", async ({ page }) => {
  await page.goto("/deck");
  await page.getByTestId("tactics-board").waitFor();
  await page.locator('[data-testid^="token-"]').nth(3).click();
  await page.getByTestId("rail-growth-open").waitFor();
  await tall(page, "03-deck-rail-growth");
});

test("w3: 영입 — 트레이드 설명", async ({ page }) => {
  await page.goto("/recruit?tab=trade");
  await page.getByTestId("trade-guide").waitFor();
  await tall(page, "04-recruit-trade-guide");
});
