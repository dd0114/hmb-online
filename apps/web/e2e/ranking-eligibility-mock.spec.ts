import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";

/**
 * #296 AC5 — 랭킹 노출 자격의 **화면 쪽 계약**. 백엔드 없이 vite dev + `page.route` 로 `/api` 전면 목킹.
 *
 * <p>왜 이 스펙이 필요한가: 서버가 "한 판이라도 끝낸 유저만" 리더보드에 싣게 되면서, 아직 안 한
 * 유저의 `me` 는 {@code eligible=false · rank=null} 로 온다. 이걸 화면이 안 다루면 순위 칸이 빈 채로
 * 그려지고, 유저는 자기가 왜 목록에 없는지 알 수 없다. 더 나쁜 경우는 서버가 404 를 주던 초안인데
 * (`getRankings` 가 me 를 필터된 목록에서 찾았다) 그러면 이 탭이 통째로
 * "랭킹을 불러오지 못했습니다" 에러 토스트가 된다 — **신규 유저가 처음 보는 화면이 에러**다.
 *
 * 박제하는 계약:
 *  (1) 미자격 — 리더보드는 정상 렌더 + 내 자리에 "한 판 하면 등록됩니다" 안내 + **에러 토스트 0**
 *  (2) 자격 — 안내문 없이 평소대로 순위·승수가 보인다
 *
 * 스펙 지정 실행 · 대체 포트(playwright.config PORT=5199, :8080 데모 무접촉) · pathname 매칭(glob 아님).
 * ⚠️ 라우트는 **pathname** 으로 잡는다 — glob 을 오리진 없이 쓰면 vite 에셋까지 걸려 흰 화면이 된다.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({
  status: 200,
  contentType: "application/json",
  body: JSON.stringify(body),
});

/** 리더보드에 실린 자격자들 — 미자격 유저 화면에서도 이건 그대로 보여야 한다. */
const BOARD = [
  { userId: "U_A", nickname: "햄춘", wins: 1, winRate: 0.5, rank: 1, rating: 10, eligible: true },
  { userId: "U_B", nickname: "별희", wins: 4, winRate: 0.66, rank: 2, rating: 0, eligible: true },
  { userId: "U_C", nickname: "우보긴", wins: 1, winRate: 1, rank: 3, rating: 0, eligible: true },
];

function rankingsPayload(eligible: boolean) {
  return {
    leaderboard: BOARD,
    me: eligible
      ? { userId: "U_ME", nickname: "테스터", wins: 2, winRate: 0.5, rank: 4, rating: 0, eligible: true }
      : // 서버가 미자격에게 주는 모양: 200 · rank 없음 · eligible=false.
        { userId: "U_ME", nickname: "테스터", wins: 0, winRate: 0, rank: null, rating: 0, eligible: false },
    personalRecords: { topScorer: null, topScorerGoals: null, longestWinStreak: 0, totalMatches: 0 },
  };
}

async function bootstrap(page: Page, opts: { eligible: boolean }) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  // 캐치올 먼저 — 이후 등록한 구체 라우트가 우선한다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(
      json({
        user: { id: "U_ME", nickname: "테스터", isAdmin: false, tutorialDone: true },
        wallet: { points: 3000, gems: 0 },
        records: { wins: 0, draws: 0, losses: 0 },
        rating: 0,
      }),
    ),
  );
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json([])));
  // ⚠️ 로그 페이지의 **다른 탭** 쿼리도 채워야 한다 — 캐치올 `{}` 는 배열 자리에 객체를 주고,
  // 리스트 렌더가 그걸 map 하다 터지면 페이지가 통째로 재마운트돼 탭 클릭조차 붙지 않는다.
  await page.route((url) => url.pathname === "/api/logs/matches", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/logs/trades", (route) => route.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/rankings", (route) =>
    route.fulfill(json(rankingsPayload(opts.eligible))),
  );
  await page.goto("/logs");
  await page.getByTestId("logs-tab-rankings").click();
}

test.describe("#296 랭킹 자격 — 화면", () => {
  test("미자격: 리더보드는 그대로 보이고 내 자리엔 안내문 (에러 토스트 없음)", async ({ page }) => {
    await bootstrap(page, { eligible: false });

    // 탭이 살아 있다 = 404 로 에러 화면이 되지 않았다.
    await expect(page.getByTestId("logs-rankings")).toBeVisible();
    await expect(page.getByTestId("leaderboard")).toBeVisible();
    // 자격자 3명은 정상 노출.
    for (const e of BOARD) {
      await expect(page.locator(`[data-testid="lb-${e.userId}"]`)).toBeVisible();
    }
    // 내 자리 = 순위 대신 무엇을 하면 되는지.
    await expect(page.getByTestId("lb-me-hint")).toContainText("경기를 한 판 하면 랭킹에 등록됩니다");
    // ⚠️ 이 단언이 이 스펙의 핵심이다 — 초안 서버(404)로 되돌리면 여기서 걸린다.
    await expect(page.getByText("랭킹을 불러오지 못했습니다")).toHaveCount(0);

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}ranking-ineligible.png`, fullPage: true });
  });

  test("자격: 안내문 없이 평소대로 내 순위가 보인다", async ({ page }) => {
    await bootstrap(page, { eligible: true });

    await expect(page.getByTestId("logs-rankings")).toBeVisible();
    await expect(page.getByTestId("lb-me-hint")).toHaveCount(0);
    await expect(page.getByTestId("lb-me")).toContainText("테스터 (나)");

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}ranking-eligible.png`, fullPage: true });
  });
});
