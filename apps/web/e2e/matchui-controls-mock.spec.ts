import { expect, test, type Frame, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * #148 매치 화면 컨트롤 간소화 — 백엔드 없이 route-mock 으로 실화면 계약을 박제한다.
 *
 * 계약(hero 재지시 2026-07-21):
 *  - 플레이 모드(일반 유저): 경기는 **자동 진행**하고 컨트롤은 **하이라이트 토글 하나뿐**이다.
 *    재생/일시정지·배속·되감기·프레임점프·스크럽·배율은 web 에도 iframe 안에도 없다.
 *    토글은 실제로 뷰어 연출을 끄고 켠다(자동페이싱 on/off + 꺼도 진행이 멈추거나 느려지지 않음).
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

test("#148 플레이 모드: 컨트롤은 하이라이트 토글 하나뿐이고 경기는 자동 진행한다", async ({ page }) => {
  const frame = await openHalftime(page, false);

  // (1) iframe 안 디버그 컨트롤 전부 비노출 — 경기 장면은 그대로.
  // #169 S1: 스코어보드도 iframe 안에선 숨는다 — 호스트(게임화면 스코어바)가 소유하게 바뀌었다.
  // 둘 다 보이면 같은 스코어가 두 번 나온다.
  const chrome = await viewerChromeVisible(frame);
  expect(chrome, "플레이 모드에선 컨트롤 행/스크럽/슬로우배속/프레임점프/디버그 제목이 안 보여야 함").toMatchObject({
    controlRows: 0,
    scrub: false,
    speed025: false,
    prevGoal: false,
    title: false,
    pitch: true,
    scoreboard: false,
  });
  // 스코어는 사라진 게 아니라 호스트로 옮겨졌다(중복 없이 한 곳에서).
  await expect(page.getByTestId("stage-scorebar")).toBeVisible();
  await expect(page.getByTestId("stage-score")).toBeVisible();

  // (2) web 바에도 하이라이트 토글 외에는 아무 컨트롤이 없다.
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toBeVisible();
  await expect(page.getByTestId("viewer-play-toggle-half1")).toHaveCount(0);
  for (const s of [1, 2, 4]) await expect(page.getByTestId(`viewer-speed-${s}-half1`)).toHaveCount(0);
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toHaveCount(0);
  const buttons = await page.getByTestId("viewer-controls-half1").locator("button").count();
  expect(buttons, "플레이 모드 컨트롤 바의 버튼은 하이라이트 토글 하나뿐").toBe(1);

  // 컨트롤을 찾으러 스크롤하지 않아도 되게 — 데스크탑 기본 뷰포트에서 바가 화면 안에 있어야 한다.
  const bar = await page.getByTestId("viewer-controls-half1").boundingBox();
  const vh = page.viewportSize()!.height;
  expect(bar!.y + bar!.height, "컨트롤 바가 첫 화면 안에 보여야 함").toBeLessThanOrEqual(vh);
  await page.screenshot({ path: `${CAP_DIR}play-mode.png`, fullPage: false });

  // (3) 아무 조작 없이도 경기가 진행된다(자동 진행 — 재생 버튼이 없으므로 이게 유일한 시작 경로).
  const t0 = await tickNow(frame);
  await expect.poll(() => tickNow(frame), { timeout: 10_000 }).toBeGreaterThan(t0);

  // (4) 기본 배속은 4x — 조작 없이도 뷰어 speed 가 4 로 박혀 있다(뷰어 자체 기본 1x 는 너무 느림).
  await expect
    .poll(() => frame.evaluate(() => document.querySelector("[data-speed].active")?.getAttribute("data-speed")))
    .toBe("4");
});

test("#148 하이라이트 토글이 실제로 연출을 끄고 켠다(끄면 일정 속도로 계속 진행)", async ({ page }) => {
  const frame = await openHalftime(page, false);
  const toggle = page.getByTestId("viewer-highlight-toggle-half1");

  // 기본은 하이라이트 on — 뷰어 자동페이싱(주요장면 슬로우·접촉 줌)이 켜져 있다.
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  expect(await autoPaceOn(frame)).toBe(true);

  // 끄면: 뷰어 자동페이싱 off + 진행은 계속(멈추거나 1x 로 처지지 않아야 한다 — 배속 컨트롤이 없으므로).
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => autoPaceOn(frame)).toBe(false);
  const rateOff = await measureRate(page, frame, 4000);
  console.log(`[#148] 하이라이트 off 진행 속도: ${rateOff.toFixed(2)} tick/s`);
  expect(rateOff, "연출을 꺼도 경기는 계속 진행해야 함").toBeGreaterThan(0);
  expect(rateOff, "뷰어 기본 1x(=2 tick/s)에 갇히면 안 됨 — 배속 컨트롤이 없다").toBeGreaterThan(3);

  // 다시 켜면 자동페이싱 복귀 + 진행 유지.
  await toggle.click();
  await expect.poll(() => autoPaceOn(frame)).toBe(true);
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  const rateOn = await measureRate(page, frame, 3000);
  expect(rateOn, "하이라이트 on 에서도 진행은 계속").toBeGreaterThan(0);
  await page.screenshot({ path: `${CAP_DIR}play-mode-highlight-on.png`, fullPage: false });
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
  // 풀컨트롤에선 web 바를 중복 노출하지 않는다.
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toHaveCount(0);
  await expect(page.getByTestId("viewer-mode-toggle-half1")).toBeVisible();
  await page.screenshot({ path: `${CAP_DIR}admin-full-mode.png`, fullPage: false });

  // 모드 토글 → 플레이어가 보는 화면으로 즉시 전환(디버그 컨트롤 사라짐).
  await page.getByTestId("viewer-mode-play-half1").click();
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toBeVisible();
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
  await expect(page.getByTestId("viewer-highlight-toggle-half1")).toBeVisible();
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${CAP_DIR}play-mode-mobile390.png`, fullPage: false });
});
