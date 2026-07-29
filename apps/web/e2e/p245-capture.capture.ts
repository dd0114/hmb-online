import { test } from "@playwright/test";

/**
 * #245 hero UI 컨펌용 실화면 캡처 — **목업이 아니라 실제 코드가 그리는 화면**.
 * 판정용이 아니라 hero 가 눈으로 보고 결정하기 위한 캡처다(루트 §2-2: 판정은 독립 QA).
 */
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });

const RAIDS = [
  { id: "R1", matchId: "M1", attackerName: "FC 한밤중", goalsFor: 1, goalsAgainst: 3, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-28T03:12:00Z", seen: false },
  { id: "R2", matchId: "M2", attackerName: "언더독 유나이티드", goalsFor: 2, goalsAgainst: 0, result: "WIN", ratingDelta: 10, createdAt: "2026-07-28T01:40:00Z", seen: false },
  { id: "R3", matchId: "M3", attackerName: "레드 스톰 CF", goalsFor: 1, goalsAgainst: 4, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-27T23:05:00Z", seen: false },
];

test("capture: 레이팅 배지 없는 헤더(대조군 — main 상태)", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(json({ user: { id: "u1", nickname: "감독 박", isAdmin: false, tutorialDone: true }, wallet: { points: 24300, gems: 12 }, records: { wins: 12, draws: 3, losses: 8 } })));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) => r.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/relations", (r) => r.fulfill(json({ morale: 62, streak: 1, players: [] })));
  await page.route((url) => url.pathname === "/api/deck", (r) => r.fulfill(json({ code: "NOT_FOUND", message: "x" }, 404)));
  await page.route((url) => url.pathname === "/api/me/away-reports", (r) => r.fulfill(json({ reports: [], summary: { matches: 0, opponents: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, ratingDelta: 0 }, rating: 0, unseen: 0 })));
  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
  await page.goto("/lobby");
  await page.getByTestId("play-cta").waitFor();
  await page.screenshot({ path: ".p245-capture/0-header-control.png" });
});

test("capture: 로비 팝업 + 원정 모드", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(json({ user: { id: "u1", nickname: "감독 박", isAdmin: false, tutorialDone: true }, wallet: { points: 24300, gems: 12 }, records: { wins: 12, draws: 3, losses: 8 }, rating: -10 })));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) => r.fulfill(json({ match: null, locked: false, abandonable: false })));
  await page.route((url) => url.pathname === "/api/relations", (r) => r.fulfill(json({ morale: 62, streak: 1, players: [] })));
  await page.route((url) => url.pathname === "/api/deck", (r) => r.fulfill(json({ code: "NOT_FOUND", message: "x" }, 404)));
  await page.route((url) => url.pathname === "/api/me/away-reports", (r) =>
    r.fulfill(json({ reports: RAIDS, summary: { matches: 3, opponents: 3, wins: 1, draws: 0, losses: 2, goalsFor: 4, goalsAgainst: 7, ratingDelta: -10 }, rating: -10, unseen: 3 })));
  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });

  await page.goto("/lobby");
  await page.getByTestId("play-cta").click();   // E1: 팝업은 [게임 시작]에서 뜬다
  await page.getByTestId("away-report-modal").waitFor();
  await page.screenshot({ path: ".p245-capture/1-away-popup.png" });

  await page.getByTestId("away-report-confirm").click();
  await page.getByTestId("mode-away").waitFor();   // 닫으면 모드 선택으로 이어진다
  await page.screenshot({ path: ".p245-capture/2-lobby-rating.png" });

  await page.screenshot({ path: ".p245-capture/3-mode-away.png" });
});
