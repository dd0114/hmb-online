import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { appConfigPayload, mockAppConfig } from "./app-config-mock";

/**
 * #262 디비전 승급/강등 화면 — **백엔드 없이** vite dev + `page.route` 로 `/api` 전면 목킹.
 *
 * 왜 필요한가: #252 가 서버에 사다리를 넣었지만 유저는 자기가 몇 부인지, 승급했는지 알 수 없었다
 * (`grep division apps/web/src` → 0건). hero 요구 "리그가 상승하며 난이도가 올라간다"의 절반이
 * 화면에 없던 상태다.
 *
 * 박제하는 계약:
 *  (1) 진행 중 시즌 — 디비전 뱃지 + 순위표 승급권/강등권 구역 + 규칙 문구
 *  (2) **컷은 서버 값을 따라간다** — 응답의 컷을 바꾸면 색칠 경계도 따라 움직인다(클라 하드코딩 금지)
 *  (3) 시즌 종료 — 승급 / 강등 연출
 *  (4) **구 서버 폴백** — 필드가 없으면 디비전 UI 가 통째로 사라지고 기존 화면 그대로(깨짐 0)
 *
 * 스펙 지정 실행 · 대체 포트(playwright.config PORT=5199, :8080 데모 무접촉) · pathname 매칭(glob 아님).
 * ⚠️ 라우트는 **pathname** 으로 잡는다 — glob 을 오리진 없이 쓰면 vite 에셋까지 걸려 흰 화면이 된다.
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const TEAM_IDS = ["USER", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"];

function standings(userRank: number) {
  // 승점만 내려가는 단조 순위표. 유저를 userRank 자리에 놓는다.
  const rows = TEAM_IDS.map((_, i) => i);
  return rows.map((i) => {
    const rank = i + 1;
    const isUser = rank === userRank;
    const teamId = isUser ? "USER" : `T${rank}`;
    return {
      teamId,
      name: isUser ? "내 팀" : `봇 ${rank}`,
      played: 18, won: 18 - i, drawn: 0, lost: i,
      goalsFor: 40 - i, goalsAgainst: 10 + i, goalDiff: 30 - 2 * i,
      points: 54 - 3 * i, rank, isUser,
    };
  });
}

interface SeasonOpts {
  state?: "ACTIVE" | "FINISHED";
  userRank?: number;
  division?: number | null;
  divisionName?: string | null;
  promoteRankMax?: number | null;
  relegateRankMin?: number | null;
}

function seasonPayload(o: SeasonOpts = {}) {
  const {
    state = "ACTIVE", userRank = 3,
    division = 5, divisionName = "디비전 5",
    promoteRankMax = 2, relegateRankMin = 9,
  } = o;
  const season: Record<string, unknown> = {
    id: "SEASON1", seasonNo: 1, state,
    teams: TEAM_IDS.map((t) => ({ teamId: t, name: t === "USER" ? "내 팀" : `봇 ${t}`, isUser: t === "USER" })),
    standings: standings(userRank),
    fixtures: [],
    nextUserFixture: state === "ACTIVE"
      ? { id: "F1", round: 1, homeTeam: "USER", awayTeam: "T2", isUser: true, state: "SCHEDULED" }
      : null,
  };
  // null 을 명시적으로 넘기면 **필드 자체를 빼서** 구 서버를 재현한다.
  if (division !== null) season.division = division;
  if (divisionName !== null) season.divisionName = divisionName;
  if (promoteRankMax !== null) season.promoteRankMax = promoteRankMax;
  if (relegateRankMin !== null) season.relegateRankMin = relegateRankMin;
  return { season };
}

async function bootstrap(page: Page, opts: SeasonOpts = {}) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
  // 캐치올 먼저 — 이후 등록한 구체 라우트가 우선한다.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await mockAppConfig(page, appConfigPayload());
  await page.route((url) => url.pathname === "/api/me", (route) =>
    route.fulfill(json({ userId: "U1", nickname: "테스터", points: 10000, gems: 100 })),
  );
  await page.route((url) => url.pathname === "/api/league", (route) =>
    route.fulfill(json(seasonPayload(opts))),
  );
  await page.goto("/league");
}

test.describe("#262 디비전 — 진행 중 시즌", () => {
  test("디비전 뱃지 · 승급권/강등권 구역 · 규칙 문구가 보인다", async ({ page }) => {
    await bootstrap(page, { state: "ACTIVE", userRank: 3 });

    await expect(page.getByTestId("division-tag")).toHaveText("디비전 5");
    await expect(page.getByTestId("division-rule")).toHaveText("1~2위 승급 · 9위부터 강등");

    // 1~2위 = 승급권, 9~10위 = 강등권, 3~8위 = 구역 없음.
    for (const rank of [1, 2]) {
      await expect(page.locator(`[data-testid="standing-T${rank}"]`)).toHaveAttribute("data-zone", "promote");
    }
    for (const rank of [9, 10]) {
      await expect(page.locator(`[data-testid="standing-T${rank}"]`)).toHaveAttribute("data-zone", "relegate");
    }
    for (const rank of [4, 8]) {
      await expect(page.locator(`[data-testid="standing-T${rank}"]`)).toHaveAttribute("data-zone", "hold");
    }

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}league-division-active.png`, fullPage: true });
  });

  test("컷은 서버 값을 따라간다 — 클라가 1~2위/9위를 기억하고 있으면 안 된다", async ({ page }) => {
    // 서버가 규칙을 바꾼 상황: 1~4위 승급 / 7위부터 강등.
    // ⚠️ userRank 자리는 teamId 가 USER 라 T{rank} 가 없다 — 단언할 순위와 겹치지 않게 1위로 둔다.
    await bootstrap(page, { state: "ACTIVE", userRank: 1, promoteRankMax: 4, relegateRankMin: 7 });

    await expect(page.getByTestId("division-rule")).toHaveText("1~4위 승급 · 7위부터 강등");
    // 구 규칙이면 hold 였을 자리들이 승급/강등으로 바뀐다.
    await expect(page.locator('[data-testid="standing-T4"]')).toHaveAttribute("data-zone", "promote");
    await expect(page.locator('[data-testid="standing-T7"]')).toHaveAttribute("data-zone", "relegate");
    await expect(page.locator('[data-testid="standing-T5"]')).toHaveAttribute("data-zone", "hold");
  });
});

test.describe("#262 디비전 — 시즌 종료 연출", () => {
  test("승급: 2위로 끝나면 승급 카드가 뜬다", async ({ page }) => {
    await bootstrap(page, { state: "FINISHED", userRank: 2 });
    const card = page.getByTestId("division-outcome");
    await expect(card).toHaveAttribute("data-zone", "promote");
    await expect(card).toContainText("승급!");
    await expect(card).toContainText("디비전 5에서 2위");
    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}league-division-promote.png`, fullPage: true });
  });

  test("강등: 10위로 끝나면 강등 카드가 뜬다", async ({ page }) => {
    await bootstrap(page, { state: "FINISHED", userRank: 10 });
    const card = page.getByTestId("division-outcome");
    await expect(card).toHaveAttribute("data-zone", "relegate");
    await expect(card).toContainText("강등");
    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}league-division-relegate.png`, fullPage: true });
  });

  test("유지: 5위로 끝나면 유지 카드", async ({ page }) => {
    await bootstrap(page, { state: "FINISHED", userRank: 5 });
    await expect(page.getByTestId("division-outcome")).toHaveAttribute("data-zone", "hold");
  });
});

test.describe("#262 구 서버 폴백 — 필드가 없으면 조용히 사라진다", () => {
  test("division 부재: 디비전 UI 0개, 순위표는 그대로 렌더된다", async ({ page }) => {
    await bootstrap(page, {
      state: "ACTIVE", userRank: 3,
      division: null, divisionName: null, promoteRankMax: null, relegateRankMin: null,
    });

    await expect(page.getByTestId("standings")).toBeVisible();
    await expect(page.getByTestId("division-tag")).toHaveCount(0);
    await expect(page.getByTestId("division-rule")).toHaveCount(0);
    // 구역 색칠도 없어야 한다 — 컷을 모르는데 칠하면 거짓말이다.
    await expect(page.locator('[data-testid="standings"] tr[data-zone]')).toHaveCount(0);
  });

  test("division 은 있는데 컷이 없으면: 뱃지만 뜨고 구역은 안 칠한다", async ({ page }) => {
    await bootstrap(page, {
      state: "ACTIVE", userRank: 3, division: 7, divisionName: "디비전 7",
      promoteRankMax: null, relegateRankMin: null,
    });

    await expect(page.getByTestId("division-tag")).toHaveText("디비전 7");
    await expect(page.getByTestId("division-rule")).toHaveCount(0);
    await expect(page.locator('[data-testid="standings"] tr[data-zone]')).toHaveCount(0);
  });

  test("시즌 종료인데 컷이 없으면 승급/강등 연출을 하지 않는다", async ({ page }) => {
    await bootstrap(page, {
      state: "FINISHED", userRank: 1, division: 7,
      promoteRankMax: null, relegateRankMin: null,
    });
    await expect(page.getByTestId("season-end")).toBeVisible();
    await expect(page.getByTestId("division-outcome")).toHaveCount(0);
  });
});

test.describe("#262 모바일 390px", () => {
  test("헤더 뱃지·순위표가 가로 오버플로 없이 들어간다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrap(page, { state: "ACTIVE", userRank: 3 });
    await expect(page.getByTestId("division-tag")).toBeVisible();

    // 페이지 가로 스크롤 0 — 헤더에 뱃지를 하나 더 얹었으므로 실제로 위험한 자리다.
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);

    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}league-division-mobile.png`, fullPage: true });
  });

  test("시즌 종료 승급 카드도 390px 에서 안 넘친다", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await bootstrap(page, { state: "FINISHED", userRank: 2 });
    await expect(page.getByTestId("division-outcome")).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    mkdirSync(SMOKE_DIR, { recursive: true });
    await page.screenshot({ path: `${SMOKE_DIR}league-division-mobile-end.png`, fullPage: true });
  });
});
