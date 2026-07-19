import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * 팀 시트 재편 R1 (이슈 #106) route-mock 스모크 — 백엔드 없이 vite dev + page.route 로 /api 를
 * 목킹해 브라우저에서 새 골격의 계약을 박제한다:
 *   1) 시트 바 3지표(선발 n/11 · 벤치 n/7 · 지시 n/11) + 포메이션 + 전력 게이지
 *   2) 벤치 스트립이 **보드 카드 안**에 있다(별도 블록 금지)
 *   3) 선수 탭 → **선수정보 시트가 아니라 레일**이 그 선수 지시로 바뀐다 (PlayerSheet 부재)
 *   4) 프리셋 진입점 부재(슬롯 칩/요약/새 프리셋/프롬프트 프리셋)
 *   5) 탭-투-플레이스: 슬롯 탭 → 리스트 자동 필터 → 선수 탭 → 배치 (역방향도)
 *   6) 390 / 1024 / 1280px 가로 오버플로 0
 * 스크린샷 = apps/web/.smoke/.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const P = (id: string, name: string, position: string, grade: string, overall: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(overall), personality: "CALM",
});

const PLAYERS = [
  P("GK1", "골리원", "GK", "GOLD", 70),
  P("GK2", "골리투", "GK", "SILVER", 62),
  P("DF1", "수비하나", "DF", "GOLD", 76),
  P("DF2", "수비둘", "DF", "SILVER", 68),
  P("DF3", "수비셋", "DF", "SILVER", 64),
  P("DF4", "수비넷", "DF", "BRONZE", 55),
  P("MF1", "미드하나", "MF", "DIA", 84),
  P("MF2", "미드둘", "MF", "GOLD", 74),
  P("MF3", "미드셋", "MF", "SILVER", 66),
  P("MF4", "미드넷", "MF", "SILVER", 61),
  P("FW1", "공격하나", "FW", "LEGEND", 90),
  P("FW2", "공격둘", "FW", "GOLD", 72),
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/**
 * 상태형 목. ⚠️ 라우트 매칭은 **오리진 앵커**(url.pathname 비교)로 한다 — 상대 글롭("**\/api/...")은
 * vite dev 의 다른 오리진 요청까지 삼켜 흰 화면이 된다(실적 있음).
 */
async function mockApi(page: Page, deckSlots: unknown[] = []) {
  const state = { deck: { formation: "4-4-2", slots: deckSlots } };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/relations", (route) =>
    route.fulfill(json({ morale: 60, streak: 0, players: [] })),
  );
  await page.route((url) => url.pathname === "/api/conditions/today", (route) =>
    route.fulfill(json({ GK1: 0.9, MF1: 0.5, FW1: 0.2 })),
  );
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.deck = { formation: body.formation, slots: body.slots };
    }
    return route.fulfill(json(state.deck));
  });
}

/** 선발 11 + 벤치 2 (지시 2명) — 지표/레일 검수용 시드 덱. */
function seededDeck() {
  const ids = ["GK1", "DF1", "DF2", "DF3", "DF4", "MF1", "MF2", "MF3", "MF4", "FW1", "FW2"];
  return [
    ...ids.map((playerId, i) => ({
      playerId,
      role: "starter",
      slotIndex: i,
      promptText: playerId === "MF1" ? "안쪽으로 파고들어라" : playerId === "FW1" ? "과감하게 슛" : null,
    })),
    { playerId: "GK2", role: "bench", slotIndex: 0, promptText: null },
  ];
}

async function openDeck(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
}

async function overflowPx(page: Page): Promise<number> {
  return page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
}

test("R1 팀 시트 골격: 시트 바 3지표 · 벤치 in 보드카드 · 프리셋 진입점 부재", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  // 1) 시트 바 3지표
  await expect(page.getByTestId("starter-count")).toHaveText("선발 11/11");
  await expect(page.getByTestId("bench-count")).toHaveText("벤치 1/7");
  await expect(page.getByTestId("directive-count")).toContainText("지시 2/11");
  await expect(page.getByTestId("formation-select")).toHaveValue("4-4-2");
  await expect(page.getByTestId("sheet-power")).toBeVisible();

  // 2) 벤치가 보드 카드 안 (DOM 포함 관계 실측)
  const benchInsideCard = await page.evaluate(() => {
    const card = document.querySelector('[data-testid="board-card"]')!;
    const bench = document.querySelector('[data-testid="board-bench-section"]')!;
    return card.contains(bench);
  });
  expect(benchInsideCard, "벤치는 보드 카드 안에 있어야 한다(#106)").toBe(true);

  // 3) 프리셋 진입점 부재
  for (const id of ["slot-selector", "slot-chip-1", "slot-new-button", "preset-summary", "preset-create"]) {
    await expect(page.getByTestId(id), `${id} 는 화면에 없어야 한다`).toHaveCount(0);
  }

  await page.screenshot({ path: `${SMOKE_DIR}r1-teamsheet-390.png`, fullPage: true });
});

test("R1 선수 탭 → 선수정보 시트가 아니라 지시 레일이 바뀐다", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDeck(page);

  // 선택 없음 → 팀 지시
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
  await expect(page.getByTestId("rail-title")).toHaveText("팀 지시");
  await expect(page.getByTestId("editor-team-prompt")).toBeVisible();

  // MF1 토큰 탭 → 레일이 그 선수로
  await page.getByTestId("token-MF1").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "player");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");
  await expect(page.getByTestId("rail-subtitle")).toContainText("MF");
  await expect(page.getByTestId("rail-prompt-input")).toHaveValue("안쪽으로 파고들어라");
  // 구 선수정보 시트는 뜨지 않는다
  await expect(page.getByTestId("player-sheet")).toHaveCount(0);
  await expect(page.getByTestId("sheet-prompt-input")).toHaveCount(0);
  // 보드는 그대로 보인다(맥락 유지)
  await expect(page.getByTestId("tactics-board")).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}r1-rail-player-1280.png`, fullPage: true });

  // 닫기 → 팀 지시 복귀
  await page.getByTestId("rail-close").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
});

test("R1 탭-투-플레이스: 슬롯 탭 → 자동 필터 → 선수 탭 → 배치 (역방향 포함)", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, []); // 빈 덱
  await page.setViewportSize({ width: 390, height: 844 });
  await openDeck(page);

  await expect(page.getByTestId("starter-count")).toHaveText("선발 0/11");

  // 정방향: MF 슬롯(slotIndex 6) 탭 → 리스트가 MF 로 자동 필터
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("picker-filter-MF")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("picker-sort-note")).toContainText("MF");
  // 그 포지션 추천순 1위(MF1=84) 탭 → 배치
  await page.getByTestId("pick-MF1").click();
  await expect(page.getByTestId("board-slot-starter-6")).toHaveAttribute("data-filled", "true");
  await expect(page.getByTestId("starter-count")).toHaveText("선발 1/11");
  await expect(page.getByTestId("rail-title")).toHaveText("미드하나");

  // 배치 대기는 보드 바의 명시적 [취소]로 되돌릴 수 있다(모바일 독이 접혀 있어도 취소 가능)
  await page.getByTestId("picker-filter-FW").click();
  await page.getByTestId("pick-FW2").click();
  await expect(page.getByTestId("place-pending-hint")).toContainText("공격둘");
  await page.getByTestId("place-cancel").click();
  await expect(page.getByTestId("place-cancel")).toHaveCount(0);
  await expect(page.getByTestId("pick-FW2")).toHaveAttribute("data-pending", "false");

  // 역방향: 선수 먼저 탭 → 슬롯 탭
  await page.getByTestId("picker-filter-GK").click();
  await page.getByTestId("pick-GK1").click();
  await expect(page.getByTestId("pick-GK1")).toHaveAttribute("data-pending", "true");
  await expect(page.getByTestId("starter-count")).toHaveText("선발 1/11"); // 아직 배치 전
  await page.getByTestId("board-slot-starter-0").click();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 2/11");
  await expect(page.getByTestId("board-slot-starter-0")).toHaveAttribute("data-filled", "true");

  // 토큰↔토큰 = 자리 교체 (직전 배치로 남아있는 선택은 레일 닫기로 비운다)
  await page.getByTestId("rail-close").click();
  await expect(page.getByTestId("directive-rail")).toHaveAttribute("data-mode", "team");
  await page.getByTestId("token-MF1").click();
  await page.getByTestId("board-slot-starter-0").click();
  await expect(page.getByTestId("board-slot-starter-0").getByTestId("token-MF1")).toBeVisible();
  await expect(page.getByTestId("board-slot-starter-6").getByTestId("token-GK1")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText("선발 2/11");

  await page.screenshot({ path: `${SMOKE_DIR}r1-tap-place-390.png`, fullPage: true });
});

test("R1 반응형: 390 / 1024 / 1280px 가로 오버플로 0", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page, seededDeck());
  await openDeck(page);

  for (const width of [390, 1024, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(180);
    const overflow = await overflowPx(page);
    console.log(`[smoke] ${width}px horizontal overflow px = ${overflow}`);
    expect(overflow, `${width}px 가로 오버플로`).toBeLessThanOrEqual(0);
    await page.screenshot({ path: `${SMOKE_DIR}r1-teamsheet-${width}.png`, fullPage: true });
  }

  // 데스크탑에서는 레일이 우측 고정 컬럼(보드 오른쪽)에 있다.
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(180);
  const geom = await page.evaluate(() => {
    const board = document.querySelector('[data-testid="board-card"]')!.getBoundingClientRect();
    const rail = document.querySelector('[data-testid="directive-rail"]')!.getBoundingClientRect();
    return { boardRight: board.right, railLeft: rail.left };
  });
  expect(geom.railLeft).toBeGreaterThanOrEqual(geom.boardRight - 1);
});
