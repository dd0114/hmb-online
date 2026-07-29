import type { Page } from "@playwright/test";
import { mockAppConfig } from "./app-config-mock";

/**
 * #286 홈/내비 개편 스펙 공용 목 — **백엔드 무접촉**(`page.route`, pathname 매칭).
 *
 * ⚠️ 라우트는 pathname 으로 잡는다 — glob 을 오리진 없이 쓰면 vite 에셋까지 걸려 흰 화면이 된다
 * (apps/web/CLAUDE.md · league-division-mock 선례).
 */
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

export const PLAYERS = Array.from({ length: 24 }, (_, i) => ({
  id: `P${String(i + 1).padStart(3, "0")}`,
  name: `선수 ${i + 1}`,
  position: POSITIONS[i % POSITIONS.length],
  grade: GRADES[i % GRADES.length],
  owned: i < 16,
  ownedCount: i < 16 ? 1 : 0,
  attributes: ATTRS,
}));

export const DECK = {
  formation: "4-3-3",
  slots: [
    ...Array.from({ length: 11 }, (_, i) => ({
      slotIndex: i, playerId: PLAYERS[i].id, role: "starter", promptText: i < 8 ? "밀어붙여" : null,
    })),
    ...Array.from({ length: 5 }, (_, i) => ({
      slotIndex: i, playerId: PLAYERS[11 + i].id, role: "bench", promptText: null,
    })),
  ],
};

export const ME = {
  user: { id: "me", nickname: "감독 박", isAdmin: false, tutorialDone: true },
  wallet: { points: 24300, gems: 1240 },
  records: { wins: 12, draws: 3, losses: 8 },
  rating: 1180,
  league: { division: 5, divisionName: "브론즈 리그" },
};

const TEAM_IDS = ["USER", "T1", "T2", "T3", "T4", "T5", "T6", "T7", "T8", "T9"];
export const LEAGUE = {
  season: {
    id: "S1", seasonNo: 1, state: "ACTIVE",
    division: 5, divisionName: "브론즈 리그", promoteRankMax: 2, relegateRankMin: 9,
    teams: TEAM_IDS.map((t) => ({ teamId: t, name: t === "USER" ? "내 팀" : `봇 ${t}`, isUser: t === "USER" })),
    standings: TEAM_IDS.map((_, i) => ({
      teamId: i === 3 ? "USER" : `T${i + 1}`,
      name: i === 3 ? "내 팀" : `봇 ${i + 1}`,
      played: 9, won: 9 - i, drawn: 0, lost: i,
      goalsFor: 20 - i, goalsAgainst: 6 + i, goalDiff: 14 - 2 * i,
      points: 27 - 3 * i, rank: i + 1, isUser: i === 3,
    })),
    fixtures: [],
    currentRound: 10,
    totalRounds: 18,
  },
  nextMatch: { round: 10, opponentName: "봇 T3" },
};

const AWAY_REPORTS = {
  reports: [],
  summary: { matches: 0, opponents: 0, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, ratingDelta: 0 },
  rating: 1180,
  unseen: 0,
};

export interface MockOpts {
  /** 진행 중 매치. `locked` 는 서버 판정 그대로 넘어간다(클라가 규칙을 복제하지 않는다). */
  active?: { match: { id: string; state: string } | null; locked: boolean; abandonable: boolean };
  /** 트레이드 슬롯 — 홈 [영입] 타일의 카운트 뱃지 근거. */
  openTrades?: number;
}

export async function mockAll(page: Page, opts: MockOpts = {}) {
  const {
    active = { match: null, locked: false, abandonable: false },
    openTrades = 1,
  } = opts;

  const slots = [
    { slot: 1, state: "IDLE", offerKind: null, target: null, demand: null, targetGrade: null, speedupCost: null },
    { slot: 2, state: "WAITING", offerKind: "FA", target: null, demand: null, targetGrade: "DIA", remainingSec: 240, speedupCost: 300 },
    {
      slot: 3, state: openTrades > 0 ? "OPEN" : "IDLE", offerKind: "TRADE",
      target: { playerId: "P020", name: "대가 플레이메이커", position: "MF", grade: "GOLD" },
      demand: { playerId: "P010", name: "내 센터백", position: "DF", grade: "SILVER" },
      acceptProbability: 0.8, targetGrade: "GOLD",
    },
  ];

  const routes: Array<[string, unknown]> = [
    ["/api/me", ME],
    ["/api/me/active-match", active],
    ["/api/me/away-reports", AWAY_REPORTS],
    ["/api/relations", { morale: 62, streak: 1, players: [] }],
    ["/api/players", PLAYERS],
    ["/api/deck", DECK],
    ["/api/presets", []],
    ["/api/presets/team", [1, 2, 3].map((slot) => ({ slot, name: null, snapshot: null }))],
    ["/api/league", LEAGUE],
    ["/api/trade", { wallet: { points: 24300 }, slots }],
    ["/api/rankings", { leaderboard: [], me: null, personalRecords: null }],
    ["/api/logs/trades", []],
    ["/api/conditions/today", { players: [] }],
    ["/api/notices", { notices: [] }],
    ["/api/notices/active", { notices: [] }],
  ];

  // 캐치올 먼저 — 나중에 등록한 핸들러가 이긴다.
  await page.route((url) => url.pathname.startsWith("/api/"), (r) => r.fulfill(json({})));
  await page.route((url) => url.pathname.startsWith("/api/logs/matches"), (r) => r.fulfill(json([])));
  for (const [path, body] of routes) {
    await page.route((url) => url.pathname === path, (r) => r.fulfill(json(body)));
  }
  await mockAppConfig(page);

  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
}
