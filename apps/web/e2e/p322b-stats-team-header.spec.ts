import { expect, test, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * #322 후속 — **통계 탭의 두 열이 누구인지 화면이 말한다.**
 *
 * ── 왜 지금 필요해졌나 ────────────────────────────────────────────────────────────────────
 * 통계 탭은 `[왼쪽 값] [항목] [오른쪽 값]` 좌우 대칭 막대인데 **열 이름이 없다**(색만 있다).
 * #322 이전에는 홈이 **항상** 유저였으므로 "왼쪽 = 나"가 학습된 위치였고 이름이 없어도 읽혔다.
 * #322 로 표시가 픽스처 사이드를 따르게 되면서 **어웨이 라운드에는 왼쪽이 봇**이다 — 그 전제가
 * 깨졌다. 즉 이 공백은 원래 있던 게 아니라 **#322 가 만든 것**이라 같이 닫는다.
 *
 * 같은 화면의 결과 탭은 이미 팀명 헤더(`<th>`)를 갖고 있었다 — 비대칭이 그 자체로 신호였다.
 *
 * 계약:
 *  a. 통계 탭에 팀 이름 두 개가 **사이드 순서대로** 뜬다(왼쪽 = home).
 *  b. 어웨이 라운드면 왼쪽이 봇이다 — 스코어바와 **같은 순서**(둘이 어긋나면 더 나쁘다).
 *  c. 내 팀 표식이 통계에도 붙는다(스코어바에서 배운 것을 여기서 다시 찾지 않게).
 *  d. 유저 홈 라운드 무회귀 — 왼쪽이 유저.
 */

const LOG_H1 = JSON.parse(readFileSync(new URL("./fixtures/p322-half1.json", import.meta.url).pathname, "utf8"));
const LOG_H2 = JSON.parse(readFileSync(new URL("./fixtures/p322-half2.json", import.meta.url).pathname, "utf8"));

const MATCH_ID = "m-stats-322b";
const ME = "축구왕여르";
const BOT = "Thunder Bay United";

async function open(page: Page, userAway: boolean) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: ME, points: 0, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: "FINISHED",
          scoreH1Home: 1,
          scoreH1Away: 3,
          scoreHome: 1,
          scoreAway: 5,
          result: userAway ? "WIN" : "LOSS",
          createdAt: "2026-07-30T08:37:23Z",
          mode: "league",
          leagueFixtureId: "f1",
          ownerName: ME,
          homeName: userAway ? BOT : ME,
          awayName: userAway ? ME : BOT,
          opponent: { name: BOT, deck: [] },
        },
      });
    }
    if (/halves\/1\/log$/.test(url.pathname)) return route.fulfill({ json: LOG_H1 });
    if (/halves\/2\/log$/.test(url.pathname)) return route.fulfill({ json: LOG_H2 });
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { result: userAway ? "WIN" : "LOSS", scoreHome: 1, scoreAway: 5, pointsAwarded: 0 },
      });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: [] });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-3-3", slots: [] } });
    return route.fulfill({ json: {} });
  });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  await page.getByTestId("stage-tab-stats").click();
  await expect(page.getByTestId("stage-panel-stats")).toBeVisible();
}

test.use({ viewport: { width: 390, height: 844 } });

test("a·b. 어웨이 라운드 — 통계 열 이름이 사이드 순서대로(왼쪽=봇), 스코어바와 같은 순서", async ({ page }) => {
  await open(page, true);
  await expect(page.getByTestId("stats-team-home")).toHaveText(BOT);
  await expect(page.getByTestId("stats-team-away")).toHaveText(ME);

  // 스코어바와 같은 순서여야 한다 — 두 줄이 서로 다른 팀을 왼쪽이라 하면 없는 것만 못하다.
  const barHome = await page.locator('[data-team-side="home"] > span').first().innerText();
  expect(BOT.startsWith(barHome.replace(/…$/, "").trim())).toBe(true);
});

test("c. 내 팀 표식이 통계에도 붙는다", async ({ page }) => {
  await open(page, true);
  await page.screenshot({
    path: (process.env.HMB_CAP_DIR ?? "test-results/p322b/").replace(/\/?$/, "/") + "stats-away.png",
  });
  const mine = page.getByTestId("stats-my-team");
  await expect(mine).toBeVisible();
  await expect(mine).toHaveAttribute("data-side", "away");
});

test("d. 유저 홈 라운드 무회귀 — 왼쪽이 유저", async ({ page }) => {
  await open(page, false);
  await expect(page.getByTestId("stats-team-home")).toHaveText(ME);
  await expect(page.getByTestId("stats-team-away")).toHaveText(BOT);
  await expect(page.getByTestId("stats-my-team")).toHaveAttribute("data-side", "home");
});
