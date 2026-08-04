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
  //    (#106 R1: 모바일에서 AUTO 는 시트 바(auto-fill-top), 데스크탑은 보드 하단 바(auto-fill).)
  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);
  await expect(page.getByTestId("auto-fill-top")).toBeEnabled();
  await page.screenshot({ path: `${SMOKE_DIR}w2-auto-before.png`, fullPage: true });

  // 2) Auto 클릭 → 결정론 로직으로 선발 11 채워짐 + dirty 뱃지.
  await page.getByTestId("auto-fill-top").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);
  await expect(page.getByTestId("deck-dirty-badge")).toBeVisible();
  // GK 슬롯(slotIndex 0)에 실제 GK 토큰이 놓였는지(우선 배정).
  await expect(page.getByTestId("board-slot-starter-0").getByTestId(/^token-GK[12]$/)).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}w2-auto-after.png`, fullPage: true });

  /*
   * 3) 다 채운 뒤에는 **버튼이 스스로 닫힌다** (#439 major-2).
   *    구 스텝은 "다시 눌러도 11/11 유지"(전면 재구성의 결정론)를 쟀는데, 지금 Auto 는 빈 자리
   *    채우기라 채울 것이 없으면 **비활성 + 사유**가 맞다. 활성인 채로 두면 눌러도 아무 일이
   *    안 일어나는 버튼이 된다 — 그게 이 웨이브가 고친 결함이다.
   *    (결정론 자체는 `fill-empty.test.ts` 가 순수 함수 층에서 계속 잰다.)
   */
  await expect(page.getByTestId("auto-fill-top")).toBeDisabled();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  // 4) 저장: #106 R1 부터 이 화면은 **활성 덱 하나**만 저장한다(프리셋 슬롯 UI 는 화면에서 내림).
  //    구 스텝("[+새 프리셋] → 슬롯1 채워짐")을 [저장] → 저장 완료 + dirty 해제로 대체.
  await page.getByTestId("save-deck").click();
  await expect(page.getByTestId("deck-saved-note")).toBeVisible();
  await expect(page.getByTestId("deck-dirty-badge")).toHaveCount(0);

  // 5) 390px 가로 오버플로 0.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});

/**
 * ⚠️ **이 계약은 #439 에서 의미가 뒤집혀 다시 쓰였다.**
 *
 * 구 계약: *"보유 선수 < 11 → 버튼 비활성 + '보유 선수 부족'"*. 그때의 Auto 는 `autoBuildLineup`
 * (**전원에서 11명을 새로 짠다**)이라 11명이 없으면 할 수 있는 일이 정말로 없었다.
 *
 * 지금의 Auto 는 `fillEmptySlots`(**빈 자리를 채운다**, hero Q1=ⓑ)다 — 보유 6명이면 6칸은 채운다.
 * 그 상태를 비활성으로 두면 **할 수 있는 일을 막는** 거짓 잠금이 된다. 그래서 새 의미로 재작성한다:
 *   · 보유 6명 → **활성**, 누르면 6칸이 채워지고 안내가 "다 못 채운다"를 말한다
 *   · 진짜로 할 일이 없을 때(= 덱이 이미 꽉 참) → **비활성 + 사유**
 * 두 번째가 이 웨이브가 고친 결함 자체다(#439 2R major-2: 완성 덱에서 활성인데 눌러도 무반응,
 * 같은 상태의 경기전은 비활성 + 사유였다 = 두 화면의 판정이 갈려 있었다).
 * ⚠️ 되돌리려면 `DeckPage` 의 게이트를 `canAutoBuild` 로 되돌리게 되는데, 그 순간 이 파일이 red 다.
 */
test("W2 Auto: 보유 < 11 이어도 **있는 만큼 채운다**(비활성 아님) + 안내가 한계를 말한다", async ({ page }) => {
  await mockApi(page, PLAYERS.slice(0, 6)); // 6 owned
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/deck");

  await expect(page.getByTestId("starter-count")).toHaveText(/0\/11/);
  await expect(page.getByTestId("auto-fill-top")).toBeEnabled();
  // 안내는 **누르기 전에** "왜 11 이 안 되나"를 말한다 — 침묵하면 유저는 버튼이 고장난 줄 안다.
  // ⚠️ 폰에서 읽는 자리는 보드 아래 `auto-hint` 가 아니라 **버튼의 `title`** 이다
  //    (`auto-hint` 는 ≤1023px 에서 `display:none`, `auto-hint-top` 은 비활성일 때만 뜬다).
  //    폰에서 실제로 도달 가능한 축으로 잰다.
  await expect(page.getByTestId("auto-fill-top")).toHaveAttribute("title", /다 못 채웁니다/);

  await page.getByTestId("auto-fill-top").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/6\/11/);
  // 6명을 다 쓴 뒤에는 더 넣을 사람이 없으므로 버튼이 닫힌다(사유와 함께).
  await expect(page.getByTestId("auto-fill-top")).toBeDisabled();
  await expect(page.getByTestId("auto-hint-top")).toContainText("채울 빈 자리가 없");
});

test("W2 Auto: 덱이 이미 꽉 차 있으면 **비활성 + 사유**(눌러도 무반응이던 결함, #439 major-2)", async ({ page }) => {
  await mockApi(page, PLAYERS);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/deck");

  // 먼저 Auto 로 채운다(보유 14 → 선발 11 + 벤치 3 = 더 넣을 자리가 없다).
  await page.getByTestId("auto-fill-top").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/11\/11/);

  await expect(page.getByTestId("auto-fill-top")).toBeDisabled();
  await expect(page.getByTestId("auto-hint-top")).toContainText("채울 빈 자리가 없");
});
