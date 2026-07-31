import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

/**
 * #348 재현 캡처 — 데스크톱에서 후반 지시 입력 화면이 안 보인다(hero 실사용).
 *
 * 계약이 아니라 **관측**이다. 뷰포트를 쓸며 실화면을 찍고, 무엇이 어디로 사라지는지
 * 좌표(추론 아님, 실측)로 남긴다. 결과는 `.stage/p348/` 에 png + geometry.json.
 *
 * 실행: WEB_E2E_PORT=5348 npx playwright test e2e/p348-desktop-brief.capture.ts --testMatch "**\/*.capture.ts"
 */

const CAP_DIR = new URL("../.stage/p348/", import.meta.url).pathname;
const MATCH_ID = "m-348";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

const STARTERS = Array.from({ length: 11 }, (_, i) => ({ slotIndex: i, playerId: `p${i + 1}` }));
const BENCH = Array.from({ length: 5 }, (_, i) => ({ slotIndex: i, playerId: `b${i + 1}` }));
const SNAPSHOT = {
  formation: "4-3-3",
  starters: STARTERS,
  bench: BENCH,
  teamTactics: { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 },
};
const DECK = {
  formation: "4-3-3",
  slots: [
    ...STARTERS.map((s) => ({ ...s, role: "starter" as const })),
    ...BENCH.map((s) => ({ ...s, role: "bench" as const })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "SILVER",
    owned: true,
    ownedCount: 1,
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "BRONZE",
    owned: true,
    ownedCount: 1,
  })),
];

async function mockApi(page: Page, state: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: { user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: false } },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          scoreH1Home: 1,
          scoreH1Away: 1,
          createdAt: "2026-07-29T09:00:00Z",
          opponent: { name: "봇 FC" },
          userDeckSnapshot: SNAPSHOT,
          clock: null,
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: MATCH_LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state: string) {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
}

/**
 * "보이나"를 `toBeVisible()` 로 묻지 않는다 — 뷰포트 밖도 통과한다(apps/web CLAUDE.md 함정 3).
 * 박스 + **중심점 히트테스트**로 잰다.
 */
async function probe(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return { present: false as const };
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const hit = document.elementFromPoint(cx, cy);
    return {
      present: true as const,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      right: Math.round(r.right),
      inViewport:
        r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      hitSelf: !!hit && (hit === el || el.contains(hit)),
      scrollH: el.scrollHeight,
      clientH: el.clientHeight,
    };
  }, testId);
}

const VIEWPORTS = [
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1280x720", width: 1280, height: 720 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1512x945", width: 1512, height: 945 }, // MacBook Pro 14" 기본 배율
  { name: "1680x1050", width: 1680, height: 1050 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "2560x1440", width: 2560, height: 1440 },
  { name: "1024x768", width: 1024, height: 768 }, // 데스크탑 분기 하한
  { name: "1023x768", width: 1023, height: 768 }, // 분기 바로 아래(= "비율 줄이면 보임")
  { name: "390x844", width: 390, height: 844 }, // 폰 대조군
];

const report: Record<string, unknown>[] = [];

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test.afterAll(() => {
  writeFileSync(`${CAP_DIR}geometry.json`, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
});

for (const vp of VIEWPORTS) {
  test(`brief @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openMatch(page, "FIRST_HALF");
    await page.getByTestId("stage-tab-brief").click();
    await expect(page.getByTestId("stage-panel-brief")).toHaveCount(1);
    await page.waitForTimeout(400);

    report.push({
      viewport: vp.name,
      state: "FIRST_HALF/brief",
      sheet: await probe(page, "stage-sheet"),
      panelBrief: await probe(page, "stage-panel-brief"),
      targets: await probe(page, "brief-targets"),
      prompt: await probe(page, "brief-team-prompt"),
      status: await probe(page, "brief-save-status"),
      tabBrief: await probe(page, "stage-tab-brief"),
      canvas: await probe(page, "stage-canvas"),
    });
    await page.screenshot({ path: `${CAP_DIR}brief-${vp.name}.png` });
  });
}

for (const vp of [VIEWPORTS[0]!, VIEWPORTS[5]!, VIEWPORTS[9]!]) {
  test(`halftime @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openMatch(page, "HALFTIME");
    await expect(page.getByTestId("halftime-panel")).toHaveCount(1);
    await page.waitForTimeout(400);

    report.push({
      viewport: vp.name,
      state: "HALFTIME",
      sheet: await probe(page, "stage-sheet"),
      panel: await probe(page, "halftime-panel"),
      prompt: await probe(page, "editor-team-prompt"),
      resume: await probe(page, "resume-button"),
    });
    await page.screenshot({ path: `${CAP_DIR}halftime-${vp.name}.png` });
  });
}
