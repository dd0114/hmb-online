import { expect, test, type Page, type Request } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #421 W2 캡처 — 스킵 버튼 · 하프 리포트 팝업 **실화면**(hero 컨펌 자료).
 *
 * ⚠️ 캡처는 계약이 아니다(루트 §2-2 — 판정은 독립 QA). 그래서 `*.capture.ts` 로 두어
 * 판정 게이트(`*.spec.ts`)에 섞이지 않는다. 계약은 `p421-skip-report.spec.ts` 가 갖는다.
 *
 * 실행: cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts p421-skip.capture.ts
 */

const OUT = new URL("../.p421/", import.meta.url).pathname;
const MATCH_ID = "m-p421cap";
const LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
) as { events: { type: string; playerId?: string }[]; tickSnapshots?: { players?: { playerId: string }[] }[] };

// 스냅샷 등장 순서를 먼저 깐다 — 주요 인물은 **출전 22명 전원** 중에서 뽑히므로 이벤트 id 만으로는
// 이름이 안 붙는 선수가 생긴다(계약 스펙과 같은 이유).
const SNAP_IDS = (LOG.tickSnapshots ?? []).flatMap((s) => s.players ?? []).map((p) => p.playerId);
const PLAYERS = [...new Set([...SNAP_IDS, ...LOG.events.map((e) => e.playerId).filter(Boolean)])].map((id, i) => ({
  id,
  name: `선수${i + 1}`,
  position: "MF",
  grade: "B",
}));

async function mock(page: Page, box: { state: string }) {
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
      box.state = "HALFTIME";
      return route.fulfill({ json: detail(box.state) });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) return route.fulfill({ json: detail(box.state) });
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
    return route.fulfill({ json: {} });
  });
}

const detail = (state: string) => ({
  id: MATCH_ID,
  state,
  scoreH1Home: state === "FIRST_HALF" ? null : 6,
  scoreH1Away: state === "FIRST_HALF" ? null : 4,
  scoreHome: null,
  scoreAway: null,
  result: null,
  auto: false,
  createdAt: "2026-08-02T09:00:00Z",
  opponent: { name: "봇 FC" },
});

test.use({ viewport: { width: 390, height: 844 } });

test("스킵 버튼 → 하프 리포트 팝업", async ({ page }) => {
  mkdirSync(OUT, { recursive: true });
  const box = { state: "FIRST_HALF" };
  await mock(page, box);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await page.locator('[data-testid="viewer-canvas-half1"]').waitFor({ state: "visible", timeout: 30_000 });
  await expect(page.getByTestId("match-skip")).toBeVisible();
  await page.screenshot({ path: `${OUT}1-skip-button.png` });

  await page.getByTestId("match-skip").click();
  await expect(page.getByTestId("half-report")).toBeVisible();
  await page.screenshot({ path: `${OUT}2-half-report.png` });

  // 스택을 끝까지 넘기며 **장마다** 찍는다 — 카드가 몇 장이 되든(#403 평점 카드 + #424 브릿지)
  // 유저가 실제로 보는 그림이 전부 남는다.
  for (let i = 0; i < 6 && (await page.getByTestId("half-report").count()) > 0; i++) {
    const card = await page.getByTestId("half-report-card").getAttribute("data-card");
    await page.getByTestId("half-report-next").click();
    if ((await page.getByTestId("half-report").count()) > 0) {
      await expect(page.getByTestId("half-report-card")).not.toHaveAttribute("data-card", card ?? "");
      await page.screenshot({ path: `${OUT}2-${i + 1}-card-${await page.getByTestId("half-report-card").getAttribute("data-card")}.png` });
    }
  }

  await expect(page.getByTestId("resume-button")).toBeVisible();
  await page.screenshot({ path: `${OUT}3-after-close-halftime.png` });
});
