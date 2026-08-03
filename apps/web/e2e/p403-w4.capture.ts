import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import {
  MATCH_ID,
  NO_LOG_MATCH_ID,
  PHONE,
  authInit,
  mockApi,
  mockNoLogMatch,
  mockPastLogs,
  open,
} from "./p403-mocks";

/**
 * #403 W4 실화면 캡처 — **증빙**이지 판정이 아니다(루트 §2-2).
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5296 npx playwright test -c playwright.capture.config.ts p403-w4
 *
 * 왜 찍나: W2·W3 **둘 다** 계약이 전부 green 인데 캡처에서만 보인 결함이 있었고 같은 부류였다
 * (한 스크롤러를 공유하는 전환의 스크롤 이월). W4 의 팀 세그먼트가 같은 구조라 **양방향**으로 찍는다.
 */
const OUT = new URL("../.smoke/p403w4/", import.meta.url).pathname;

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.use({ viewport: PHONE, hasTouch: true });

/** 결과 패널은 자기 안에서 스크롤하므로 fullPage 로는 아래가 안 잡힌다 → 위치를 옮겨 가며 찍는다. */
async function shotAt(page: Page, name: string, scrollTo: "top" | "players" | "bottom") {
  await page.evaluate((where) => {
    const sc = document.querySelector('[data-testid="result-scroll"]') as HTMLElement | null;
    if (!sc) return;
    if (where === "top") sc.scrollTop = 0;
    else if (where === "bottom") sc.scrollTop = sc.scrollHeight;
    else {
      const sec = document.querySelector('[data-testid="result-players"]') as HTMLElement | null;
      if (sec) sc.scrollTop = sec.offsetTop - sc.offsetTop - 8;
    }
  }, scrollTo);
  await page.waitForTimeout(350);
  await page.screenshot({ path: `${OUT}${name}.png` });
}

test("결과 탭 — 개인 성적 (폰)", async ({ page }) => {
  await open(page, "FINISHED");
  await page.getByTestId("stage-tab-result").click();
  await page.getByTestId("result-players").waitFor();
  await shotAt(page, "result-top", "top");
  await shotAt(page, "result-players-mine", "players");
  await shotAt(page, "result-bottom", "bottom");

  // 세그먼트 전환 — **양방향**(우리→상대→우리). 스크롤 이월·클리핑이 보이는 자리.
  await page.getByTestId("players-team-home").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}result-players-opponent.png` });
  await page.getByTestId("players-team-away").click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}result-players-back-to-mine.png` });
});

test("결과 탭 — 개인 성적 (데스크탑 1280×800)", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await open(page, "FINISHED");
  await page.getByTestId("stage-tab-result").click();
  await page.getByTestId("result-players").waitFor();
  await shotAt(page, "desktop-result-top", "top");
  await shotAt(page, "desktop-result-players", "players");
  await shotAt(page, "desktop-result-bottom", "bottom");
});

test("로그 없는 과거 경기 — 빈 상태", async ({ page }) => {
  await mockApi(page, "FINISHED");
  await mockNoLogMatch(page);
  await authInit(page);
  await page.goto(`/match/${NO_LOG_MATCH_ID}`);
  await page.getByTestId("stage-shell").waitFor();
  await page.getByTestId("stage-tab-result").click();
  await page.getByTestId("result-players-missing").waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}result-no-log.png` });
});

test("과거 경기 목록 — `▶ 기록` 뱃지", async ({ page }) => {
  await mockApi(page, "FINISHED");
  await mockPastLogs(page);
  await authInit(page);
  await page.goto("/logs");
  await page.getByTestId(`match-log-${MATCH_ID}`).waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${OUT}logs-list.png` });
});
