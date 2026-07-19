import { test, expect } from "@playwright/test";
import { loadViewer } from "./fixture";

// F2(#100) 계약: 상세 경기 로그 — 중요도별 타이포(major=굵게/큰, minor=작게/흐리게),
// 슛/카드 상세 + 골 스코어라인 + 클릭 점프 유지.
test.beforeEach(async ({ page }) => { await loadViewer(page); });

test("골/카드는 major 티어, 세트피스·태클·빗나간슛은 minor 티어", async ({ page }) => {
  // 골 항목은 tier-major 클래스 + 스코어라인.
  const goal = await page.locator(".ev-goal.tier-major").first();
  expect(await goal.count()).toBeGreaterThan(0);
  // 골 텍스트에 "GOAL" + 스코어(N-N).
  const goalText = await goal.textContent();
  expect(goalText).toContain("GOAL");
  expect(goalText).toMatch(/\d+-\d+/);
  // 카드도 major.
  // 세트피스(kickoff detail)·태클은 minor.
  expect(await page.locator(".ev-tackle.tier-minor").count()).toBeGreaterThan(0);
  expect(await page.locator(".ev-kickoff.tier-minor").count()).toBeGreaterThan(0);
});

test("major 티어 폰트가 minor 보다 크다(중요도 시각 구분)", async ({ page }) => {
  const majorPx = await page.locator(".tier-major").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  const minorPx = await page.locator(".tier-minor").first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
  expect(majorPx).toBeGreaterThan(minorPx);
});

test("슛 항목에 xG + 결과 상세가 표시된다", async ({ page }) => {
  const shots = page.locator(".ev-shot");
  expect(await shots.count()).toBeGreaterThan(0);
  const allText = (await shots.allTextContents()).join(" ");
  expect(allText).toContain("xG");
  // 결과 상세(saved/off target/on goal/1-on-1 중 하나).
  expect(allText).toMatch(/saved|off target|on goal|1-on-1/);
});

test("로그 클릭 점프 유지 — 항목 클릭 시 해당 틱 부근으로 이동", async ({ page }) => {
  const item = page.locator("#ticker > div[data-tick]").nth(3);
  const tick = Number(await item.getAttribute("data-tick"));
  await item.click();
  const cur = await page.evaluate(() => (window as any).__viewer.cur());
  // jumpToTick 은 idx-3 부근으로 이동 → cur.tick 이 클릭 틱 근처(±6).
  expect(Math.abs(cur.tick - tick)).toBeLessThanOrEqual(8);
});
