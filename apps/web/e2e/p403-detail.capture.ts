import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  H2_SCORER,
  PHONE,
  mockDeckPrompt,
  mockGrowthCard,
  open,
  openDetail,
  seek,
  viewerReady,
} from "./p403-mocks";

/**
 * #403 W3 선수 상세 실화면 캡처 — **증빙**이지 판정이 아니다(루트 §2-2).
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5295 npx playwright test -c playwright.capture.config.ts p403-detail
 */
const OUT = new URL("../.smoke/p403w3/", import.meta.url).pathname;
const MY_TEAM = "away" as const;
const OPP_TEAM = "home" as const;
const OPP_FW = "P171";

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.use({ viewport: PHONE, hasTouch: true });

/** 모달 본문이 자기 안에서 스크롤하므로 fullPage 로는 아래가 안 잡힌다 → 본문을 끝까지 밀어 두 장. */
async function shots(page: import("@playwright/test").Page, name: string) {
  await page.waitForTimeout(500);
  await page.screenshot({ path: `${OUT}${name}-top.png` });
  await page.locator('[data-testid="player-detail"] >> xpath=.').evaluate(() => {
    const body = document.querySelector('[data-testid^="pdetail-panel-"]') as HTMLElement | null;
    if (body) body.scrollTop = body.scrollHeight;
  });
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}${name}-bottom.png` });
}

test("내 선수 — [이 경기] · [선수 정보](full)", async ({ page }) => {
  await open(page, "SECOND_HALF");
  await mockGrowthCard(page, H2_SCORER);
  await mockDeckPrompt(page, H2_SCORER, "박스 안에서 과감하게 슈팅해라. 수비 뒷공간을 노려라.");
  // 재생 위치를 후반 후반부로 옮긴다 — 0틱에서 찍으면 전 항목이 0 이라 "무엇이 보이나"를 못 본다.
  await viewerReady(page);
  await seek(page, 1700);
  await page.getByTestId("stage-tab-players").click();
  await openDetail(page, MY_TEAM, H2_SCORER);

  await shots(page, "mine-match");
  await page.getByTestId("pdetail-tab-info").click();
  await shots(page, "mine-info-radar");
  await page.getByTestId("growth-layer-total").click();
  await shots(page, "mine-info-bars");
});

test("상대 선수 — [선수 정보](reduced)", async ({ page }) => {
  await open(page, "SECOND_HALF");
  await viewerReady(page);
  await seek(page, 1700);
  await page.getByTestId("stage-tab-players").click();
  await openDetail(page, OPP_TEAM, OPP_FW);

  await shots(page, "opp-match");
  await page.getByTestId("pdetail-tab-info").click();
  await shots(page, "opp-info-radar");
  await page.getByTestId("growth-layer-total").click();
  await shots(page, "opp-info-bars");
});
