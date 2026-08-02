import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #424 W1 캡처 — **브릿지 4지점 실화면**(hero 컨펌 자료).
 *
 * ⚠️ 캡처는 계약이 아니다(루트 §2-2 — 판정은 독립 QA). 그래서 `*.capture.ts` 로 두어 판정
 * 게이트(`*.spec.ts`)에 섞이지 않는다. 계약은 `p424-flow-bridge.spec.ts` 가 갖는다.
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts p424-bridges.capture.ts
 */

const OUT = new URL("../.p424/", import.meta.url).pathname;
const MATCH_ID = "m-p424cap";
const LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as { events: { type: string; team?: string; playerId?: string }[] };

const GOALS = LOG.events.filter((e) => e.type === "goal");
const HALF = {
  home: GOALS.filter((g) => g.team === "home").length,
  away: GOALS.filter((g) => g.team === "away").length,
};
const PLAYERS = [...new Set(LOG.events.map((e) => e.playerId).filter(Boolean))].map((id, i) => ({
  id,
  name: `선수${i + 1}`,
  position: "MF",
  grade: "B",
}));

interface Box {
  state: string;
  auto: boolean;
  skipTo: string;
}

const clockOf = (b: Box) => {
  if (b.state !== "HALFTIME") return null;
  const now = Date.now();
  return {
    phase: "HALFTIME",
    kickoffAt: new Date(now - 400_000).toISOString(),
    phaseStartAt: new Date(now - 13_000).toISOString(),
    phaseEndsAt: new Date(now + 167_000).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: 220_000,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
};

const detail = (b: Box) => {
  const afterH1 = b.state !== "FIRST_HALF" && b.state !== "BRIEFING" && b.state !== "GEN1";
  return {
    id: MATCH_ID,
    state: b.state,
    auto: b.auto,
    scoreH1Home: afterH1 ? HALF.home : null,
    scoreH1Away: afterH1 ? HALF.away : null,
    scoreHome: b.state === "FINISHED" ? HALF.home * 2 : null,
    scoreAway: b.state === "FINISHED" ? HALF.away * 2 : null,
    result: b.state === "FINISHED" ? "WIN" : null,
    clock: clockOf(b),
    createdAt: "2026-08-03T09:00:00Z",
    opponent: { name: "봇 FC" },
  };
};

async function mock(page: Page, b: Box) {
  await page.route("**/*", async (route) => {
    const req: Request = route.request();
    const url = new URL(req.url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/skip`) {
      b.state = b.skipTo;
      return route.fulfill({ json: detail(b) });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detail(b) });
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") {
      return route.fulfill({
        json: {
          formation: "4-3-3",
          slots: PLAYERS.slice(0, 11).map((p, i) => ({ slotIndex: i, playerId: p.id, role: "starter" })),
        },
      });
    }
    if (url.pathname === "/api/me/active-match") {
      return route.fulfill({ json: { match: detail(b), locked: true, abandonable: true } });
    }
    return route.fulfill({ json: {} });
  });
}

async function open(page: Page, over: Partial<Box> = {}): Promise<Box> {
  const b: Box = { state: "FIRST_HALF", auto: false, skipTo: "HALFTIME", ...over };
  await mock(page, b);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  return b;
}

test.use({ viewport: { width: 390, height: 844 } });

test("B1 경기 시작 — GenWaitPanel 승격(스텝퍼 + 다음 안내)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await open(page, { state: "GEN1" });
  await expect(page.getByTestId("flow-stepper")).toBeVisible();
  await page.screenshot({ path: `${OUT}b1-match-start.png` });
});

test("B2 전반 종료 — 오버레이 카드(남은 감독시간 표시)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const b = await open(page, { state: "FIRST_HALF" });
  await page.locator('[data-testid="viewer-canvas-half1"]').waitFor({ state: "visible", timeout: 30_000 });
  b.state = "HALFTIME";
  await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${OUT}b2-h1-end.png` });
});

test("B2' 전반 종료(스킵) — 리포트 → 브릿지 한 스택", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await open(page, { state: "FIRST_HALF", skipTo: "HALFTIME" });
  await page.locator('[data-testid="viewer-canvas-half1"]').waitFor({ state: "visible", timeout: 30_000 });
  await page.getByTestId("match-skip").click();
  await expect(page.getByTestId("half-report")).toBeVisible();
  await page.screenshot({ path: `${OUT}b2b-skip-report-card1.png` });
  await page.getByTestId("half-report-next").click();
  await expect(page.getByTestId("half-report-card")).toHaveAttribute("data-card", "bridge");
  await page.screenshot({ path: `${OUT}b2c-skip-bridge-card2.png` });
});

test("B3 후반 시작 — GenWaitPanel 승격(감독시간 done)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  await open(page, { state: "GEN2" });
  await expect(page.getByTestId("flow-stepper")).toBeVisible();
  await page.screenshot({ path: `${OUT}b3-h2-start.png` });
});

test("B4 경기 종료 — 오버레이 카드(승패 + 다음 안내)", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const b = await open(page, { state: "SECOND_HALF" });
  await page.locator('[data-testid="viewer-canvas-half2"]').waitFor({ state: "visible", timeout: 30_000 });
  b.state = "FINISHED";
  await expect(page.getByTestId("flow-bridge")).toBeVisible({ timeout: 15_000 });
  await page.screenshot({ path: `${OUT}b4-match-end.png` });
});
