import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { bootstrap, deckSlots, ELEVEN } from "./deck-mock";
import { openDeckPanel } from "./deck-tabs";

/**
 * #455 **hero 컨펌용 실화면 캡처** — A-0 목업 · A1 · A2 · A2-2 · A3.
 *
 * ⚠️ **계약이 아니라 관측이다.** 여기서 red/green 은 아무것도 판정하지 않는다(그 판정은
 * `p455-a*.spec.ts` 가 소유). 이 파일이 하는 일은 hero 가 **눈으로 볼 그림**을 뽑는 것뿐이고,
 * 그래서 `.capture.ts`(= `testMatch` 밖)라 `npm run e2e` 에 딸려 돌지 않는다.
 *
 * 실행:
 *   CI=1 WEB_E2E_PORT=5455 npx playwright test --config=playwright.capture.config.ts \
 *     e2e/p455-hero.capture.ts
 *
 * 산출: `apps/web/.stage/p455/*.png`(gitignore) → `tools/p455-hero-html.mjs` 가 한 개의
 * 자립 HTML 로 인라인한다. **리포의 `evidence/**` 에는 쓰지 않는다.**
 */

const OUT = new URL("../.stage/p455/", import.meta.url).pathname;
const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 900 };

mkdirSync(OUT, { recursive: true });

async function shot(page: Page, name: string) {
  await page.waitForTimeout(250); // 시트 슬라이드업 등 전이 종료
  await page.screenshot({ path: `${OUT}${name}.png` });
  console.log(`[#455-capture] ${name}.png`);
}

/** 선발 8 + 벤치 1 = **빈칸이 남은 덱**(A3 ②의 양성 표본). */
function gapSlots() {
  return [
    ...ELEVEN.slice(0, 8).map((playerId, i) => ({ playerId, role: "starter", slotIndex: i, promptText: null })),
    { playerId: "GK2", role: "bench", slotIndex: 0, promptText: null },
  ];
}

/** 선발 11 + 벤치 앞 3칸 = **채워야 할 칸이 없는 덱**(A3 ②의 음성 표본). */
function noGapSlots() {
  return [...deckSlots(), { playerId: "FW4", role: "bench", slotIndex: 2, promptText: null }];
}

async function openDeck(page: Page, slots: unknown[], opts: { growthReady?: string[] } = {}) {
  await bootstrap(page, slots, null, opts);
  await page.goto("/deck");
  await expect(page.getByTestId("deck-editor")).toBeVisible();
}

// ── A-0 목업 ────────────────────────────────────────────────────────────────
test("A0 목업", async ({ page }) => {
  await page.setViewportSize({ width: 1180, height: 1000 });
  const mock = new URL("../../../docs/plan-v5/mock/455-decka/index.html", import.meta.url).pathname;
  await page.goto(`file://${mock}`);
  await page.waitForTimeout(600);
  await shot(page, "a0-mock");
});

// ── 폰 ──────────────────────────────────────────────────────────────────────
test.describe("폰 390×844", () => {
  test.use({ viewport: PHONE, hasTouch: true });

  test("A1 — 경기장 68 + 책갈피 탭 3장", async ({ page }) => {
    await openDeck(page, noGapSlots());
    await shot(page, "a1-phone-team");
    await openDeckPanel(page, "sub");
    await shot(page, "a1-phone-sub");
    await openDeckPanel(page, "tune");
    await shot(page, "a1-phone-tune");
  });

  test("A2 — 선수 메뉴 시트 → 한마디 쓰기", async ({ page }) => {
    await openDeck(page, noGapSlots());
    await page.getByTestId("token-MF1").tap();
    await expect(page.getByTestId("player-menu")).toHaveCount(1);
    await shot(page, "a2-phone-menu");
    await page.getByTestId("pmenu-say").tap();
    await expect(page.getByTestId("rail-prompt-input")).toHaveCount(1);
    await shot(page, "a2-phone-say");
  });

  test("A2-2 — 강화 대기 뱃지", async ({ page }) => {
    await openDeck(page, noGapSlots(), { growthReady: ["MF1", "FW1"] });
    await shot(page, "a22-phone-board");
    await page.getByTestId("token-MF1").tap();
    await expect(page.getByTestId("player-menu")).toHaveCount(1);
    await shot(page, "a22-phone-menu");
  });

  test("A3 — 자동 채우기(빈칸 있음 / 없음 / 빈 덱)", async ({ page }) => {
    await openDeck(page, gapSlots());
    await expect(page.getByTestId("auto-fill")).toHaveCount(1);
    await shot(page, "a3-phone-gap");

    await openDeck(page, noGapSlots());
    await expect(page.getByTestId("auto-fill")).toHaveCount(0);
    await shot(page, "a3-phone-nogap");

    await openDeck(page, []);
    await expect(page.getByTestId("board-empty")).toHaveCount(1);
    await shot(page, "a3-phone-empty");
  });
});

// ── 데스크탑 ────────────────────────────────────────────────────────────────
test.describe("데스크탑 1280×900", () => {
  test.use({ viewport: DESKTOP });

  test("A1 — stack 레이아웃(탭 없음)", async ({ page }) => {
    await openDeck(page, noGapSlots(), { growthReady: ["MF1", "FW1"] });
    await shot(page, "a1-desktop");
    await page.getByTestId("token-MF1").click();
    await shot(page, "a2-desktop-select");
  });

  test("A3 — 데스크탑 자동 채우기", async ({ page }) => {
    await openDeck(page, gapSlots());
    await shot(page, "a3-desktop-gap");
  });
});

test.afterAll(() => {
  writeFileSync(`${OUT}README.txt`, "#455 hero 컨펌용 캡처 — tools/p455-hero-html.mjs 로 HTML 조립\n");
});
