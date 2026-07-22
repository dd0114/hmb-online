import { expect, test, type Page } from "@playwright/test";
import { mkdirSync, readFileSync } from "node:fs";

/**
 * P4-E1 S1 (#169) — 게임화면 "경기장면 고정 메인 + 정보 토글" 계약.
 * 설계 SoT = docs/plan-v5/layout-game-screen.md §2·§3, AC = PRD-v5 AC-W1-1.
 *
 * E2E-TDD: 이 파일이 구현보다 먼저 작성됐다(루트 CLAUDE §2-3). 백엔드 없이 route-mock 으로
 * 실화면 계약을 박제한다.
 *
 * 계약:
 *  a. 모바일(390×844) 페이지 세로 스크롤 0 · 가로 오버플로 0.
 *  b. 데스크탑(1280×800) 동일 + 무대가 뷰포트 안.
 *  c. 3토글(통계·로그·후반지시) 기본 off — 유저가 켠 것만 보인다.
 *     (하프타임 감독 패널·종료 결과 패널은 **상태가 소유**하는 패널이라 토글과 별개로 자동 표시.)
 *  d. 3토글은 서로 독립 — 하나를 켜고 끄는 게 다른 것에 영향 없음.
 *  e. 어떤 조합에서도 **무대(경기장면)는 화면에 남는다**(리서치 R2).
 *  f. 토글 선택은 리로드 후에도 유지(localStorage).
 *
 * ⚠️ 라우트 매칭은 pathname 술어로 한다. glob('**\/api\/**') 는 vite 소스 /src/api/*.ts 까지
 * 잡아 흰 화면이 된다(프로젝트 기지식 — web-visual-qa-mock-harness).
 */

const CAP_DIR = new URL("../.stage/", import.meta.url).pathname;
const MATCH_ID = "m-stage";
const MATCH_LOG = JSON.parse(
  readFileSync(new URL("../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname, "utf8"),
);

const PHONE = { width: 390, height: 844 };
const DESKTOP = { width: 1280, height: 800 };

const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({
      slotIndex: i,
      playerId: `p${i + 1}`,
      role: "starter" as const,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      slotIndex: i,
      playerId: `b${i + 1}`,
      role: "bench" as const,
    })),
  ],
};
const PLAYERS = [
  ...Array.from({ length: 11 }, (_, i) => ({
    id: `p${i + 1}`,
    name: `선수${i + 1}`,
    position: i === 0 ? "GK" : i < 5 ? "DF" : i < 9 ? "MF" : "FW",
    grade: "B",
  })),
  ...Array.from({ length: 5 }, (_, i) => ({
    id: `b${i + 1}`,
    name: `벤치${i + 1}`,
    position: i === 0 ? "GK" : "MF",
    grade: "C",
  })),
];

async function mockApi(page: Page, state: string) {
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith("/api/")) return route.continue();
    if (url.pathname === "/api/me") {
      return route.fulfill({
        json: {
          user: { id: "u1", nickname: "테스터", points: 100, wins: 1, draws: 0, losses: 0, isAdmin: false },
        },
      });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}`) {
      return route.fulfill({
        json: {
          id: MATCH_ID,
          state,
          scoreH1Home: 2,
          scoreH1Away: 1,
          scoreHome: 3,
          scoreAway: 2,
          result: "WIN",
          createdAt: "2026-07-22T09:00:00Z",
          opponent: { name: "봇 FC" },
        },
      });
    }
    if (/\/api\/matches\/.+\/halves\/[12]\/log$/.test(url.pathname)) {
      return route.fulfill({ json: MATCH_LOG });
    }
    if (url.pathname === `/api/matches/${MATCH_ID}/result`) {
      return route.fulfill({
        json: { result: "WIN", scoreHome: 3, scoreAway: 2, pointsAwarded: 120 },
      });
    }
    if (url.pathname === "/api/players") return route.fulfill({ json: PLAYERS });
    if (url.pathname === "/api/deck") return route.fulfill({ json: DECK });
    return route.fulfill({ json: {} });
  });
}

async function openMatch(page: Page, state = "H1_BREAK") {
  await mockApi(page, state);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "local");
  });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("stage-shell")).toBeVisible();
  await expect(page.getByTestId("stage-canvas")).toBeVisible();
}

/** 페이지(문서) 자체가 스크롤되는지 — 무대 고정의 핵심 지표. */
function pageScroll(page: Page) {
  return page.evaluate(() => {
    const d = document.documentElement;
    const b = document.body;
    return {
      vScroll: Math.max(d.scrollHeight - d.clientHeight, b.scrollHeight - d.clientHeight),
      hScroll: Math.max(d.scrollWidth - d.clientWidth, b.scrollWidth - d.clientWidth),
    };
  });
}

/** iframe 안에서 실제로 그려지는 피치 캔버스의 렌더 크기(무대가 살아있는지의 진짜 지표). */
async function pitchCanvasBox(page: Page): Promise<{ width: number; height: number } | null> {
  const frame = page.frameLocator('[data-testid^="viewer-visual-half"] iframe');
  const canvas = frame.locator("canvas#pitch");
  await canvas.waitFor({ state: "visible", timeout: 20_000 });
  return canvas.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { width: r.width, height: r.height };
  });
}

async function toggle(page: Page, key: "stats" | "log" | "brief") {
  await page.getByTestId(`stage-toggle-${key}`).click();
}

function pressed(page: Page, key: "stats" | "log" | "brief") {
  return page.getByTestId(`stage-toggle-${key}`).getAttribute("aria-pressed");
}

test.beforeAll(() => mkdirSync(CAP_DIR, { recursive: true }));

test.describe("AC-W1-1 경기장면 고정 (모바일 390×844)", () => {
  test.use({ viewport: PHONE });

  test("a. 페이지 세로 스크롤 0 · 가로 오버플로 0 — 어떤 토글 조합에서도", async ({ page }) => {
    await openMatch(page);

    const base = await pageScroll(page);
    expect(base.vScroll, "기본 상태에서 문서 세로 스크롤이 있으면 안 됨(무대가 스크롤 밖으로 나감)").toBeLessThanOrEqual(1);
    expect(base.hScroll, "390px 에서 가로 오버플로 0").toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${CAP_DIR}phone-default.png` });

    for (const key of ["stats", "log", "brief"] as const) {
      await toggle(page, key);
      const s = await pageScroll(page);
      expect(s.vScroll, `${key} 패널을 켰을 때 문서 스크롤이 생기면 안 됨(스크롤은 패널 내부에만)`).toBeLessThanOrEqual(1);
      expect(s.hScroll, `${key} 패널에서 가로 오버플로 0`).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: `${CAP_DIR}phone-all-panels.png` });
  });

  test("c. 기본은 경기장면만 — 3토글 전부 off, 통계/로그/후반지시 패널 없음", async ({ page }) => {
    await openMatch(page);

    for (const key of ["stats", "log", "brief"] as const) {
      expect(await pressed(page, key), `${key} 토글 기본값은 off`).toBe("false");
      await expect(page.getByTestId(`stage-panel-${key}`)).toHaveCount(0);
    }
    // 시트에는 상태 패널(감독) 하나뿐이라 탭 줄 자체가 없다 = 정보 패널이 0개라는 뜻.
    // (H1_BREAK/FINISHED 는 상태 패널을 항상 열기 때문에 "시트 부재"로는 잴 수 없다.
    //  시트가 통째로 없는 화면은 W3 라이브 관전 상태가 생길 때 도달 가능해진다 — tabsFor 단위테스트가 담보.)
    await expect(page.getByRole("tablist", { name: "정보 패널" })).toHaveCount(0);
  });

  test("d. 3토글 독립 — 하나를 켜고 꺼도 나머지는 그대로", async ({ page }) => {
    await openMatch(page);

    await toggle(page, "stats");
    await expect(page.getByTestId("stage-panel-stats")).toBeVisible();
    await expect(page.getByTestId("stage-panel-log")).toHaveCount(0);
    await expect(page.getByTestId("stage-panel-brief")).toHaveCount(0);
    expect(await pressed(page, "log")).toBe("false");

    await toggle(page, "log");
    expect(await pressed(page, "stats"), "로그를 켠다고 통계가 꺼지면 안 됨").toBe("true");
    await page.getByTestId("stage-tab-log").click();
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();

    await toggle(page, "stats");
    expect(await pressed(page, "stats")).toBe("false");
    expect(await pressed(page, "log"), "통계를 꺼도 로그는 켜진 채").toBe("true");
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();
    await expect(page.getByTestId("stage-panel-stats")).toHaveCount(0);
  });

  test("e. 어떤 조합에서도 무대(경기장면)는 화면에 남는다", async ({ page }) => {
    await openMatch(page);

    await toggle(page, "stats");
    await toggle(page, "log");
    await toggle(page, "brief");

    const box = await page.getByTestId("stage-canvas").boundingBox();
    expect(box, "무대 박스가 존재해야 함").not.toBeNull();
    expect(box!.height, "패널을 다 켜도 무대는 접히면 안 됨").toBeGreaterThan(80);
    expect(box!.y, "무대가 뷰포트 위로 밀려나면 안 됨").toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height, "무대가 뷰포트 아래로 넘치면 안 됨").toBeLessThanOrEqual(PHONE.height + 1);

    // 박스만 남고 경기장면이 죽어도 위 단언은 통과한다 → **실제 캔버스**를 재서 계약을 닫는다.
    const canvas = await pitchCanvasBox(page);
    expect(canvas, "iframe 안 경기 캔버스가 실제로 존재해야 함").not.toBeNull();
    expect(canvas!.width, "캔버스가 무대 폭을 채워야 함").toBeGreaterThan(box!.width * 0.9);
    expect(canvas!.height, "캔버스가 납작해지면 안 됨").toBeGreaterThan(80);
  });

  test("f. 토글 선택은 리로드 후에도 유지된다", async ({ page }) => {
    await openMatch(page);
    await toggle(page, "log");
    expect(await pressed(page, "log")).toBe("true");

    await page.reload();
    await expect(page.getByTestId("stage-shell")).toBeVisible();
    expect(await pressed(page, "log"), "localStorage 로 토글 상태 유지").toBe("true");
    expect(await pressed(page, "stats"), "안 켰던 건 여전히 off").toBe("false");

    // 켜둔 패널은 탭으로 남아 있고 한 번에 열린다. 단, **상태 패널(감독)이 먼저** 보인다 —
    // 하프타임엔 유저가 해야 할 일(교체·후반 시작)이 정보 패널보다 우선이다(stage-state 규칙).
    await expect(page.getByTestId("halftime-panel")).toBeVisible();
    await page.getByTestId("stage-tab-log").click();
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();
  });

  test("결과 화면(FINISHED)도 무대 + 결과 탭으로 고정된다(기존 testid 보존)", async ({ page }) => {
    await openMatch(page, "FINISHED");

    // 상태가 소유하는 패널 — 토글과 무관하게 자동 표시.
    await expect(page.getByTestId("result-page")).toBeVisible();
    await expect(page.getByTestId("final-score")).toBeVisible();
    await expect(page.getByTestId("result-badge")).toBeVisible();
    await expect(page.getByTestId("team-stats")).toBeVisible();
    await expect(page.getByTestId("to-lobby")).toBeVisible();

    const s = await pageScroll(page);
    expect(s.vScroll, "결과 화면도 문서 스크롤 0").toBeLessThanOrEqual(1);
    expect(s.hScroll).toBeLessThanOrEqual(1);
    await expect(page.getByTestId("stage-canvas")).toBeVisible();
    await page.screenshot({ path: `${CAP_DIR}phone-result.png` });
  });

  test("하프타임 감독 패널은 상태 소유 — 자동 표시되고 3토글은 여전히 off", async ({ page }) => {
    await openMatch(page, "H1_BREAK");

    await expect(page.getByTestId("halftime-panel")).toBeVisible();
    await expect(page.getByTestId("h1-score")).toBeVisible();
    await expect(page.getByTestId("resume-button")).toBeVisible();
    for (const key of ["stats", "log", "brief"] as const) {
      expect(await pressed(page, key)).toBe("false");
    }
    await page.screenshot({ path: `${CAP_DIR}phone-halftime.png` });
  });
});

test.describe("AC-W1-1 경기장면 고정 (데스크탑 1280×800)", () => {
  test.use({ viewport: DESKTOP });

  test("b. 데스크탑도 문서 스크롤 0 + 무대가 뷰포트 안 + **가운데 정렬**(도크 없음)", async ({ page }) => {
    await openMatch(page);

    const base = await pageScroll(page);
    expect(base.vScroll).toBeLessThanOrEqual(1);
    expect(base.hScroll).toBeLessThanOrEqual(1);
    await page.screenshot({ path: `${CAP_DIR}desktop-default.png` });

    await toggle(page, "stats");
    await toggle(page, "log");
    const s = await pageScroll(page);
    expect(s.vScroll, "패널을 열어도 문서 스크롤 0").toBeLessThanOrEqual(1);
    expect(s.hScroll).toBeLessThanOrEqual(1);

    const box = (await page.getByTestId("stage-canvas").boundingBox())!;
    expect(box.y + box.height).toBeLessThanOrEqual(DESKTOP.height + 1);
    expect(box.width, "데스크탑에서 무대가 모바일 폭(480)에 갇히면 안 됨").toBeGreaterThan(480);

    // hero 결정(2026-07-22): 데스크탑은 **폰의 넓은 버전**이다 — 우측 도크를 없애고 무대를 가운데 둔다.
    // 도크 시절엔 무대 중심이 왼쪽으로 180px 쏠려 화면이 비대칭이었다. 그 회귀를 여기서 막는다.
    const stageCenter = box.x + box.width / 2;
    expect(Math.abs(stageCenter - DESKTOP.width / 2), "무대가 가로 가운데에 있어야 함(좌 쏠림 금지)").toBeLessThanOrEqual(4);

    // 시트는 무대 **옆**이 아니라 **아래**에 있다(도크 폐기의 실체).
    const sheet = (await page.getByTestId("stage-sheet").boundingBox())!;
    expect(sheet.y, "시트는 무대 아래에서 시작").toBeGreaterThanOrEqual(box.y + box.height - 1);
    expect(sheet.width, "시트는 화면 폭을 쓴다(측면 도크 아님)").toBeGreaterThan(DESKTOP.width * 0.9);

    const canvas = await pitchCanvasBox(page);
    expect(canvas!.width, "데스크탑 캔버스도 무대 폭을 채운다").toBeGreaterThan(480);
    await page.screenshot({ path: `${CAP_DIR}desktop-panels.png` });
  });

  test("g. 로그가 쌓여도 무대 크기가 변하지 않는다(시트 높이는 콘텐츠와 무관)", async ({ page }) => {
    await openMatch(page);
    await toggle(page, "log");
    await expect(page.getByTestId("stage-panel-log")).toBeVisible();

    const lines = page.locator('[data-testid="stage-panel-log"] li');
    const before = (await page.getByTestId("stage-canvas").boundingBox())!;
    const beforeCount = await lines.count();

    // 재생이 진행되며 로그가 실제로 늘어날 때까지 기다린다(가짜 통과 방지 — 안 늘면 이 테스트는 의미 없다).
    await expect
      .poll(() => lines.count(), { timeout: 30_000, message: "재생 중 로그 라인이 늘어야 한다" })
      .toBeGreaterThan(beforeCount + 2);

    const after = (await page.getByTestId("stage-canvas").boundingBox())!;
    // 시트가 내용만큼 자라면 무대가 그만큼 줄어든다(실제로 그랬다) → 크기 불변을 못박는다.
    expect(after.height, "로그가 늘어도 무대 높이 불변").toBeCloseTo(before.height, 0);
    expect(after.width, "로그가 늘어도 무대 폭 불변").toBeCloseTo(before.width, 0);
    expect(after.y, "무대 위치도 그대로").toBeCloseTo(before.y, 0);

    // 넘치는 로그는 패널 **안에서만** 스크롤된다(문서는 여전히 스크롤 0).
    const panelScroll = await page.evaluate(() => {
      const el = document.querySelector('[data-testid="stage-panel-log"]')?.parentElement;
      return el ? { scrollH: el.scrollHeight, clientH: el.clientHeight } : null;
    });
    expect(panelScroll, "로그 패널 스크롤 컨테이너가 있어야 함").not.toBeNull();
    expect((await pageScroll(page)).vScroll).toBeLessThanOrEqual(1);
  });
});
