import { test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * 실화면 캡처 하니스 (#169 S1) — `/visual-capture-qa` 루프용. 판정이 아니라 **증빙 생성**이 목적이다.
 * (좌표 추론 금지 — 실제 화면을 찍어 눈으로 본다. 루트 CLAUDE §2-2/§2.5-3.)
 *
 * 출력: apps/web/.stage-capture/<label>-<view>.png
 *   HMB_CAPTURE_LABEL=before  → 개편 전(스크롤 페이지) 캡처
 *   HMB_CAPTURE_LABEL=after   → 개편 후(고정 셸) 캡처
 *
 * 실행: WEB_E2E_PORT=5233 HMB_CAPTURE_LABEL=after npx playwright test e2e/stage-capture.spec.ts
 */

const LABEL = process.env.HMB_CAPTURE_LABEL ?? "after";
const CAP_DIR = new URL("../.stage-capture/", import.meta.url).pathname;
const MATCH_ID = "m-cap";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}`, role: "starter" as const })),
    ...Array.from({ length: 5 }, (_, i) => ({ slotIndex: i, playerId: `b${i + 1}`, role: "bench" as const })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "B",
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "C",
  })),
];

async function mockApi(page: Page, state: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 1200, wins: 3, draws: 1, losses: 2, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          scoreH1Home: 2,
          scoreH1Away: 1,
          scoreHome: 3,
          scoreAway: 2,
          result: "WIN",
          createdAt: "2026-07-22T09:00:00Z",
          opponent: { name: "뮌헨봇" },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: MATCH_LOG });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({ json: { result: "WIN", scoreHome: 3, scoreAway: 2, pointsAwarded: 120 } });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function open(page: Page, state: string) {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
    // (#284 로 `hmb.stage.toggles` 는 사라졌다 — 지울 것도 없다.)
  });
  await page.goto(`/match/${MATCH_ID}`);
  /*
   * ⚠️ 감독시간엔 무대가 **상시가 아니라 `경기장면` 탭 뒤**다(#244). 이 헬퍼는 그걸 모른 채
   * 무대를 무조건 기다려서, #244 머지(2026-07-29) 이후 halftime 캡처 2건이 계속 타임아웃이었다
   * (이 파일은 2026-07-22 #169 이후 손대지 않았다). 캡처 스펙이라 아무도 안 봤다.
   */
  if (state === "H1_BREAK" || state === "HALFTIME") {
    await page.getByTestId("stage-tab-stage").click();
  }
  await page.getByTestId(`match-viewer-half${state === "FINISHED" ? 2 : 1}`).waitFor({ timeout: 20_000 });
  // 경기가 충분히 진행돼 통계에 실제 수치가 쌓인 뒤 찍는다(0 만 있는 캡처는 검수가 안 된다).
  await page.waitForTimeout(Number(process.env.HMB_CAPTURE_WAIT_MS ?? 4000));
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test.describe("phone 390×844", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("halftime", async ({ page }) => {
    await open(page, "H1_BREAK");
    await page.screenshot({ path: `${CAP_DIR}${LABEL}-phone-halftime.png` });
    await page.screenshot({ path: `${CAP_DIR}${LABEL}-phone-halftime-full.png`, fullPage: true });
  });

  // #284: 토글이 사라지고 정보 탭이 상시가 됐다 — 켜는 단계 없이 탭만 고른다.
  test("halftime + 통계·로그 탭", async ({ page }) => {
    await open(page, "H1_BREAK");
    const stats = page.getByTestId("stage-tab-stats");
    if (await stats.count()) {
      await stats.click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${CAP_DIR}${LABEL}-phone-stats.png` });
      await page.getByTestId("stage-tab-log").click();
      await page.waitForTimeout(600);
      await page.screenshot({ path: `${CAP_DIR}${LABEL}-phone-log.png` });
    }
  });

  test("result", async ({ page }) => {
    await open(page, "FINISHED");
    await page.screenshot({ path: `${CAP_DIR}${LABEL}-phone-result.png` });
    await page.screenshot({ path: `${CAP_DIR}${LABEL}-phone-result-full.png`, fullPage: true });
  });
});

test.describe("desktop 1280×800", () => {
  test.use({ viewport: { width: 1280, height: 800 } });

  test("halftime", async ({ page }) => {
    await open(page, "H1_BREAK");
    await page.screenshot({ path: `${CAP_DIR}${LABEL}-desktop-halftime.png` });
    const stats = page.getByTestId("stage-tab-stats");
    if (await stats.count()) {
      await stats.click();
      await page.waitForTimeout(1200);
      await page.screenshot({ path: `${CAP_DIR}${LABEL}-desktop-stats.png` });
    }
  });
});
