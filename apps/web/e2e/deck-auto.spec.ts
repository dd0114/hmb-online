import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W2 Auto 구성 route-mock 스모크 (이슈 #98 요구 3) — 백엔드 없이 vite dev + page.route 로 /api 를
 * 목킹해 다음을 브라우저에서 박제한다:
 *   첫 진입(빈 슬롯, 활성 덱 없음 → 선발 0) → [Auto 구성] 클릭 → 결정론 로직으로 보드 11 채워짐 +
 *   dirty 뱃지 + [+새 프리셋] 저장 가능. 보유 < 11 이면 버튼 비활성.
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const attrs = {
  technical: 72, mental: 68, physical: 75, passing: 70, shooting: 66,
  tackling: 64, pace: 73, stamina: 71, positioning: 69,
};

/** 14 owned players (2 GK, 4 DF, 5 MF, 3 FW) — enough for 11 starters + bench, > 11 so Auto enabled. */
const PLAYERS = [
  { id: "GK1", name: "골키퍼1", position: "GK", grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs },
  { id: "GK2", name: "골키퍼2", position: "GK", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs },
  ...Array.from({ length: 4 }, (_, i) => ({ id: `DF${i + 1}`, name: `수비 ${i + 1}`, position: "DF", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs })),
  ...Array.from({ length: 5 }, (_, i) => ({ id: `MF${i + 1}`, name: `미드 ${i + 1}`, position: "MF", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs })),
  ...Array.from({ length: 3 }, (_, i) => ({ id: `FW${i + 1}`, name: `공격 ${i + 1}`, position: "FW", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs })),
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Stateful mock with NO active deck and empty presets → first entry starts at 선발 0/11. */
async function mockApi(page: Page, players: unknown[]) {
  const state: {
    deck: { formation: string; slots: unknown[] };
    presets: Array<{ slot: number; name: string | null; snapshot: unknown }>;
  } = {
    deck: { formation: "4-4-2", slots: [] },
    presets: [
      { slot: 1, name: null, snapshot: null },
      { slot: 2, name: null, snapshot: null },
      { slot: 3, name: null, snapshot: null },
    ],
  };

  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(players)));
  await page.route((url) => url.pathname === "/api/presets", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/relations", (route) => route.fulfill(json({ morale: 60, streak: 0, players: [] })));

  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) => {
      if (route.request().method() === "PUT") {
        const body = route.request().postDataJSON();
        state.deck = { formation: body.formation, slots: body.slots };
      }
      return route.fulfill(json(state.deck));
    },
  );
  await page.route((url) => url.pathname === "/api/presets/team", (route) => route.fulfill(json(state.presets)));
  await page.route(
    (url) => /^\/api\/presets\/team\/[123]$/.test(url.pathname),
    (route) => {
      const slot = Number(new URL(route.request().url()).pathname.split("/").pop());
      const body = route.request().postDataJSON();
      const entry = {
        slot,
        name: body.name,
        snapshot: { formation: body.formation, starters: body.starters, bench: body.bench, teamTactics: body.teamTactics, teamPrompt: body.teamPrompt ?? null },
      };
      state.presets = state.presets.map((p) => (p.slot === slot ? entry : p));
      return route.fulfill(json(entry));
    },
  );
  await page.route((url) => /^\/api\/presets\/team\/[123]\/apply$/.test(url.pathname), (route) => route.fulfill(json(state.deck)));
}

test("W2 Auto 구성: 빈 편집기 → Auto 클릭 → 선발 11 채움 + dirty → 새 프리셋 저장", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, PLAYERS);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/deck");

  // 1) 첫 진입: 활성 덱 없음 → 선발 0/11, Auto 버튼 활성(보유 14명 ≥ 11).
  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);
  await expect(page.getByTestId("auto-fill")).toBeEnabled();
  await page.screenshot({ path: `${SMOKE_DIR}w2-auto-before.png`, fullPage: true });

  // 2) Auto 클릭 → 결정론 로직으로 선발 11 채워짐 + dirty 뱃지.
  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await expect(page.getByTestId("deck-dirty-badge")).toBeVisible();
  // GK 슬롯(slotIndex 0)에 실제 GK 토큰이 놓였는지(우선 배정).
  await expect(page.getByTestId("board-slot-starter-0").getByTestId(/^token-GK[12]$/)).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}w2-auto-after.png`, fullPage: true });

  // 3) 결정론: 다시 Auto 눌러도 동일 선발 유지(11/11).
  await page.getByTestId("auto-fill").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  // 4) 저장 가능: [+새 프리셋] → 슬롯1 채워지고 dirty 해제.
  await page.getByTestId("slot-new-button").click();
  await page.getByTestId("slot-new-name-input").fill("자동 전술");
  await page.getByTestId("slot-new-confirm").click();
  await expect(page.getByTestId("slot-chip-1")).toHaveAttribute("data-filled", "true");
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 5) 390px 가로 오버플로 0.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});

test("W2 Auto 구성: 보유 선수 < 11 → 버튼 비활성 + 안내", async ({ page }) => {
  await mockApi(page, PLAYERS.slice(0, 6)); // 6 owned
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/deck");

  await expect(page.getByTestId("auto-fill")).toBeDisabled();
  await expect(page.getByTestId("auto-fill").locator("xpath=following-sibling::span")).toContainText("보유 선수 부족");
});
