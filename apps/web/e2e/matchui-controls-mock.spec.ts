import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #148 매치 화면 컨트롤 간소화 (#169 S3 직접 마운트) — 백엔드 없이 route-mock 으로 실화면 계약을 박제한다.
 *
 * 계약(hero 재지시 2026-07-21 → #216 하이라이트 단일화 2026-07-27):
 *  - 플레이 모드(일반 유저): 경기는 **자동 진행**하고 컨트롤은 **아예 없다**. 하이라이트 연출이
 *    유일 모드라 끄는 버튼도 없다(#216 — 끔 모드는 렌더가 깨진 채였고 라이브 재생이 그 경로를 탔다).
 *  - admin/QA 모드: 코어 풀컨트롤(재생·배속·스크럽·프레임점프) + 모드 전환 토글. 배속은 연출을
 *    끄지 않고 그 위에 곱해진다.
 *
 * S3: iframe·postMessage 제거 — web 이 viewer-core 를 직접 마운트한다. 컨트롤은 코어 컨트롤러를
 * 직접 조작하고, 재생 상태는 window.__viewer(코어 훅)로 읽는다.
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면.
 */

const CAP_DIR = new URL("../.matchui/", import.meta.url).pathname;
const MATCH_ID = "m-matchui";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

async function mockApi(page: Page, opts: { isAdmin: boolean; corruptLog?: boolean }) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u1", nickname: "테스터", points: 100, wins: 0, draws: 0, losses: 0, isAdmin: opts.isAdmin },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state: "H1_BREAK",
          scoreH1Home: 2,
          scoreH1Away: 1,
          createdAt: "2026-07-21T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/halves/1/log`) {
      // corruptLog: 코어 load 가 거부하는 형태(tickSnapshots 결손) — 실패 경로 검증용.
      return route.fulfill({ json: opts.corruptLog ? { events: [], finalScore: { home: 0, away: 0 } } : MATCH_LOG });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: [] });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-4-2", slots: [] } });
    return route.fulfill({ json: {} });
  });
}

/** 매치 화면을 열고 코어가 마운트(ready)될 때까지 기다린다. */
async function openHalftime(page: Page, isAdmin: boolean): Promise<void> {
  await mockApi(page, { isAdmin });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("match-viewer-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible();
  await page.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
}

/** 코어 현재 재생 틱(진행 여부 판정용). */
function tickNow(page: Page): Promise<number> {
  return page.evaluate(
    () => (window as never as { __viewer: { cur: () => { tick: number } } }).__viewer.cur().tick,
  );
}

/** 실제 진행 속도(게임틱/실초) 측정 — "칩이 눌렸다"가 아니라 "정말 진행한다"를 본다. */
async function measureRate(page: Page, ms: number): Promise<number> {
  const t0 = await tickNow(page);
  await page.waitForTimeout(ms);
  const t1 = await tickNow(page);
  return (t1 - t0) / (ms / 1000);
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test("#148/#216 플레이 모드: 컨트롤이 없고 경기는 자동 진행한다", async ({ page }) => {
  await openHalftime(page, false);

  // (1) web 바에 컨트롤이 하나도 없다(하이라이트 토글·재생·배속·스크럽·프레임점프·모드토글 전부).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  for (const s of [1, 2, 4]) await expect(page.getByTestId(`viewer-speed-${s}-half1`)).toHaveCount(0);
  await expect(page.getByTestId("viewer-scrub-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toHaveCount(0);
  const buttons = await page.getByTestId("viewer-controls-half1").locator("button").count();
  expect(buttons, "플레이 모드 컨트롤 바에는 버튼이 없다").toBe(0);

  // 스코어는 무대(캔버스)가 아니라 호스트 스코어바가 소유한다(중복 없이 한 곳).
  await expect(page.getByTestId("stage-scorebar")).toBeVisible();
  await expect(page.getByTestId("stage-score")).toBeVisible();
  await page.screenshot({ path: `${CAP_DIR}play-mode.png`, fullPage: false });

  // (2) 아무 조작 없이도 경기가 진행된다(자동 진행 — 재생 버튼이 없으므로 이게 유일한 시작 경로).
  const t0 = await tickNow(page);
  await expect.poll(() => tickNow(page), { timeout: 10_000 }).toBeGreaterThan(t0);
});

test("#216 하이라이트 연출이 유일 모드다 — 끌 경로가 없고 연출 페이스로 진행한다", async ({ page }) => {
  await openHalftime(page, false);

  // 화면에 연출을 끄는 컨트롤이 존재하지 않는다(플레이·admin 어느 쪽에도).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-highlight-admin-half1")).toHaveCount(0);

  // 진행 속도는 **코어 연출 페이스**여야 한다: 크루즈 4x = 8 게임틱/실초(코어 1x = 2틱/s).
  // 구 구현은 마운트에서 setSpeed(4)를 박고 라이브에서 autoPace 를 껐다 — 그러면 배율이 곱해져
  // 훨씬 빨라진다. 하이라이트 슬로우·데드볼 홀드가 섞이므로 상한만 느슨하게 건다.
  const rate = await measureRate(page, 4000);
  console.log(`[#216] 하이라이트 연출 진행 속도: ${rate.toFixed(2)} tick/s`);
  expect(rate, "경기는 계속 진행해야 함").toBeGreaterThan(0);
  expect(rate, "크루즈(8틱/s)를 넘게 빠르면 배율이 잘못 곱해진 것").toBeLessThanOrEqual(9);
  await page.screenshot({ path: `${CAP_DIR}play-mode-highlight-on.png`, fullPage: false });
});

test("#148 admin 모드: 코어 풀컨트롤 노출 + 모드 토글로 플레이어 체감 전환", async ({ page }) => {
  await openHalftime(page, true);

  // 풀컨트롤: 재생/정지·배속·스크럽·골점프가 보인다.
  await expect(page.getByTestId("viewer-play-toggle-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-speed-0.25-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-scrub-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-prev-goal-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toBeVisible();
  // 하이라이트 토글은 어느 모드에도 없다(#216).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-highlight-admin-half1")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}admin-full-mode.png`, fullPage: false });

  // 모드 토글 → 플레이어가 보는 화면으로 즉시 전환(풀컨트롤 사라지고 빈 바만).
  await page.getByTestId("viewer-mode-play-half1").click();
  await expect(page.getByTestId("viewer-scrub-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}admin-switched-to-play.png`, fullPage: false });
});

test("#148 뷰어 로드 실패는 화면 안에 보인다(설명 없는 빈 피치 방지)", async ({ page }) => {
  // 손상 MatchLog → 코어 load 가 throw → 같은 자리에 실패 안내 + 타임라인 폴백 버튼.
  await mockApi(page, { isAdmin: false, corruptLog: true });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  const err = page.getByTestId("viewer-visual-error-half1");
  await expect(err).toBeVisible({ timeout: 20_000 });
  const box = await err.boundingBox();
  const vh = page.viewportSize()!.height;
  expect(box!.y, "실패 안내가 첫 화면 안에 있어야 함").toBeGreaterThanOrEqual(0);
  expect(box!.y + box!.height).toBeLessThanOrEqual(vh + 1);
  await page.screenshot({ path: `${CAP_DIR}play-mode-load-error.png`, fullPage: false });
});

test("#148 모바일 390px: 간소 컨트롤 가로 오버플로 0", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHalftime(page, false);
  await expect(page.getByTestId("viewer-canvas-half1")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${CAP_DIR}play-mode-mobile390.png`, fullPage: false });
});
