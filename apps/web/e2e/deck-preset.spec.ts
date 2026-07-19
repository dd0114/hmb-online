import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W1 프리셋-중심 덱 화면 route-mock 스모크 (이슈 #98 요구 1·2·4·5) — **백엔드 없이** vite dev +
 * page.route 로 /api 를 상태형(stateful) 목킹해 다음 플로우를 브라우저에서 박제한다:
 *   빈 슬롯 첫 진입 → [+새 프리셋] 저장 → 슬롯 칩 로드 → 편집 dirty → 이탈 확인 다이얼로그(취소/저장)
 *   → 저장 후 dirty 해제.
 * 라이브 왕복은 통합 게이트(match-flow.spec.ts)에서 별도. 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const attrs = {
  technical: 72, mental: 68, physical: 75, passing: 70, shooting: 66,
  tackling: 64, pace: 73, stamina: 71, positioning: 69,
};

/** 12 owned players (1 GK) so the seeded active deck fills 11 starters + 1 bench. */
const PLAYERS = [
  { id: "GK1", name: "골키퍼", position: "GK", grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs, personality: "CALM" },
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `P${i + 1}`,
    name: `선수 ${i + 1}`,
    position: i < 4 ? "DF" : i < 8 ? "MF" : "FW",
    grade: "SILVER",
    owned: true,
    ownedCount: 1,
    attributes: attrs,
    personality: "CALM",
  })),
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Stateful mock: presets + active deck mutate as the client saves/applies. */
async function mockApi(page: Page) {
  const starters = [
    { playerId: "GK1", role: "starter", slotIndex: 0, promptText: null },
    ...Array.from({ length: 10 }, (_, i) => ({ playerId: `P${i + 1}`, role: "starter", slotIndex: i + 1, promptText: null })),
  ];
  const state: {
    deck: { formation: string; slots: unknown[] };
    presets: Array<{ slot: number; name: string | null; snapshot: unknown }>;
  } = {
    deck: { formation: "4-4-2", slots: [...starters, { playerId: "P11", role: "bench", slotIndex: 0, promptText: null }] },
    presets: [
      { slot: 1, name: null, snapshot: null },
      { slot: 2, name: null, snapshot: null },
      { slot: 3, name: null, snapshot: null },
    ],
  };

  // catch-all first, specific routes registered after (Playwright: last match wins).
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
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

  await page.route(
    (url) => url.pathname === "/api/presets/team",
    (route) => route.fulfill(json(state.presets)),
  );

  await page.route(
    (url) => /^\/api\/presets\/team\/[123]$/.test(url.pathname),
    (route) => {
      const slot = Number(new URL(route.request().url()).pathname.split("/").pop());
      const body = route.request().postDataJSON();
      const entry = {
        slot,
        name: body.name,
        snapshot: {
          formation: body.formation,
          starters: body.starters,
          bench: body.bench,
          teamTactics: body.teamTactics,
          teamPrompt: body.teamPrompt ?? null,
        },
      };
      state.presets = state.presets.map((p) => (p.slot === slot ? entry : p));
      return route.fulfill(json(entry));
    },
  );

  await page.route(
    (url) => /^\/api\/presets\/team\/[123]\/apply$/.test(url.pathname),
    (route) => route.fulfill(json(state.deck)),
  );
}

test("W1 deck-preset: 첫 진입 → 새 프리셋 저장 → 로드 → dirty → 이탈 다이얼로그 → 저장 후 해제", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/deck");

  // 1) 첫 진입: 전부 빈 슬롯 → 요약 카드 empty-state + [+새 프리셋] 활성(선발 11 시드됨).
  await expect(page.getByTestId("preset-summary-empty")).toBeVisible();
  await expect(page.getByTestId("slot-chip-1")).toHaveAttribute("data-filled", "false");
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await expect(page.getByTestId("slot-new-button")).toBeEnabled();

  await page.screenshot({ path: `${SMOKE_DIR}w1-deck-first-entry.png`, fullPage: true });

  // 2) [+새 프리셋] → 이름 입력 → 저장 → 슬롯1 채워지고 선택됨 + 저장 노트.
  await page.getByTestId("slot-new-button").click();
  await page.getByTestId("slot-new-name-input").fill("메인 전술");
  await page.getByTestId("slot-new-confirm").click();

  await expect(page.getByTestId("slot-chip-1")).toHaveAttribute("data-filled", "true");
  await expect(page.getByTestId("slot-chip-1")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("preset-summary-name")).toHaveText("메인 전술");
  await expect(page.getByTestId("preset-summary-power")).toHaveText(/\d+/);
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 3) N2 — 채워진 슬롯 인라인 이름변경 → 요약·칩 반영(내용 변경 아니므로 dirty 아님).
  await page.getByTestId("preset-rename-button").click();
  await page.getByTestId("preset-rename-input").fill("메인 4-4-2");
  await page.getByTestId("preset-rename-save").click();
  await expect(page.getByTestId("preset-summary-name")).toHaveText("메인 4-4-2");
  await expect(page.getByTestId("slot-chip-1")).toContainText("메인 4-4-2");
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 4) 두 번째 프리셋 생성(슬롯 전환 테스트용): 편집 → [+새 프리셋]로 슬롯2 저장.
  await page.getByTestId("editor-team-prompt").fill("백업용 압박");
  await page.getByTestId("slot-new-button").click();
  await page.getByTestId("slot-new-name-input").fill("백업 전술");
  await page.getByTestId("slot-new-confirm").click();
  await expect(page.getByTestId("slot-chip-2")).toHaveAttribute("data-filled", "true");
  await expect(page.getByTestId("slot-chip-2")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 5) N1 — dirty 중 다른 슬롯 클릭 → 확인 다이얼로그 → 취소 시 잔류(현재 슬롯·편집 유지).
  await page.getByTestId("editor-team-prompt").fill("측면 오버래핑 적극 활용");
  await expect(page.getByTestId("deck-dirty-badge")).toBeVisible();
  await page.getByTestId("slot-chip-1").click();
  await expect(page.getByTestId("leave-confirm-dialog")).toBeVisible();
  await page.getByTestId("leave-cancel").click();
  await expect(page.getByTestId("leave-confirm-dialog")).toHaveCount(0);
  await expect(page.getByTestId("slot-chip-2")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("측면 오버래핑 적극 활용");
  await expect(page.getByTestId("deck-dirty-badge")).toBeVisible();

  // 6) N1 — dirty 중 다른 슬롯 클릭 → 다이얼로그 → "버리고 전환" 시 이동(편집 폐기, 슬롯1 로드).
  await page.getByTestId("slot-chip-1").click();
  await expect(page.getByTestId("leave-confirm-dialog")).toBeVisible();
  await page.getByTestId("leave-discard").click();
  await expect(page.getByTestId("slot-chip-1")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("");
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 7) N1 — "저장 후 전환": dirty → 다른 슬롯 클릭 → 다이얼로그 → 저장 → 대상 슬롯 로드, dirty 해제.
  await page.getByTestId("editor-team-prompt").fill("역습 위주로 안정적으로");
  await expect(page.getByTestId("deck-dirty-badge")).toBeVisible();
  await page.getByTestId("slot-chip-2").click();
  await expect(page.getByTestId("leave-confirm-dialog")).toBeVisible();
  await page.getByTestId("leave-save").click();
  await expect(page.getByTestId("slot-chip-2")).toHaveAttribute("data-selected", "true");
  await expect(page.getByTestId("editor-team-prompt")).toHaveValue("백업용 압박");
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 8) 저장 후(clean) 네비 이탈은 다이얼로그 없이 통과.
  await page.getByTestId("nav-bottom").getByTestId("nav-home").click();
  await expect(page).toHaveURL(/\/lobby$/);

  // 9) 390px 가로 오버플로 0.
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);

  // 10) 데스크탑(≥1024px): 2컬럼 레이아웃 가로 오버플로 0.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(200);
  const overflowDesk = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  console.log(`[smoke] 1280px horizontal overflow px = ${overflowDesk}`);
  expect(overflowDesk).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}w1-deck-desktop.png`, fullPage: false });
});
