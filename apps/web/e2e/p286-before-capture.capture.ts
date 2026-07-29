import { test } from "@playwright/test";
import { mkdirSync } from "node:fs";

/**
 * #286 W1 UI 보드 — **현행(BEFORE) 실화면 캡처**.
 *
 * 목업이 아니라 **지금 코드가 그리는 화면**을 찍는다. hero 가 개편안(AFTER 목업) 옆에
 * 나란히 두고 "무엇이 어떻게 달라지나"를 눈으로 보게 하는 용도다.
 * 판정용이 아니다(루트 §2-2: 판정은 독립 QA) — 컨펌 근거 자료다.
 *
 * 실행:
 *   cd apps/web && CI=1 WEB_E2E_PORT=5287 npx playwright test --config=playwright.capture.config.ts
 * 산출:
 *   docs/plan-v5/mock/home-nav/before/*.png (보드가 직접 참조)
 *
 * ⚠️ 백엔드 무접촉 — `/api` 전면 목킹(pathname 매칭, glob 금지). 대체 포트로 :8080 데모와 격리.
 */

const OUT = new URL("../../../docs/plan-v5/mock/home-nav/before/", import.meta.url).pathname;

const json = (body: unknown, status = 200) => ({
  status,
  contentType: "application/json",
  body: JSON.stringify(body),
});

const ATTRS = {
  technical: 74, mental: 68, physical: 80, passing: 71, shooting: 85,
  tackling: 55, pace: 82, stamina: 70, positioning: 77,
};

const GRADES = ["LEGEND", "DIA", "GOLD", "SILVER", "BRONZE"] as const;
const POSITIONS = ["GK", "DF", "DF", "DF", "DF", "MF", "MF", "MF", "FW", "FW", "FW"] as const;

/** 카탈로그 40명 — 앞 18명 보유(도감의 보유/미보유 대비가 보이게). */
const PLAYERS = Array.from({ length: 40 }, (_, i) => ({
  id: `P${String(i + 1).padStart(3, "0")}`,
  name: `선수 ${i + 1}`,
  position: POSITIONS[i % POSITIONS.length],
  grade: GRADES[i % GRADES.length],
  owned: i < 18,
  ownedCount: i < 18 ? 1 : 0,
  attributes: ATTRS,
  condition: 80 + (i % 20),
}));

const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({
      slotIndex: i, playerId: PLAYERS[i].id, role: "starter", prompt: "",
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      slotIndex: i, playerId: PLAYERS[11 + i].id, role: "bench", prompt: "",
    })),
  ],
};

const ME = {
  user: { id: "me", nickname: "감독 박", isAdmin: false, tutorialDone: true },
  wallet: { points: 24300, gems: 1240 },
  records: { wins: 12, draws: 3, losses: 8 },
  rating: 1180,
  league: { division: 5, divisionName: "브론즈 리그" },
};

const TEAM_IDS = ["USER", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"];
const LEAGUE = {
  season: {
    id: "S1", seasonNo: 1, state: "ACTIVE",
    division: 5, divisionName: "브론즈 리그", promoteRankMax: 2, relegateRankMin: 9,
    teams: TEAM_IDS.map((t) => ({ teamId: t, name: t === "USER" ? "내 팀" : `봇 ${t}`, isUser: t === "USER" })),
    standings: TEAM_IDS.map((_, i) => {
      const rank = i + 1;
      const isUser = rank === 4;
      return {
        teamId: isUser ? "USER" : `T${rank}`,
        name: isUser ? "내 팀" : `봇 ${rank}`,
        played: 9, won: 9 - i, drawn: 0, lost: i,
        goalsFor: 20 - i, goalsAgainst: 6 + i, goalDiff: 14 - 2 * i,
        points: 27 - 3 * i, rank, isUser,
      };
    }),
    fixtures: Array.from({ length: 6 }, (_, i) => ({
      id: `F${i}`, round: i + 8,
      homeTeam: i % 2 === 0 ? "USER" : `T${i + 1}`,
      awayTeam: i % 2 === 0 ? `T${i + 1}` : "USER",
      isUser: true,
      state: i < 2 ? "PLAYED" : "SCHEDULED",
      scoreHome: i < 2 ? 2 : null,
      scoreAway: i < 2 ? 1 : null,
    })),
    currentRound: 10,
    totalRounds: 18,
  },
  nextMatch: { round: 10, opponentName: "봇 T3" },
};

const TRADE = {
  wallet: { points: 24300 },
  slots: [
    { slot: 1, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null, speedupCost: null },
    {
      slot: 2, state: "WAITING", offerKind: "FA", target: null, demand: null,
      targetGrade: "DIA", opensAt: "2026-07-29T12:00:00Z", remainingSec: 240, speedupCost: 300,
    },
    {
      slot: 3, state: "OPEN", offerKind: "TRADE",
      target: { playerId: "P077", name: "대가 플레이메이커", position: "MF", grade: "GOLD" },
      demand: { playerId: "P010", name: "내 센터백", position: "DF", grade: "SILVER" },
      acceptProbability: 0.8, targetGrade: "GOLD",
    },
  ],
};

const MATCH_LOGS = Array.from({ length: 8 }, (_, i) => ({
  id: `M${i}`,
  mode: i % 3 === 0 ? "away" : i % 2 === 0 ? "league" : "practice",
  opponentName: i % 3 === 0 ? "FC 한밤중" : `봇 ${i}`,
  result: (["WIN", "LOSS", "DRAW"] as const)[i % 3],
  scoreHome: 2, scoreAway: 1, userWasHome: i % 2 === 0,
  seasonNo: 1, round: 9 - i, hasHalves: true,
  createdAt: `2026-07-2${(i % 8) + 1}T10:00:00Z`,
}));

const RANKINGS = {
  leaderboard: Array.from({ length: 8 }, (_, i) => ({
    userId: i === 3 ? "me" : `u${i}`,
    nickname: i === 3 ? "감독 박" : `감독 ${i + 1}`,
    wins: 20 - i * 2,
    winRate: 0.8 - i * 0.05,
    rank: i + 1,
  })),
  me: { userId: "me", nickname: "감독 박", wins: 14, winRate: 0.65, rank: 4 },
  personalRecords: {
    topScorer: { playerId: "P001", name: "선수 1", position: "GK", grade: "LEGEND" },
    topScorerGoals: 9,
    longestWinStreak: 4,
    totalMatches: 23,
  },
};

const AWAY_REPORTS = {
  reports: [
    { id: "R1", matchId: "AM1", attackerName: "FC 한밤중", goalsFor: 1, goalsAgainst: 3, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-29T03:12:00Z", seen: false },
    { id: "R2", matchId: "AM2", attackerName: "언더독 유나이티드", goalsFor: 2, goalsAgainst: 0, result: "WIN", ratingDelta: 10, createdAt: "2026-07-29T01:40:00Z", seen: false },
    { id: "R3", matchId: "AM3", attackerName: "레드 스톰 CF", goalsFor: 1, goalsAgainst: 4, result: "LOSS", ratingDelta: -10, createdAt: "2026-07-28T23:05:00Z", seen: false },
  ],
  summary: { matches: 3, opponents: 3, wins: 1, draws: 0, losses: 2, goalsFor: 4, goalsAgainst: 7, ratingDelta: -10 },
  rating: 1180,
  unseen: 3,
};

const APP_CONFIG = {
  currencies: [
    { code: "POINT", symbol: "G", name: "골드", icon: "●", position: "suffix", separator: " " },
    { code: "GEM", symbol: "Z", name: "다이아", icon: "💎", position: "suffix", separator: " " },
  ],
  shop: {
    gacha: { single: { currency: "GEM", cost: 300 }, ten: { currency: "GEM", cost: 3000 }, tenCount: 11 },
    dice: { normal: { currency: "POINT", cost: 5000 }, cash: { currency: "GEM", cost: 10 } },
    gemTopup: { enabled: false, packs: [] },
  },
  grants: { initialPoints: 3000, initialGems: 6000 },
};

/** 라우트는 **pathname** 으로 잡는다 — glob 을 오리진 없이 쓰면 vite 에셋까지 걸려 흰 화면이 된다. */
async function mockAll(page: import("@playwright/test").Page) {
  const routes: Array<[string, unknown, number?]> = [
    ["/api/config", APP_CONFIG],
    ["/api/me", ME],
    ["/api/me/active-match", { match: null, locked: false, abandonable: false }],
    ["/api/me/away-reports", AWAY_REPORTS],
    ["/api/relations", { morale: 62, streak: 1, players: [] }],
    ["/api/players", PLAYERS],
    ["/api/deck", DECK],
    ["/api/presets", []],
    ["/api/presets/team", [
      { slot: 1, name: "기본 4-3-3", snapshot: {} },
      { slot: 2, name: null, snapshot: null },
      { slot: 3, name: null, snapshot: null },
    ]],
    ["/api/league", LEAGUE],
    ["/api/trade", TRADE],
    ["/api/rankings", RANKINGS],
    ["/api/logs/trades", []],
    ["/api/conditions/today", { players: [] }],
    ["/api/notices", { notices: [] }],
    ["/api/notices/active", { notices: [] }],
    ["/api/away/season", { seasonNo: 3, startedAt: "2026-07-27T00:00:00Z", endsAt: "2026-08-03T00:00:00Z", streak: 2, rating: 1180, rank: 12 }],
    ["/api/away/candidates", {
      candidates: [
        { userId: "o1", nickname: "FC 한밤중", rating: 1210 },
        { userId: "o2", nickname: "레드 스톰 CF", rating: 1155 },
      ],
      streak: 2,
      remainingToday: 4,
    }],
  ];

  // 캐치올 먼저 — 나중에 등록한 핸들러가 이긴다.
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname.startsWith("/api/logs/matches"), (r) => r.fulfill(json(MATCH_LOGS)));
  for (const [path, body, status] of routes) {
    await page.route((url) => url.pathname === path, (r) => r.fulfill(json(body, status)));
  }
  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
}

test.beforeAll(() => mkdirSync(OUT, { recursive: true }));

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockAll(page);
});

/**
 * 화면 전체를 한 장에 — 단, `fullPage` 를 쓰지 않는다.
 *
 * ⚠️ 하단 탭바는 `position:fixed` 라 `fullPage:true` 로 찍으면 **문서 중간**(첫 뷰포트 바닥)에
 * 박제돼 긴 화면(도감 2247px)에서 내비가 콘텐츠를 가로지른다 — 보드에서 그걸 보면 hero 가
 * 없는 버그를 본다. 대신 **뷰포트를 콘텐츠 높이만큼 늘려** 한 장으로 찍는다: 그러면 고정 내비가
 * 이미지 맨 아래에 정상으로 앉는다.
 */
async function shot(page: import("@playwright/test").Page, name: string) {
  await page.waitForTimeout(500);
  const h = await page.evaluate(() =>
    Math.max(document.documentElement.scrollHeight, document.body.scrollHeight, 844),
  );
  await page.setViewportSize({ width: 390, height: Math.min(h, 3200) });
  await page.waitForTimeout(250);
  await page.screenshot({ path: `${OUT}${name}.png` });
  await page.setViewportSize({ width: 390, height: 844 });
}

test("before: 홈(로비)", async ({ page }) => {
  await page.goto("/lobby");
  await page.getByTestId("play-cta").waitFor();
  await shot(page, "01-lobby");
});

test("before: 게임 시작 → 모드 선택 모달", async ({ page }) => {
  await page.goto("/lobby");
  await page.getByTestId("play-cta").click();
  // #245: 미확인 원정 리포트가 있으면 팝업이 먼저 뜬다 — 그것도 현행 화면이라 같이 찍는다.
  await page.getByTestId("away-report-modal").waitFor();
  await shot(page, "02-away-report-popup");
  await page.getByTestId("away-report-confirm").click();
  await page.getByTestId("mode-away").waitFor();
  await shot(page, "03-mode-modal");
  await page.getByTestId("mode-away").click();
  await page.waitForTimeout(600);
  await shot(page, "04-away-candidates");
});

test("before: 덱", async ({ page }) => {
  await page.goto("/deck");
  await page.waitForTimeout(1200);
  await shot(page, "05-deck");
});

test("before: 육성", async ({ page }) => {
  await page.goto("/growth");
  await page.getByTestId("growth-owned-total").waitFor();
  await shot(page, "06-growth");
});

test("before: 도감", async ({ page }) => {
  await page.goto("/codex");
  await page.getByTestId("codex-owned-total").waitFor();
  await shot(page, "07-codex");
});

test("before: 상점(뽑기)", async ({ page }) => {
  await page.goto("/shop");
  await page.getByTestId("shop-tab-gacha").waitFor();
  await shot(page, "08-shop");
});

test("before: 트레이드", async ({ page }) => {
  await page.goto("/trade");
  await page.waitForTimeout(1000);
  await shot(page, "09-trade");
});

test("before: 로그(경기/랭킹)", async ({ page }) => {
  await page.goto("/logs");
  await page.waitForTimeout(900);
  await shot(page, "10-logs-matches");
  await page.getByRole("tab", { name: "랭킹" }).click();
  await page.waitForTimeout(500);
  await shot(page, "11-logs-rankings");
});

test("before: 리그", async ({ page }) => {
  await page.goto("/league");
  await page.waitForTimeout(1000);
  await shot(page, "12-league");
});

test("before: 하단 탭바 (내비 7개)", async ({ page }) => {
  await page.goto("/lobby");
  await page.getByTestId("nav-bottom").waitFor();
  await page.getByTestId("nav-bottom").screenshot({ path: `${OUT}00-nav-bottom.png` });
});
