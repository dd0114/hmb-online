import { test } from "@playwright/test";
import { skipSplash } from "./splash-mock";

/**
 * #493 W5 증빙 캡처 — 홈 [게임 시작] → 연습경기 튜토리얼 제안 모달 (390×844).
 *
 * ⚠️ 계약이 아니라 **증빙**이다(`*.capture.ts` 라 `testMatch: **\/*.spec.ts` 밖 — 게이트에 안 낀다).
 * 목 형상은 `p493-practice-tutorial.spec.ts` 와 같다.
 */
const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const USER_ID = "u493p";

test.use({ viewport: { width: 390, height: 844 } });

test("capture: 연습경기 튜토리얼 제안 모달", async ({ page }) => {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route(
    (url) => url.pathname === "/api/me",
    (route) =>
      route.fulfill(
        json({
          user: { id: USER_ID, nickname: "연습감독", tutorialDone: true },
          wallet: { points: 3000, gems: 0 },
          records: { wins: 0, draws: 0, losses: 0 },
          rating: 1000,
        }),
      ),
  );
  await page.route(
    (url) => url.pathname === "/api/deck",
    (route) =>
      route.fulfill(
        json({
          formation: "4-3-3",
          slots: Array.from({ length: 11 }, (_, i) => ({
            playerId: `P${String(i + 1).padStart(3, "0")}`,
            role: "starter",
            order: i,
            promptText: "",
          })),
        }),
      ),
  );
  await skipSplash(page);
  await page.addInitScript((uid) => {
    window.localStorage.setItem("hmb.auth.token", "tok_user");
    window.localStorage.setItem(`hmb.guide.pending.${uid}`, "1");
  }, USER_ID);

  await page.goto("/home");
  await page.getByTestId("home-tile-game").click();
  await page.getByTestId("practice-tutorial-dialog").waitFor();
  await page.screenshot({ path: process.env.CAP_OUT ?? "test-results/p493-w5-modal.png" });
});
