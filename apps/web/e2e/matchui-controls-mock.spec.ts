import { expect, test, type Frame, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #148 매치 화면 컨트롤 간소화 — 백엔드 없이 route-mock 으로 실화면 계약을 박제한다.
 *
 * 계약:
 *  - 플레이 모드(일반 유저): iframe 안 뷰어의 디버그 컨트롤(되감기·프레임점프·스크럽·배율·토글)이
 *    **화면에 보이지 않고**, web 이 그린 간소 바(재생/일시정지 + 1·2·4x)만 보인다.
 *    간소 바 조작은 실제로 뷰어를 몬다(배속 반영·재생 시작).
 *  - admin/QA 모드: 뷰어 원래 컨트롤이 전부 보인다(디버그·검수).
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지
 * 잡아 흰 화면이 된다(프로젝트 기지식 — web-visual-qa-mock-harness).
 */

const CAP_DIR = new URL("../.matchui/", import.meta.url).pathname;
const MATCH_ID = "m-matchui";
// 결정론 데모 로그(build:viewer 가 생성) — 실제 MatchLog 를 그대로 주입해 진짜 렌더를 본다.
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
      // corruptLog: 뷰어 loadLog 가 거부하는 형태(tickSnapshots 등 결손) — 실패 경로 검증용.
      return route.fulfill({ json: opts.corruptLog ? { events: [], finalScore: { home: 0, away: 0 } } : MATCH_LOG });
    }
    // 하프타임 패널이 부르는 나머지는 이 스펙 관심 밖 — 다만 형태는 맞춰야 패널이 크래시하지 않는다.
    if (url.pathname === "/api/players") return route.fulfill({ json: [] });
    if (url.pathname === "/api/deck") return route.fulfill({ json: { formation: "4-4-2", slots: [] } });
    return route.fulfill({ json: {} });
  });
}

async function openHalftime(page: Page, isAdmin: boolean): Promise<Frame> {
  await mockApi(page, { isAdmin });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("match-viewer-half1")).toBeVisible();
  const iframeEl = page.locator('[data-testid="viewer-visual-half1"] iframe');
  await expect(iframeEl).toBeVisible();
  const frame = (await (await iframeEl.elementHandle())!.contentFrame()) as Frame;
  await frame.waitForFunction(
    () => (window as unknown as { __viewer?: { ready?: () => boolean } }).__viewer?.ready?.() === true,
    undefined,
    { timeout: 20_000 },
  );
  return frame;
}

/** 뷰어 내부 디버그 컨트롤이 실제로 화면에 보이는지(레이아웃 기준). */
async function viewerChromeVisible(frame: Frame) {
  return frame.evaluate(() => {
    const vis = (el: Element | null) => !!el && (el as HTMLElement).offsetParent !== null;
    return {
      controlRows: [...document.querySelectorAll(".controls")].filter((el) => vis(el)).length,
      scrub: vis(document.getElementById("scrub")),
      speed025: vis(document.querySelector('[data-speed="0.25"]')),
      prevGoal: vis(document.getElementById("prevGoal")),
      title: vis(document.querySelector("h1")),
      pitch: vis(document.getElementById("wrap")),
      scoreboard: vis(document.getElementById("scoreboard")),
    };
  });
}

/** 뷰어의 현재 재생 틱(진행 여부 판정용). */
function tickNow(frame: Frame): Promise<number> {
  return frame.evaluate(
    () => (window as never as { __viewer: { cur: () => { tick: number } } }).__viewer.cur().tick,
  );
}

/** 하이라이트 자동페이싱(뷰어 Highlights) 상태 — 켜져 있으면 뷰어가 배속을 무시한다. */
function autoPaceOn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => !!document.getElementById("highlightBtn")?.classList.contains("active"));
}

/** 실제 진행 속도(게임틱/실초) 측정 — "칩이 눌렸다"가 아니라 "정말 빨라졌다"를 본다. */
async function measureRate(page: Page, frame: Frame, ms: number): Promise<number> {
  const t0 = await tickNow(frame);
  await page.waitForTimeout(ms);
  const t1 = await tickNow(frame);
  return (t1 - t0) / (ms / 1000);
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test("#148 플레이 모드: 뷰어 디버그 컨트롤 숨김 + 간소 바만 노출, 조작은 실제로 뷰어를 몬다", async ({ page }) => {
  const frame = await openHalftime(page, false);

  // (1) iframe 안 디버그 컨트롤 전부 비노출 — 경기 장면은 그대로.
  const chrome = await viewerChromeVisible(frame);
  expect(chrome, "플레이 모드에선 컨트롤 행/스크럽/슬로우배속/프레임점프/디버그 제목이 안 보여야 함").toMatchObject({
    controlRows: 0,
    scrub: false,
    speed025: false,
    prevGoal: false,
    title: false,
    pitch: true,
    scoreboard: true,
  });

  // (2) web 간소 바: 재생/일시정지 + 1·2·4x 뿐(되감기·스크럽 없음).
  await expect(page.getByTestId("viewer-play-toggle-half1")).toBeVisible();
  for (const s of [1, 2, 4]) await expect(page.getByTestId(`viewer-speed-${s}-half1`)).toBeVisible();
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toHaveCount(0);
  // 컨트롤을 찾으러 스크롤하지 않아도 되게 — 데스크탑 기본 뷰포트에서 바가 화면 안에 있어야 한다.
  const bar = await page.getByTestId("viewer-controls-half1").boundingBox();
  const vh = page.viewportSize()!.height;
  expect(bar!.y + bar!.height, "간소 컨트롤 바가 첫 화면 안에 보여야 함").toBeLessThanOrEqual(vh);
  await page.screenshot({ path: `${CAP_DIR}play-mode.png`, fullPage: false });

  // (3) 배속 칩 → 뷰어의 실제 배속이 바뀐다.
  await page.getByTestId("viewer-speed-2-half1").click();
  await expect
    .poll(() => frame.evaluate(() => document.querySelector("[data-speed].active")?.getAttribute("data-speed")))
    .toBe("2");
  await expect(page.getByTestId("viewer-speed-2-half1")).toHaveAttribute("aria-pressed", "true");
  // 배속은 뷰어의 하이라이트 자동페이싱이 켜져 있으면 무시된다(index.html eff 분기) →
  // 배속 선택 시 자동페이싱이 실제로 꺼져 있어야 한다.
  expect(await autoPaceOn(frame), "배속 선택 시 자동페이싱 off").toBe(false);

  // (4) 뷰어는 로드 직후 자동 재생 — 간소 바 라벨이 실제 상태(일시정지 가능)를 미러링한다.
  const toggle = page.getByTestId("viewer-play-toggle-half1");
  await expect(toggle).toContainText("일시정지");
  await page.screenshot({ path: `${CAP_DIR}play-mode-playing.png`, fullPage: false });

  // (5) 일시정지 → 실제로 틱이 멈춘다.
  await toggle.click();
  await expect(toggle).toContainText("재생");
  const paused = await tickNow(frame);
  await page.waitForTimeout(800);
  expect(await tickNow(frame)).toBe(paused);

  // (6) 다시 재생 → 실제로 틱이 전진한다.
  await toggle.click();
  await expect(toggle).toContainText("일시정지");
  await expect.poll(() => tickNow(frame), { timeout: 10_000 }).toBeGreaterThan(paused);
});

test("#148 플레이 모드 페이스 단계가 실제 재생속도를 바꾼다(칩이 무동작이 아니다)", async ({ page }) => {
  const frame = await openHalftime(page, false);
  const toggle = page.getByTestId("viewer-play-toggle-half1");
  await expect(toggle).toContainText("일시정지"); // 자동 재생 중

  // 기본은 하이라이트 자동페이싱(빌드업 빠르게·찬스 근처 느리게).
  await expect(page.getByTestId("viewer-pace-auto-half1")).toHaveAttribute("aria-pressed", "true");
  expect(await autoPaceOn(frame)).toBe(true);

  // 1x → 4x 로 올리면 실제 진행 속도(게임틱/실초)가 유의미하게 빨라져야 한다.
  await page.getByTestId("viewer-speed-1-half1").click();
  await expect(page.getByTestId("viewer-speed-1-half1")).toHaveAttribute("aria-pressed", "true");
  const rate1 = await measureRate(page, frame, 4000);
  await page.getByTestId("viewer-speed-4-half1").click();
  const rate4 = await measureRate(page, frame, 4000);
  console.log(`[#148] 진행 속도 — 1x: ${rate1.toFixed(2)} tick/s, 4x: ${rate4.toFixed(2)} tick/s`);
  expect(rate1, "1x 도 진행은 해야 함").toBeGreaterThan(0);
  expect(rate4, "4x 가 1x 보다 확실히 빨라야 함(칩이 무동작이면 여기서 잡힌다)").toBeGreaterThan(rate1 * 1.5);

  // 하이라이트로 되돌리면 뷰어 자동페이싱이 다시 켜지고, 배속 칩은 활성 표시가 풀린다.
  await page.getByTestId("viewer-pace-auto-half1").click();
  await expect.poll(() => autoPaceOn(frame)).toBe(true);
  await expect(page.getByTestId("viewer-speed-4-half1")).toHaveAttribute("aria-pressed", "false");
});

test("#148 admin 모드: 뷰어 풀컨트롤 노출 + 모드 토글로 플레이어 체감 전환", async ({ page }) => {
  const frame = await openHalftime(page, true);

  const chrome = await viewerChromeVisible(frame);
  expect(chrome, "admin 은 되감기·스크럽·슬로우배속까지 전부 보여야 함").toMatchObject({
    scrub: true,
    speed025: true,
    prevGoal: true,
  });
  expect(chrome.controlRows).toBeGreaterThan(0);
  // 풀컨트롤에선 web 간소 바를 중복 노출하지 않는다.
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toBeVisible();
  await page.screenshot({ path: `${CAP_DIR}admin-full-mode.png`, fullPage: false });

  // 모드 토글 → 플레이어가 보는 화면으로 즉시 전환(디버그 컨트롤 사라짐).
  await page.getByTestId("viewer-mode-play-half1").click();
  await expect(page.getByTestId("viewer-play-toggle-half1")).toBeVisible();
  await expect.poll(() => viewerChromeVisible(frame).then((c) => c.scrub)).toBe(false);
  await page.screenshot({ path: `${CAP_DIR}admin-switched-to-play.png`, fullPage: false });
});

test("#148 플레이 모드에서도 뷰어 로드 실패는 화면 안에 보인다(설명 없는 빈 피치 방지)", async ({ page }) => {
  // 손상 MatchLog 주입 → 뷰어 loadLog 가 throw → 상태줄이 실패 문구가 된다.
  // 플레이 크롬은 상태줄을 숨기지만, 실패 시엔 iframe 화면 상단에 고정 노출되어야 한다.
  await mockApi(page, { isAdmin: false, corruptLog: true });
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  const iframeEl = page.locator('[data-testid="viewer-visual-half1"] iframe');
  await expect(iframeEl).toBeVisible();
  const frame = (await (await iframeEl.elementHandle())!.contentFrame()) as Frame;

  const seen = await frame.evaluate(async () => {
    const el = document.getElementById("status")!;
    for (let i = 0; i < 40 && !/fail|invalid|error/i.test(el.textContent || ""); i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    const r = el.getBoundingClientRect();
    return {
      text: el.textContent || "",
      display: getComputedStyle(el).display,
      // 스크롤 없이 iframe 첫 화면 안에 있는가 — CSS 로만 보이는 것은 "보인다"가 아니다.
      inViewport: r.top >= 0 && r.bottom <= window.innerHeight && r.width > 0,
    };
  });
  expect(seen.text).toMatch(/fail|invalid|error/i);
  expect(seen.display).not.toBe("none");
  expect(seen.inViewport, "실패 문구가 iframe 첫 화면 안에 있어야 함").toBe(true);
  await page.screenshot({ path: `${CAP_DIR}play-mode-load-error.png`, fullPage: false });
});

test("#148 모바일 390px: 간소 컨트롤 가로 오버플로 0", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openHalftime(page, false);
  await expect(page.getByTestId("viewer-play-toggle-half1")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${CAP_DIR}play-mode-mobile390.png`, fullPage: false });
});
