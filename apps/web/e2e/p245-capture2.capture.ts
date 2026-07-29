import { test } from "@playwright/test";

/** #245 hero UI 컨펌 2차 — 랭킹(레이팅 기준) + 몰수 표기. 실제 코드 렌더. */
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

test("capture: 리더보드 레이팅 기준 + 몰수 표기", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(json({ user: { id: "u1", nickname: "감독 박", isAdmin: false, tutorialDone: true }, wallet: { points: 24300, gems: 12 }, records: { wins: 12, draws: 3, losses: 8 }, rating: 20 })));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) => r.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/relations", (r) => r.fulfill(json({ morale: 62, streak: 1, players: [] })));
  await page.route((url) => url.pathname === "/api/deck", (r) => r.fulfill(json({ code: "NOT_FOUND", message: "x" }, 404)));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/logs/matches", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/logs/trades", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/rankings", (r) =>
    r.fulfill(json({
      leaderboard: [
        { userId: "u9", nickname: "무패의 김", wins: 40, winRate: 0.9, rank: 1, rating: 120 },
        { userId: "u1", nickname: "감독 박", wins: 12, winRate: 0.52, rank: 2, rating: 20 },
        { userId: "u7", nickname: "다승의 이", wins: 55, winRate: 0.61, rank: 3, rating: 10 },
        { userId: "u3", nickname: "신규 최", wins: 0, winRate: 0, rank: 4, rating: 0 },
      ],
      me: { userId: "u1", nickname: "감독 박", wins: 12, winRate: 0.52, rank: 2, rating: 20 },
      personalRecords: { topScorer: null, topScorerGoals: null, longestWinStreak: 3, totalMatches: 23 },
    })));
  // 몰수 리포트(상대가 브리핑에서 무름) + 일반 경기 혼합
  await page.route((url) => url.pathname === "/api/me/away-reports", (r) =>
    r.fulfill(json({
      reports: [
        { id: "R1", matchId: "M1", attackerName: "무른 감독", goalsFor: 0, goalsAgainst: 0, result: "WIN", ratingDelta: 10, createdAt: "2026-07-28T04:00:00Z", seen: false },
        { id: "R2", matchId: "M2", attackerName: "FC 한밤중", goalsFor: 1, goalsAgainst: 3, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-28T03:12:00Z", seen: false },
      ],
      summary: { matches: 2, opponents: 2, wins: 1, draws: 0, losses: 1, goalsFor: 1, goalsAgainst: 3, ratingDelta: 0 },
      rating: 20, unseen: 2,
    })));
  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });

  await page.goto("/lobby");
  await page.getByTestId("play-cta").click();   // E1: 팝업은 [게임 시작]에서 뜬다
  await page.getByTestId("away-report-modal").waitFor();
  await page.screenshot({ path: ".p245-capture/4-forfeit-report.png" });

  await page.getByTestId("away-report-confirm").click();
  await page.goto("/logs");
  await page.getByText("랭킹").click();
  await page.getByTestId("leaderboard").waitFor();
  await page.screenshot({ path: ".p245-capture/5-leaderboard-rating.png" });

  // v2: [게임 시작] → 팝업 확인 → 모드 → 원정 2택 화면
  await page.route((url) => url.pathname === "/api/away/candidates", (r) =>
    r.fulfill(json({
      candidates: [
        { userId: "u-a", nickname: "언더독 유나이티드", rating: 15 },
        { userId: "u-b", nickname: "레드 스톰 CF", rating: -5 },
      ],
      streak: 2, seasonNo: 1, seasonEndsAt: "2026-08-04T00:00:00Z", remainingToday: 7,
    })));
  await page.goto("/lobby");
  await page.getByTestId("play-cta").click();
  // 목이 계속 미확인을 반환하므로 팝업이 먼저 뜬다 — 확인하면 모드 선택으로 이어진다.
  await page.getByTestId("away-report-confirm").click();
  await page.getByTestId("mode-away").click();
  await page.getByTestId("away-candidate").first().waitFor();
  await page.screenshot({ path: ".p245-capture/6-away-picker.png" });
});
