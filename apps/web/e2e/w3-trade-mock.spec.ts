import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W3 트레이드 route-mock 스모크 (AC-D) — **백엔드 없이**(server-java W4 mid-flight) vite dev +
 * page.route 로 /api 를 목킹해 3슬롯(WAITING/OPEN-FA/OPEN-TRADE) 렌더·390px 오버플로 0·카운트다운
 * 동작을 캡처한다. 라이브 왕복은 통합 게이트에서 별도. 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const TRADE_RESPONSE = {
  wallet: { points: 1200 },
  slots: [
    {
      slot: 1, state: "WAITING", offerKind: null, target: null, demand: null,
      opensAt: "2026-07-19T12:00:00Z", remainingSec: 125, speedupCost: 300,
    },
    {
      slot: 2, state: "OPEN", offerKind: "FA",
      target: { playerId: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA" },
      demand: null, targetValue: 91,
    },
    {
      slot: 3, state: "OPEN", offerKind: "TRADE",
      target: { playerId: "P077", name: "대가 플레이메이커", position: "MF", grade: "GOLD" },
      demand: { playerId: "P010", name: "내 센터백", position: "DF", grade: "SILVER" },
      acceptProbability: 0.8,
    },
  ],
};

const attrs = {
  technical: 74, mental: 68, physical: 80, passing: 71, shooting: 85,
  tackling: 55, pace: 82, stamina: 70, positioning: 77,
};
const PLAYERS_RESPONSE = [
  { id: "P010", name: "내 센터백", position: "DF", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs, personality: "CALM" },
  { id: "P011", name: "내 윙어", position: "FW", grade: "GOLD", owned: true, ownedCount: 2, attributes: attrs, personality: "FIERY" },
  { id: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA", owned: false, ownedCount: 0, attributes: attrs, personality: "AMBITIOUS" },
  { id: "P077", name: "대가 플레이메이커", position: "MF", grade: "GOLD", owned: false, ownedCount: 0, attributes: attrs, personality: "CALM" },
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page) {
  // pathname 으로 매칭(glob '**/api/**' 는 vite 소스 /src/api/*.ts 까지 잡아 모듈로딩을 깬다).
  // Playwright 는 나중에 등록한 핸들러가 우선 — catch-all 먼저, 구체 라우트 뒤에.
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    (route) => route.fulfill(json({})),
  );
  await page.route(
    (url) => url.pathname === "/api/trade",
    (route) => route.fulfill(json(TRADE_RESPONSE)),
  );
  await page.route(
    (url) => url.pathname === "/api/players",
    (route) => route.fulfill(json(PLAYERS_RESPONSE)),
  );
}

test("W3 trade route-mock: 3슬롯 렌더 + 390px 오버플로 0 + 카운트다운", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page);
  // RequireAuth 통과용 토큰 시드(백엔드 없이).
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/trade");

  // 3슬롯이 각기 다른 view 로 렌더.
  await expect(page.getByTestId("trade-slot-1")).toHaveAttribute("data-view", "WAITING");
  await expect(page.getByTestId("trade-slot-2")).toHaveAttribute("data-view", "OPEN_FA");
  await expect(page.getByTestId("trade-slot-3")).toHaveAttribute("data-view", "OPEN_TRADE");

  // OPEN-FA: 대상 카드 + 제안 빌더 + 확률 미표시(안내 노트).
  await expect(page.getByTestId("trade-slot-2-target")).toBeVisible();
  await expect(page.getByTestId("propose-builder")).toBeVisible();
  await expect(page.getByTestId("propose-prob-note")).toBeVisible();
  // OPEN-TRADE: 서버 확률 표시.
  await expect(page.getByTestId("trade-slot-3-prob")).toContainText("80%");

  // 카운트다운 동작: ~2s 뒤 값이 줄어든다(서버 remainingSec 앵커 - 로컬 경과).
  const cd = page.getByTestId("trade-slot-1-countdown");
  const before = Number(await cd.getAttribute("data-remaining"));
  await page.waitForTimeout(2100);
  const after = Number(await cd.getAttribute("data-remaining"));
  console.log(`[smoke] countdown ${before} → ${after}`);
  expect(after).toBeLessThan(before);
  expect(before - after).toBeGreaterThanOrEqual(1);

  // 390px 가로 오버플로 0.
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);

  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-mobile390.png`, fullPage: true });

  // 데스크탑(≥1024px): 3슬롯 병렬.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  const overflowDesk = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 1280px horizontal overflow px = ${overflowDesk}`);
  expect(overflowDesk).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}w3-trade-desktop.png`, fullPage: false });
});
