import { expect, test, type Page } from "@playwright/test";
import { mkdirSync } from "node:fs";
import { mockAppConfig } from "./app-config-mock";

/**
 * #232 W1 — 재화 표기 전수 조사용 **캡처 전용** 스펙(계약 아님, 커밋 대상 아님).
 * 백엔드 없이 page.route 로 /api 를 목킹해 재화 표기가 나오는 화면을 실제로 그려 찍는다.
 * 라우트 매칭은 pathname 앵커(글롭 '**\/api/**' 는 vite 소스 /src/api/*.ts 까지 잡아 흰 화면).
 */

const OUT = process.env.CURRENCY_SHOT_DIR ?? "/tmp/currency-shots";
const json = (body: unknown) => ({ status: 200, contentType: "application/json", body: JSON.stringify(body) });

const ME = {
  user: { id: "U1", nickname: "테스터", provider: "guest", isAdmin: true, tutorialDone: true },
  wallet: { points: 62_000, gems: 6_000 },
  records: { played: 12, wins: 7, draws: 2, losses: 3 },
};

const attrs = {
  technical: 74, mental: 68, physical: 80, passing: 71, shooting: 85,
  tackling: 55, pace: 82, stamina: 70, positioning: 77,
};
const PLAYERS = [
  { id: "P010", name: "내 센터백", position: "DF", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs, personality: "CALM" },
  { id: "P011", name: "내 윙어", position: "FW", grade: "GOLD", owned: true, ownedCount: 3, attributes: attrs, personality: "FIERY" },
  { id: "P042", name: "FA 스트라이커", position: "FW", grade: "DIA", owned: false, ownedCount: 0, attributes: attrs, personality: "AMBITIOUS" },
];

const TRADE = {
  wallet: { points: 62_000 },
  slots: [
    { slot: 1, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null, speedupCost: null },
    { slot: 2, state: "WAITING", offerKind: "FA", target: null, demand: null, targetGrade: "GOLD", opensAt: "2026-07-28T12:00:00Z", remainingSec: 3_600, speedupCost: 500 },
    { slot: 3, state: "OPEN", offerKind: "TRADE", target: { playerId: "P077", name: "대가 플레이메이커", position: "MF", grade: "GOLD" }, demand: { playerId: "P010", name: "내 센터백", position: "DF", grade: "SILVER" }, acceptProbability: 0.8, targetGrade: "GOLD" },
  ],
};

function standings() {
  const bots = [2, 3, 4, 5, 6, 7, 8, 9, 10].map((rank, i) => ({
    teamId: `bot${i + 1}`, name: `봇 FC ${i + 1}`, played: 18, won: 12 - i, drawn: 3, lost: 3 + i,
    goalsFor: 40 - i * 2, goalsAgainst: 20 + i, goalDiff: 20 - i * 3, points: 39 - i * 3, rank, isUser: false,
  }));
  return [...bots, { teamId: "me", name: "내 팀", played: 18, won: 14, drawn: 2, lost: 2, goalsFor: 45, goalsAgainst: 15, goalDiff: 30, points: 44, rank: 1, isUser: true }];
}

const LEAGUE = {
  season: {
    id: "S1", seasonNo: 1, state: "FINISHED",
    teams: [{ teamId: "me", name: "내 팀", isUser: true, persona: null, power: null }],
    standings: standings(), fixtures: [], nextUserFixture: null,
    seasonReward: { rank: 1, points: 100_000, gems: 2_400, status: "AWARDED", awardedAt: "2026-07-28T09:00:00Z" },
  },
};

const LOGS_MATCHES = {
  items: [
    {
      id: "m1", kind: "MATCH", at: "2026-07-28T08:00:00Z", title: "리그 3R",
      detail: { opponent: "봇 FC 1", scoreHome: 2, scoreAway: 1, result: "WIN", points: 5_000, mode: "LEAGUE", round: 3 },
    },
  ],
  nextCursor: null,
};

const ADMIN_USERS = {
  items: [{ id: "U1", nickname: "테스터", authProvider: "guest", isAdmin: true, points: 62_000, createdAt: "2026-07-01T00:00:00Z" }],
  nextCursor: null,
};
const ADMIN_DETAIL = {
  user: { id: "U1", nickname: "테스터", authProvider: "guest", isAdmin: true, points: 62_000, createdAt: "2026-07-01T00:00:00Z" },
  owned: [], deck: null, records: { played: 12, wins: 7, draws: 2, losses: 3 }, recentMatches: [],
};

async function mockApi(page: Page) {
  await page.route((u) => u.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  const at = async (path: string, body: unknown) =>
    page.route((u) => u.pathname === path, (r) => r.fulfill(json(body)));
  await at("/api/me", ME);
  await at("/api/players", PLAYERS);
  await at("/api/trade", TRADE);
  await at("/api/league", LEAGUE);
  await at("/api/logs/matches", LOGS_MATCHES);
  await at("/api/logs/trades", { items: [], nextCursor: null });
  await at("/api/growth/dice", { normal: 4, cash: 2 });
  await at("/api/me/active-match", { match: null, locked: false, abandonable: false });
  await at("/api/admin/users", ADMIN_USERS);
  await at("/api/admin/users/U1", ADMIN_DETAIL);
  await at("/api/deck", { slots: [], bench: [], formation: "4-3-3" });
  // #232 이후: 표기·가격은 서버 config 에서 온다 — 목이 없으면 코드 폴백 화면을 찍게 된다.
  await mockAppConfig(page);
}

async function boot(page: Page, path: string) {
  await mockApi(page);
  await page.addInitScript(() => {
    localStorage.setItem("hmb.auth.token", "mock-token");
    localStorage.setItem("hmb.auth.provider", "guest");
    localStorage.setItem("hmb.tutorial.done", "1");
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(path);
}

const shot = (page: Page, name: string) =>
  page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true });

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test("capture: 상점 탭", async ({ page }) => {
  await boot(page, "/shop");
  await expect(page.getByTestId("gacha-single")).toBeVisible();
  await shot(page, "01-shop-gacha");
  await page.getByTestId("shop-tab-dice").click();
  await expect(page.getByTestId("dice-cash-price")).toBeVisible();
  await shot(page, "02-shop-dice");
});

test("capture: 로비", async ({ page }) => {
  await boot(page, "/lobby");
  await expect(page.getByTestId("points-badge")).toBeVisible();
  await shot(page, "04-lobby");
});

test("capture: 트레이드", async ({ page }) => {
  await boot(page, "/trade");
  await page.waitForTimeout(1_200);
  await shot(page, "05-trade");
});

test("capture: 리그 시즌 보상", async ({ page }) => {
  await boot(page, "/league");
  await page.waitForTimeout(1_500);
  await shot(page, "06-league-reward");
});

test("capture: 로그", async ({ page }) => {
  await boot(page, "/logs");
  await page.waitForTimeout(1_200);
  await shot(page, "07-logs");
});

test("capture: 도감 성장 상세", async ({ page }) => {
  await boot(page, "/codex");
  await page.waitForTimeout(1_500);
  await shot(page, "08-codex");
});

test("capture: admin", async ({ page }) => {
  await boot(page, "/admin");
  await page.waitForTimeout(1_500);
  await shot(page, "09-admin");
});
