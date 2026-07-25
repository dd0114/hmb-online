import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * G4 성장/강화 UI route-mock 스모크(에픽 #179) — **백엔드 없이** vite dev + page.route 로 /api 목킹.
 * 계약 박제: (1) 도감 보유카드 → 성장 상세 시안3 렌더(OVR 링·돌파★·완성도·능력치 현재/천장/기본),
 * (2) 강화 클릭 → 스탯 fill 증가, (3) 한계돌파 → promoted → 프레임 등급색 전환, (4) 성장 리포트 렌더.
 * 스펙 지정·대체포트(playwright.config PORT=5199, :8080 데모 무접촉)·pathname 매칭(glob 아님).
 */

const SMOKE_DIR = new URL("../.smoke/", import.meta.url).pathname;
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
const err = (status: number, code: string, message: string) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify({ code, message }),
});

const OWNED_ID = "P001";
const attrs = {
  technical: 44, mental: 41, physical: 40, passing: 42, shooting: 55,
  tackling: 30, pace: 60, stamina: 43, positioning: 45,
};
const PLAYERS_RESPONSE = [
  { id: OWNED_ID, name: "양민혁", position: "FW", grade: "SILVER", owned: true, ownedCount: 3, attributes: attrs },
  { id: "P099", name: "잠금 선수", position: "DF", grade: "GOLD", owned: false, ownedCount: 0, attributes: attrs },
];

const ME_RESPONSE = {
  user: { id: "u1", nickname: "내 팀" },
  wallet: { points: 5000 },
  records: { wins: 0, draws: 0, losses: 0 },
};

/** cur/cap/base 능력치 세트 — enhance 로 cur/cap 이 오른다. */
function attrSet(bump: number) {
  const cur: Record<string, number> = {};
  const caps: Record<string, number> = {};
  const base: Record<string, number> = {};
  for (const [k, v] of Object.entries(attrs)) {
    base[k] = v;
    cur[k] = Math.min(100, v + 8 + bump);
    caps[k] = Math.min(100, v + 18 + bump);
  }
  return { cur, caps, base };
}

async function seedAuth(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
  });
}

/**
 * 성장 카드 목 — 상태ful. enhance 마다 bump↑(cur/cap↑), limitbreak 시 effectiveGrade 승급.
 * enhanceCap 도달을 흉내내려면 opts.enhanceMaxAt 이후 POST enhance 가 4xx ENHANCE_MAX.
 */
async function mockGrowth(page: Page, opts: { enhanceMaxAt?: number } = {}) {
  let bump = 0;
  let enhanceCount = 0;
  let effectiveGrade = "SILVER"; // baseGrade BRONZE → 돌파 1단계

  // catch-all 먼저(구체 라우트가 나중에 우선). pathname 매칭 — glob '**/api/**' 는 vite 소스까지 잡음.
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME_RESPONSE)));
  await page.route((url) => url.pathname === "/api/players", (route) => route.fulfill(json(PLAYERS_RESPONSE)));

  await page.route(
    (url) => url.pathname === `/api/growth/card/${OWNED_ID}`,
    (route) => {
      const { cur, caps, base } = attrSet(bump);
      route.fulfill(
        json({
          playerId: OWNED_ID,
          baseGrade: "BRONZE",
          effectiveGrade,
          attributes: cur,
          caps,
          base,
          ovr: 58 + bump,
          completion: Math.min(1, 0.62 + enhanceCount * 0.08),
        }),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/api/growth/enhance",
    (route) => {
      if (opts.enhanceMaxAt != null && enhanceCount >= opts.enhanceMaxAt) {
        route.fulfill(err(409, "ENHANCE_MAX", "강화 상한"));
        return;
      }
      enhanceCount += 1;
      bump += 4;
      route.fulfill(
        json({ playerId: OWNED_ID, enhanceLevel: enhanceCount, limitBreak: 1, effectiveGrade, ovr: 58 + bump, promoted: false, spent: { copies: 0, points: 200 } }),
      );
    },
  );
  await page.route(
    (url) => url.pathname === "/api/growth/limitbreak",
    (route) => {
      effectiveGrade = "GOLD"; // 승급
      bump += 2;
      route.fulfill(
        json({ playerId: OWNED_ID, enhanceLevel: enhanceCount, limitBreak: 2, effectiveGrade, ovr: 58 + bump, promoted: true, spent: { copies: 3, points: 0 } }),
      );
    },
  );
}

test("G4 도감 성장 상세(시안3): OVR 링·돌파★·완성도·능력치 3표시 + 강화→스탯↑ + 한계돌파→승급", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await mockGrowth(page, { enhanceMaxAt: 1 });
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/codex");

  // 보유 카드 탭 → 성장 상세 시트.
  await page.getByTestId(`codex-card-${OWNED_ID}`).getByRole("button").first().click();
  const sheet = page.getByTestId("growth-detail");
  await expect(sheet).toBeVisible();

  // 시안3 요소: OVR 링(중앙 숫자)·완성도%·돌파★(BRONZE→SILVER = 1단계).
  await expect(page.getByTestId("growth-ovr")).toHaveText("58");
  await expect(page.getByTestId("growth-completion")).toContainText("완성도");
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-breakthrough", "1");
  await expect(page.getByTestId("growth-frame")).toHaveAttribute("data-grade", "SILVER");
  // 능력치 막대: 현재값(fill)이 값을 노출.
  await expect(page.getByTestId("growth-attr-shooting")).toBeVisible();
  const shootBefore = Number(await page.getByTestId("growth-fill-shooting").getAttribute("data-value"));

  await page.screenshot({ path: `${SMOKE_DIR}growth-detail-schema3.png`, fullPage: true });

  // 강화 → 스탯 fill 증가(재조회 반영).
  await page.getByTestId("growth-enhance").click();
  await expect
    .poll(async () => Number(await page.getByTestId("growth-fill-shooting").getAttribute("data-value")))
    .toBeGreaterThan(shootBefore);
  const ovrAfterEnhance = Number(await page.getByTestId("growth-ovr").innerText());
  expect(ovrAfterEnhance).toBeGreaterThan(58);

  // 강화 상한 도달 → ENHANCE_MAX → "한계돌파 가능" 배지 + limitbreak ready.
  await page.getByTestId("growth-enhance").click(); // enhanceCount now 2 == max → 4xx
  await expect(page.getByTestId("growth-limitbreak-badge")).toBeVisible();
  await expect(page.getByTestId("growth-limitbreak")).toHaveAttribute("data-ready", "true");

  // 한계돌파 → promoted → 프레임 등급색 GOLD 전환 + 돌파★ 2단계 + 승급 플래시.
  await page.getByTestId("growth-limitbreak").click();
  await expect(page.getByTestId("growth-promoted")).toBeVisible();
  await expect(page.getByTestId("growth-frame")).toHaveAttribute("data-grade", "GOLD");
  await expect(page.getByTestId("growth-stars")).toHaveAttribute("data-breakthrough", "2");

  // 390px 가로 오버플로 0.
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  console.log(`[smoke] growth-detail 390px overflow px = ${overflow}`);
  expect(overflow).toBeLessThanOrEqual(0);
  await page.screenshot({ path: `${SMOKE_DIR}growth-detail-promoted.png`, fullPage: true });
});

test("G4 미보유 카드는 성장 UI 없이 기존 인라인 확장(잠금)만", async ({ page }) => {
  await mockGrowth(page);
  await seedAuth(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/codex");

  await page.getByTestId("codex-card-P099").getByRole("button").first().click();
  // 성장 시트가 뜨지 않는다(미보유).
  await expect(page.getByTestId("growth-detail")).toHaveCount(0);
  // 기존 인라인 능력치 확장은 유지.
  await expect(page.getByTestId("codex-attrs-P099")).toBeVisible();
});

// ── 성장 리포트(S1) — ResultPage 하단 ────────────────────────────────
const MATCH_ID = "M777";
const REPORT = {
  matchId: MATCH_ID,
  entries: [
    { playerId: OWNED_ID, name: "양민혁", xpDelta: 120, ovrBefore: 58, ovrAfter: 60, leveledUp: true, topAttrs: ["슛", "스피드"] },
    { playerId: "P042", name: "김수비", xpDelta: 45, ovrBefore: 62, ovrAfter: 62, leveledUp: false, topAttrs: ["태클"] },
  ],
};
const FINISHED_MATCH = {
  id: MATCH_ID,
  state: "FINISHED",
  opponent: { name: "봇 FC", analysisText: "", deck: [] },
  scoreHome: 2,
  scoreAway: 1,
  result: "WIN",
  createdAt: "2026-07-26T00:00:00Z",
};

test("G4 성장 리포트(S1): ResultPage 하단 — 선수별 +xp·OVR before→after·레벨업 뱃지·topAttrs", async ({ page }) => {
  mkdirSync(SMOKE_DIR, { recursive: true });
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME_RESPONSE)));
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) => route.fulfill(json(FINISHED_MATCH)));
  await page.route(
    (url) => url.pathname === `/api/matches/${MATCH_ID}/result`,
    (route) => route.fulfill(json({ matchId: MATCH_ID, scoreHome: 2, scoreAway: 1, result: "WIN", pointsAwarded: 100 })),
  );
  await page.route((url) => /\/api\/matches\/M777\/halves\/[12]\/log$/.test(url.pathname), (route) => route.fulfill(json({ events: [] })));
  await page.route((url) => url.pathname === `/api/growth/report/${MATCH_ID}`, (route) => route.fulfill(json(REPORT)));
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/match/${MATCH_ID}`);

  await expect(page.getByTestId("result-page")).toBeVisible();
  const report = page.getByTestId("growth-report");
  await expect(report).toBeVisible();
  await expect(page.getByTestId(`growth-xp-${OWNED_ID}`)).toContainText("+120");
  await expect(page.getByTestId(`growth-ovr-${OWNED_ID}`)).toContainText("58 → 60");
  await expect(page.getByTestId(`growth-levelup-${OWNED_ID}`)).toBeVisible();
  // 레벨업 안 한 선수는 뱃지 없음.
  await expect(page.getByTestId("growth-levelup-P042")).toHaveCount(0);

  await report.scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${SMOKE_DIR}growth-report.png`, fullPage: true });
});

test("G4 성장 리포트: entries 비면 섹션 숨김", async ({ page }) => {
  await page.route((url) => url.pathname.startsWith("/api/"), (route) => route.fulfill(json({})));
  await page.route((url) => url.pathname === "/api/me", (route) => route.fulfill(json(ME_RESPONSE)));
  await page.route((url) => url.pathname === `/api/matches/${MATCH_ID}`, (route) => route.fulfill(json(FINISHED_MATCH)));
  await page.route(
    (url) => url.pathname === `/api/matches/${MATCH_ID}/result`,
    (route) => route.fulfill(json({ matchId: MATCH_ID, scoreHome: 2, scoreAway: 1, result: "WIN", pointsAwarded: 100 })),
  );
  await page.route((url) => /\/api\/matches\/M777\/halves\/[12]\/log$/.test(url.pathname), (route) => route.fulfill(json({ events: [] })));
  await page.route((url) => url.pathname === `/api/growth/report/${MATCH_ID}`, (route) => route.fulfill(json({ matchId: MATCH_ID, entries: [] })));
  await seedAuth(page);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`/match/${MATCH_ID}`);
  await expect(page.getByTestId("result-page")).toBeVisible();
  await expect(page.getByTestId("growth-report")).toHaveCount(0);
});
