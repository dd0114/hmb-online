import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W3 컨디션 표시(이슈 #98 요구 6) route-mock 스모크. 백엔드 없이 vite dev + page.route 로
 * GET /api/conditions/today 를 목킹해 브라우저에서 박제한다:
 *   1) 보유 선수 리스트의 각 행에 스탯총량 **옆에** 컨디션 시계(값 = 목 응답)가 뜬다.
 *   2) 덱 보드 토큰에도 같은 당일 컨디션이 전파된다(DeckPage → DeckEditor conditions prop).
 *   3) 엔드포인트가 빈 객체/실패여도 리스트는 그대로 렌더된다(graceful — 시계만 생략).
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

function attrs(overall: number) {
  return {
    technical: overall, mental: overall, physical: overall, passing: overall, shooting: overall,
    tackling: overall, pace: overall, stamina: overall, positioning: overall,
  };
}

const P = (id: string, name: string, position: string, grade: string, overall: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(overall), personality: "CALM",
});

const PLAYERS = [
  P("GK1", "골리1", "GK", "SILVER", 60),
  P("DF1", "수비1", "DF", "GOLD", 75),
  P("MF1", "미드1", "MF", "DIA", 85),
  P("FW1", "공격1", "FW", "LEGEND", 90),
];

/** 활성 덱: GK1 만 선발 0번에 배치 → 보드 토큰 컨디션 전파를 볼 수 있다. */
const DECK = {
  formation: "4-4-2",
  slots: [{ playerId: "GK1", role: "starter", slotIndex: 0, promptText: null }],
};

const CONDITIONS = { GK1: 0.91, DF1: 0.42, MF1: 0.08, FW1: 0.66 };

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

async function mockApi(page: Page, conditions: Record<string, number> | "error") {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/presets", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/deck", (route) => route.fulfill(json(DECK)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/presets/team", (route) =>
    route.fulfill(json([1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null, updatedAt: null })))),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    conditions === "error"
      ? route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ code: "NOT_FOUND", message: "x" }) })
      : route.fulfill(json(conditions)),
  );
}

async function openDeck(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.setViewportSize({ width: 390, height: 1400 });
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
}

test("W3 리스트 + 보드에 당일 컨디션 표시", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, CONDITIONS);
  await openDeck(page);

  // 1) 리스트 각 행에 컨디션 시계 — 값이 응답 그대로.
  for (const [id, value] of Object.entries(CONDITIONS)) {
    const clock = page.getByTestId(`pick-cond-${id}`);
    await expect(clock).toHaveAttribute("data-condition", value.toFixed(2));
  }
  // 스탯총량(W4)과 공존 — 회귀 없음.
  await expect(page.getByTestId("pick-overall-FW1")).toHaveText("90");

  // 2) 리스트 행 안에서 컨디션이 스탯총량 "옆"(같은 행) — 두 요소 모두 같은 버튼의 자식.
  const rowHasBoth = await page.getByTestId("pick-FW1").evaluate((el) =>
    Boolean(el.querySelector('[data-testid="pick-overall-FW1"]') && el.querySelector('[data-testid="pick-cond-FW1"]')),
  );
  expect(rowHasBoth).toBe(true);

  // 3) 보드 토큰(선발 배치된 GK1)에도 같은 값 — DeckPage → DeckEditor → TacticsBoard 전파.
  const boardClock = page.getByTestId("board-slot-starter-0").locator("[data-condition]").first();
  await expect(boardClock).toHaveAttribute("data-condition", "0.91");

  // 390px 가로 오버플로 0 유지.
  const overflow = await page.evaluate(() =>
    document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await page.screenshot({ path: `${SMOKE_DIR}deck-conditions-390.png`, fullPage: true });
});

test("W3 컨디션 응답이 비거나 실패해도 리스트는 정상(graceful)", async ({ page }) => {
  await mockApi(page, "error");
  await openDeck(page);

  // 시계는 없지만 행/스탯총량은 그대로 — 화면이 깨지지 않는다.
  await expect(page.getByTestId("pick-FW1")).toBeVisible();
  await expect(page.getByTestId("pick-overall-FW1")).toHaveText("90");
  await expect(page.getByTestId("pick-cond-FW1")).toHaveCount(0);
});
