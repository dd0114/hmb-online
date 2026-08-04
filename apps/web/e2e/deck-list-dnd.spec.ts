import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * W4 리스트→보드 드래그앤드롭 + 추천정렬 + 스탯총량 route-mock 스모크 (이슈 #98 요구 5 · 6 부분).
 * 백엔드 없이 vite dev + page.route 로 /api 를 목킹해 브라우저에서 박제한다:
 *   1) 보유 선수 리스트가 "추천순"(ALL=overall 내림차순)으로 렌더 + 각 항목 스탯총량(종합) 노출.
 *   2) 리스트 항목을 보드 빈 슬롯으로 @dnd-kit 포인터 드래그 → 슬롯 채워짐 + 리스트에서 placed 표시.
 *   3) 포지션 필터(DF) 시 그 포지션 내 추천순(overall 내림차순).
 * 드래그는 pointer(mouse) 이벤트 시뮬(@dnd-kit PointerSensor, distance:6 초과 후 target 센터로 이동).
 * 스크린샷 = apps/web/.smoke/.
 *
 * ⚠️ 이 스펙의 뷰포트 390x2200 은 **실재하지 않는 폰 크기**다(보드+리스트가 한 화면에 다 들어와
 * 스크롤 자체가 불필요해지는 인공 조건). 남겨두는 이유 = **데스크탑/포인터 경로 회귀 가드**
 * (정렬·스탯총량·필터·탭투플레이스 + 마우스 드래그). 그래서 이 스펙만으로는 실제 폰 버그를
 * 구조적으로 못 잡는다 — 실제로 리스트 행에 `touch-action: none` 이 빠져 폰에서 드래그가
 * 100% 실패했는데 이 스펙은 통과했다.
 * **실제 폰 조건(390x844 + hasTouch + 실터치 이벤트)은 `deck-list-dnd-touch.spec.ts` 가 담당한다.**
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;

/** All 9 attrs = overall so the displayed 종합 값 == overall (playerOverall mean). */
function attrs(overall: number) {
  return {
    technical: overall, mental: overall, physical: overall, passing: overall, shooting: overall,
    tackling: overall, pace: overall, stamina: overall, positioning: overall,
  };
}

const P = (id: string, name: string, position: string, grade: string, overall: number) => ({
  id, name, position, grade, owned: true, ownedCount: 1, attributes: attrs(overall), personality: "CALM",
});

/**
 * 14 owned players, distinct overalls, INPUT ORDER DELIBERATELY SHUFFLED (not by overall/id) so the
 * rendered order proves the recommended sort rather than server order.
 */
const PLAYERS = [
  P("MF_MID", "미드미드", "MF", "SILVER", 65),
  P("FW_TOP", "탑공격수", "FW", "LEGEND", 92),
  P("GK1", "골리1", "GK", "SILVER", 55),
  P("DF_LOW", "약수비", "DF", "BRONZE", 48),
  P("MF_TOP", "탑미드", "MF", "DIA", 88),
  P("DF_HI", "강수비", "DF", "GOLD", 78),
  P("FW_MID", "중공격", "FW", "SILVER", 70),
  P("GK2", "골리2", "GK", "SILVER", 60),
  P("MF_LOW", "약미드", "MF", "BRONZE", 50),
  P("DF_MID", "중수비", "DF", "SILVER", 66),
  P("FW_LOW", "약공격", "FW", "BRONZE", 58),
  P("MF_A", "미드A", "MF", "GOLD", 72),
  P("DF_B", "수비B", "DF", "SILVER", 63),
  P("MF_B", "미드B", "MF", "SILVER", 69),
];

const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

/** Stateful mock: no active deck (all board slots empty) so a dragged player lands on an empty slot. */
async function mockApi(page: Page) {
  const state = { deck: { formation: "4-4-2", slots: [] as unknown[] } };
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS)));
  await page.route((url) => url.pathname === "/api/presets", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/relations", (route) => route.fulfill(json({ morale: 60, streak: 0, players: [] })));
  await page.route((url) => url.pathname === "/api/deck", (route) => {
    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON();
      state.deck = { formation: body.formation, slots: body.slots };
    }
    return route.fulfill(json(state.deck));
  });
  await page.route((url) => url.pathname === "/api/presets/team", (route) =>
    route.fulfill(json([{ slot: 1, name: null, snapshot: null }, { slot: 2, name: null, snapshot: null }, { slot: 3, name: null, snapshot: null }])),
  );
}

/** @dnd-kit pointer drag: press, exceed activation distance, glide to target center, release. */
async function pointerDrag(page: Page, sourceTestId: string, targetTestId: string) {
  const src = await page.getByTestId(sourceTestId).boundingBox();
  const dst = await page.getByTestId(targetTestId).boundingBox();
  if (!src || !dst) throw new Error(`missing box: ${sourceTestId} / ${targetTestId}`);
  const sx = src.x + src.width / 2, sy = src.y + src.height / 2;
  const dx = dst.x + dst.width / 2, dy = dst.y + dst.height / 2;
  await page.mouse.move(sx, sy);
  await page.mouse.down();
  await page.mouse.move(sx + 10, sy + 10); // exceed PointerSensor distance:6
  await page.mouse.move(dx, dy, { steps: 14 });
  await page.mouse.move(dx, dy);
  await page.mouse.up();
}

/** data-testids of the pool row buttons, in rendered order. */
/**
 * ⚠️ **`pick-` 접두 스캔은 그 네임스페이스에 뭘 더하면 조용히 깨진다.** 이미 `pick-overall-` 을
 * 한 번 제외했고, #442 가 행에 [투입] 버튼을 더할 때 `pick-assign-` 으로 지었다가 여기서
 * **행 14개가 15개로 늘어 red** 가 났다(그래서 `pool-assign-` 으로 갈랐다).
 * 리스트 행에 새 손잡이를 붙일 땐 이 스캐너를 먼저 보고 **다른 접두**를 써라.
 */
async function poolOrder(page: Page): Promise<string[]> {
  return page.locator('button[data-testid^="pick-"]:not([data-testid^="pick-overall-"])').evaluateAll((els) =>
    els.map((el) => el.getAttribute("data-testid")!.replace("pick-", "")),
  );
}

test("W4 리스트 추천정렬 + 스탯총량 + 리스트→보드 드래그", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  // Tall viewport so board (top) + pool list (bottom) are both on-screen for a single mouse drag.
  // (인공 조건 — 실폰 터치 경로는 deck-list-dnd-touch.spec.ts. 위 헤더 주석 참고.)
  await page.setViewportSize({ width: 390, height: 2200 });
  await page.goto("/deck");

  await expect(page.getByTestId("deck-editor")).toBeVisible();
  // #244: 보유 선수 리스트는 **시트** 뒤로 갔다 — 정렬·스탯 계약은 시트 안에서 검증한다.
  await page.getByTestId("pool-sheet-open").click();
  await expect(page.getByTestId("player-pool")).toBeVisible();

  // 1) "추천순" 라벨 노출.
  await expect(page.getByTestId("picker-sort-note")).toBeVisible();

  // 2) ALL 필터: overall 내림차순 (입력순서 무관). 상위 3개만 강하게 박제.
  const all = await poolOrder(page);
  expect(all.slice(0, 3)).toEqual(["FW_TOP", "MF_TOP", "DF_HI"]);
  expect(all).toHaveLength(14);
  // 결정론: 전체가 overall desc, tie 없음 → 완전 순서.
  expect(all).toEqual([
    "FW_TOP", "MF_TOP", "DF_HI", "MF_A", "FW_MID", "MF_B", "DF_MID",
    "MF_MID", "DF_B", "GK2", "FW_LOW", "GK1", "MF_LOW", "DF_LOW",
  ]);

  // 3) 스탯총량(종합) 노출 + 값 정확.
  await expect(page.getByTestId("pick-overall-FW_TOP")).toHaveText("92");
  await expect(page.getByTestId("pick-overall-DF_LOW")).toHaveText("48");

  await page.screenshot({ path: `${SMOKE_DIR}w4-list-recsort.png`, fullPage: true });

  // 4) #244: **리스트→보드 드래그는 은퇴**했다 — 리스트가 시트(모달) 안이라 보드를 덮으므로
  //    끌어다 놓을 대상이 화면에 없다. 배치는 시트에서 고르면 끝이고(1급), 남은 드래그 계약은
  //    **보드↔보드(자리 교체)** 다. 여기서는 시트로 배치한 뒤 보드 위 드래그를 박제한다.
  await expect(page.getByTestId("board-slot-starter-9").getByTestId("token-FW_TOP")).toHaveCount(0);
  await page.getByTestId("pool-sheet-close").click();
  await page.getByTestId("board-slot-starter-9").click(); // 자리에서 열면 그 자리에 들어간다
  await page.getByTestId("pick-FW_TOP").click();
  await expect(page.getByTestId("pool-sheet")).toBeHidden();

  // 슬롯 채워짐 + 선발 카운트 1 + 그 선수 지시로 이어짐(#244).
  await expect(page.getByTestId("board-slot-starter-9").getByTestId("token-FW_TOP")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText(/1\/11/);
  await expect(page.getByTestId("rail-prompt-input")).toBeVisible();
  await page.screenshot({ path: `${SMOKE_DIR}w4-after-sheet-place.png`, fullPage: true });

  // 5) **살아남은 드래그 계약 = 보드↔보드(자리 교체)**. 리스트→보드는 은퇴(위 4 주석).
  await page.getByTestId("board-slot-starter-6").click();
  await expect(page.getByTestId("pool-sheet")).toBeVisible();
  await page.getByTestId("pick-MF_TOP").click();
  await expect(page.getByTestId("starter-count")).toHaveText(/2\/11/);
  await page.waitForTimeout(300); // @dnd-kit 클릭 억제 창(≈50ms) 여유
  await pointerDrag(page, "token-FW_TOP", "board-slot-starter-6");
  await expect(page.getByTestId("board-slot-starter-6").getByTestId("token-FW_TOP")).toBeVisible();
  await expect(page.getByTestId("board-slot-starter-9").getByTestId("token-MF_TOP")).toBeVisible();
  await expect(page.getByTestId("starter-count")).toHaveText(/2\/11/);

  // 6) 포지션 필터(DF): 그 포지션 내 추천순(overall desc).
  // 드롭 직후 첫 클릭은 @dnd-kit 클릭 억제 창(≈50ms)에 먹힌다 → 여유를 주고 시트 오픈을 확인한다.
  await page.waitForTimeout(300);
  await page.getByTestId("pool-sheet-open").click();
  await expect(page.getByTestId("pool-sheet")).toBeVisible();
  await page.getByTestId("picker-filter-DF").click();
  const dfOrder = await poolOrder(page);
  expect(dfOrder).toEqual(["DF_HI", "DF_MID", "DF_B", "DF_LOW"]);
  await page.getByTestId("pool-sheet-close").click();

  // 7) 390px 가로 오버플로 0.
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(150);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] 390px horizontal overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
});
