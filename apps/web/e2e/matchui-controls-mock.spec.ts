import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #148 매치 화면 컨트롤 간소화 (#169 S3 직접 마운트) — 백엔드 없이 route-mock 으로 실화면 계약을 박제한다.
 *
 * 계약(hero 재지시 2026-07-21):
 *  - 플레이 모드(일반 유저): 경기는 **자동 진행**하고 컨트롤은 **하이라이트 토글 하나뿐**이다.
 *    재생/일시정지·배속·되감기·프레임점프·스크럽은 없다. 토글은 코어 연출(autoPace)을 직접 끄고 켠다
 *    (끄면 진행이 멈추거나 느려지지 않고 기본 배속 4x 로 쭉 간다).
 *  - admin/QA 모드: 코어 풀컨트롤(재생·배속·스크럽·프레임점프) + 모드 전환 토글.
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

/** 하이라이트 연출(autoPace) 표시 상태 — 토글 aria-pressed 가 SoT(web 이 직접 제어). */
function highlightOn(page: Page): Promise<boolean> {
  return page
    .getByTestId("viewer-highlight-toggle-half1")
    .getAttribute("aria-pressed")
    .then((v) => v === "true");
}

/** 실제 진행 속도(게임틱/실초) 측정 — "칩이 눌렸다"가 아니라 "정말 진행한다"를 본다. */
async function measureRate(page: Page, ms: number): Promise<number> {
  const t0 = await tickNow(page);
  await page.waitForTimeout(ms);
  const t1 = await tickNow(page);
  return (t1 - t0) / (ms / 1000);
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test("#148 플레이 모드: 컨트롤은 하이라이트 토글 하나뿐이고 경기는 자동 진행한다", async ({ page }) => {
  await openHalftime(page, false);

  // (1) web 바에 하이라이트 토글 외에는 아무 컨트롤이 없다(재생/배속/스크럽/프레임점프/모드토글 없음).
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  for (const s of [1, 2, 4]) await expect(page.getByTestId(`viewer-speed-${s}-half1`)).toHaveCount(0);
  await expect(page.getByTestId("viewer-scrub-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toHaveCount(0);
  const buttons = await page.getByTestId("viewer-controls-half1").locator("button").count();
  expect(buttons, "플레이 모드 컨트롤 바의 버튼은 하이라이트 토글 하나뿐").toBe(1);

  // 스코어는 무대(캔버스)가 아니라 호스트 스코어바가 소유한다(중복 없이 한 곳).
  await expect(page.getByTestId("stage-scorebar")).toBeVisible();
  await expect(page.getByTestId("stage-score")).toBeVisible();

  // 컨트롤 바가 첫 화면 안에 보여야 한다(스크롤 없이).
  const bar = await page.getByTestId("viewer-controls-half1").boundingBox();
  const vh = page.viewportSize()!.height;
  expect(bar!.y + bar!.height, "컨트롤 바가 첫 화면 안에 보여야 함").toBeLessThanOrEqual(vh);
  await page.screenshot({ path: `${CAP_DIR}play-mode.png`, fullPage: false });

  // (2) 아무 조작 없이도 경기가 진행된다(자동 진행 — 재생 버튼이 없으므로 이게 유일한 시작 경로).
  const t0 = await tickNow(page);
  await expect.poll(() => tickNow(page), { timeout: 10_000 }).toBeGreaterThan(t0);
});

test("#148 하이라이트 토글이 실제로 연출을 끄고 켠다(끄면 일정 속도로 계속 진행)", async ({ page }) => {
  await openHalftime(page, false);
  const toggle = page.getByTestId("viewer-highlight-toggle-half1");

  // 기본은 하이라이트 on — 코어 autoPace(주요장면 슬로우·접촉 줌)가 켜져 있다.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await highlightOn(page)).toBe(true);

  // 끄면: autoPace off + 진행은 계속(멈추거나 느려지지 않아야 한다 — 기본 배속 4x).
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  const rateOff = await measureRate(page, 4000);
  console.log(`[#148] 하이라이트 off 진행 속도: ${rateOff.toFixed(2)} tick/s`);
  expect(rateOff, "연출을 꺼도 경기는 계속 진행해야 함").toBeGreaterThan(0);
  expect(rateOff, "기본 1x(=2 tick/s)에 갇히면 안 됨 — 배속 4x").toBeGreaterThan(3);

  // 다시 켜면 복귀 + 진행 유지.
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const rateOn = await measureRate(page, 3000);
  expect(rateOn, "하이라이트 on 에서도 진행은 계속").toBeGreaterThan(0);
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
  // 풀컨트롤에선 간소 하이라이트 토글을 중복 노출하지 않는다.
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await page.screenshot({ path: `${CAP_DIR}admin-full-mode.png`, fullPage: false });

  // 모드 토글 → 플레이어가 보는 화면으로 즉시 전환(풀컨트롤 사라지고 하이라이트 토글만).
  await page.getByTestId("viewer-mode-play-half1").click();
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-scrub-half1")).toHaveCount(0);
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
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${CAP_DIR}play-mode-mobile390.png`, fullPage: false });
});
