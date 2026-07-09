import { test, expect } from "@playwright/test";
import { loadViewer, eventsOfType } from "./fixture";

// 하프/풀타임 휘슬: 이벤트 발행 + 이벤트 티커에 렌더.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("half_whistle / full_whistle 이벤트가 발행되고 티커에 렌더된다", async ({ page }) => {
  expect((await eventsOfType(page, "half_whistle")).length).toBeGreaterThan(0);
  expect((await eventsOfType(page, "full_whistle")).length).toBeGreaterThan(0);
  expect(await page.locator(".ev-half_whistle").count()).toBeGreaterThan(0);
  expect(await page.locator(".ev-full_whistle").count()).toBeGreaterThan(0);
});
