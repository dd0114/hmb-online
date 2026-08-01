import { test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #382 실화면 캡처 — hero 컨펌·시각 확인용(판정용 아님, 루트 §2-2).
 *
 * before/after 를 **같은 파일**로 찍는다 — 구현 전후로 소스만 바꿔 돌리면 뷰포트·목·대기시간이
 * 동일해 비교가 성립한다(캡처 조건이 달라지면 "달라 보이는 것"이 무엇 때문인지 알 수 없다).
 *
 * 실행:
 *   OUT=after  cd apps/web && CI=1 WEB_E2E_PORT=5288 npx playwright test \
 *     --config=playwright.capture.config.ts p382-waiting
 */
const LABEL = process.env.HMB_CAPTURE_LABEL ?? "after";
const OUT = new URL(`../.smoke/p382/${LABEL}/`, import.meta.url).pathname;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

async function openGenWait(page: Page, state: "GEN1" | "GEN2") {
  const match = {
    id: "m382",
    createdAt: "2026-08-01T00:00:00Z",
    state,
    scoreHome: 0,
    scoreAway: 0,
    opponent: { name: "연습 봇", analysisText: "", deck: [] },
  };
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
        wallet: { points: 1000 },
        records: { played: 0, wins: 0, draws: 0, losses: 0 },
      }),
    ));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match, locked: true, abandonable: false })));
  await page.route((url) => url.pathname === "/api/players", (r) => r.fulfill(json([])));
  await page.route((url) => url.pathname === "/api/matches/m382", (r) => r.fulfill(json(match)));
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/match/m382");
  await page.getByTestId("genwait-panel").waitFor();
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));
test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
});

/** 전반 대기 — 로테이션이 도는 것을 보이려고 회전 주기마다 한 장씩 찍는다. */
test("p382: 전반 대기(GEN1) 로테이션 4컷", async ({ page }) => {
  await openGenWait(page, "GEN1");
  for (let i = 0; i < 4; i++) {
    await page.waitForTimeout(i === 0 ? 800 : 4_000);
    await page.screenshot({ path: `${OUT}0${i + 1}-gen1-t${i * 4}s.png` });
  }
});

test("p382: 후반 대기(GEN2)", async ({ page }) => {
  await openGenWait(page, "GEN2");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}05-gen2.png` });
});

/** 홈 잠금 카드(#382 MIN-3) — 같은 대기 상태를 설명하는 다른 자리. */
test("p382: 홈 잠금 카드(GEN1, 포기 가능)", async ({ page }) => {
  const match = { id: "m382", createdAt: "2026-08-01T00:00:00Z", state: "GEN1" };
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (r) =>
    r.fulfill(
      json({
        user: { id: "u1", nickname: "테스터", provider: "guest", tutorialDone: true },
        wallet: { points: 1000 },
        records: { played: 0, wins: 0, draws: 0, losses: 0 },
      }),
    ));
  await page.route((url) => url.pathname === "/api/me/active-match", (r) =>
    r.fulfill(json({ match, locked: true, abandonable: true })));
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  await page.goto("/home");
  await page.getByTestId("home-lock-note").waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}07-home-lock-card.png` });
});

test("p382: 데스크톱 폭(1280×800) 전반 대기", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openGenWait(page, "GEN1");
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${OUT}06-gen1-desktop.png` });
});
