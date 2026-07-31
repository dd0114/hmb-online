import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync, readFileSync } from "node:fs";

/**
 * #354 / #355 재현·before-after 캡처 — 데스크톱 레이아웃 결함 2건(#348 독립검증이 분리해 낸 것).
 *
 * 계약이 아니라 **관측**이다(계약은 `p348-desktop-viewport.spec.ts`·`p354-355-*.spec.ts`).
 * 뷰포트를 쓸며 실화면을 찍고 무엇이 어디로 밀렸는지 **실측 좌표**로 남긴다.
 * 결과 = `.stage/p354-355/<label>/` 에 png + geometry.json.
 *
 * 실행:
 *   cd apps/web && CAP_LABEL=before WEB_E2E_PORT=5354 \
 *     npx playwright test --config=playwright.capture.config.ts e2e/p354-355-desktop-layout.capture.ts
 */

const LABEL = process.env.CAP_LABEL ?? "before";
const CAP_DIR = new URL(`../.stage/p354-355/${LABEL}/`, import.meta.url).pathname;
const MATCH_ID = "m-354";
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

/** ⚠️ 라우트는 pathname 술어로 — glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면이 된다. */
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
          scoreHome: state === "FINISHED" ? 2 : null,
          scoreAway: state === "FINISHED" ? 3 : null,
          result: state === "FINISHED" ? "LOSS" : null,
          createdAt: "2026-07-29T09:00:00Z",
          opponent: { name: "봇 FC" },
          userDeckSnapshot: SNAPSHOT,
          clock: null,
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: {
          matchId: MATCH_ID,
          result: "LOSS",
          scoreHome: 2,
          scoreAway: 3,
          pointsAwarded: 40,
          dailyReward: { slotNo: 3, currency: "DIA", amount: 5, awarded: true },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) return route.fulfill({ json: MATCH_LOG });
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    if (url.pathname.startsWith("/api/growth/report/")) return route.fulfill({ status: 404, json: {} });
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

/** `toBeVisible()` 로 묻지 않는다 — 뷰포트 밖도 통과한다. 박스 + **중심점 히트테스트**로 잰다. */
async function probe(page: Page, testId: string) {
  return page.evaluate((id) => {
    const el = document.querySelector(`[data-testid="${id}"]`) as HTMLElement | null;
    if (!el) return { present: false as const };
    const r = el.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    return {
      present: true as const,
      x: Math.round(r.x),
      y: Math.round(r.y),
      w: Math.round(r.width),
      h: Math.round(r.height),
      bottom: Math.round(r.bottom),
      inViewport:
        r.top >= -1 && r.left >= -1 && r.bottom <= window.innerHeight + 1 && r.right <= window.innerWidth + 1,
      hitSelf: !!hit && (hit === el || el.contains(hit) || hit.contains(el)),
      vh: window.innerHeight,
      vw: window.innerWidth,
    };
  }, testId);
}

/** #354 — 감독시간이 깨지는 조건은 "넓고 낮은 창"(데스크탑 분기 **아래**)이다. */
const WIDE_LOW = [
  { name: "1023x768", width: 1023, height: 768 }, // 분기 바로 아래(이슈 실측 y955)
  { name: "1023x900", width: 1023, height: 900 },
  { name: "1010x760", width: 1010, height: 760 },
  { name: "960x1040", width: 960, height: 1040 },
  { name: "900x800", width: 900, height: 800 },
  { name: "853x533", width: 853, height: 533 }, // 1280×800 @150%
  { name: "820x640", width: 820, height: 640 },
  { name: "768x900", width: 768, height: 900 },
];

/** #355 — 결과 화면은 **모든** 데스크탑 비율에서 깨진다(3440×1440 포함). */
const DESKTOP = [
  { name: "1024x768", width: 1024, height: 768 },
  { name: "1280x650", width: 1280, height: 650 },
  { name: "1280x800", width: 1280, height: 800 },
  { name: "1440x900", width: 1440, height: 900 },
  { name: "1920x1080", width: 1920, height: 1080 },
  { name: "3440x1440", width: 3440, height: 1440 },
];

const PHONE = { name: "390x844", width: 390, height: 844 };

const report: Record<string, unknown>[] = [];

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));
test.afterAll(() => {
  writeFileSync(`${CAP_DIR}geometry.json`, JSON.stringify(report, null, 2));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(report, null, 2));
});

for (const vp of [...WIDE_LOW, { name: "1280x800", width: 1280, height: 800 }, PHONE]) {
  test(`#354 halftime @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openMatch(page, "HALFTIME");
    await expect(page.getByTestId("halftime-panel")).toHaveCount(1);
    await page.waitForTimeout(400);
    report.push({
      issue: 354,
      viewport: vp.name,
      sheet: await probe(page, "stage-sheet"),
      panel: await probe(page, "halftime-panel"),
      board: await probe(page, "tactics-board"),
      prompt: await probe(page, "editor-team-prompt"),
      resume: await probe(page, "resume-button"),
    });
    await page.screenshot({ path: `${CAP_DIR}h354-halftime-${vp.name}.png` });
  });
}

for (const vp of [...DESKTOP, PHONE]) {
  test(`#355 result @ ${vp.name}`, async ({ page }) => {
    await page.setViewportSize({ width: vp.width, height: vp.height });
    await openMatch(page, "FINISHED");
    await expect(page.getByTestId("result-page")).toHaveCount(1);
    await page.waitForTimeout(400);
    report.push({
      issue: 355,
      viewport: vp.name,
      sheet: await probe(page, "stage-sheet"),
      resultPage: await probe(page, "result-page"),
      finalScore: await probe(page, "final-score"),
      teamStats: await probe(page, "team-stats"),
      toLobby: await probe(page, "to-lobby"),
      canvas: await probe(page, "stage-canvas"),
    });
    await page.screenshot({ path: `${CAP_DIR}h355-result-${vp.name}.png` });
  });
}
