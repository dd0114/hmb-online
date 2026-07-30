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

/**
 * `GET /api/growth/card/{id}` — 강화 시트가 요구하는 최소 형태.
 *
 * ⚠️ 캐치올 `{}` 로 두면 시트가 **열리지도 않는다**(내부에서 필드를 만지다 죽는다) — 그러면
 * "강화 진입" 계약이 진입 실패를 구현 실패로 오인해 통과/실패가 뒤섞인다. 서버 형상에 맞춘다.
 */
const ATTR_KEYS = Object.keys(ATTRS) as Array<keyof typeof ATTRS>;
export function growthCardPayload(playerId: string, grade = "GOLD") {
  const caps = Object.fromEntries(ATTR_KEYS.map((k) => [k, Math.min(99, ATTRS[k] + 15)]));
  return {
    playerId,
    grade,
    star: 1,
    attributes: { ...ATTRS },
    prePotential: { ...ATTRS },
    base: { ...ATTRS },
    caps,
    statLevels: Object.fromEntries(ATTR_KEYS.map((k) => [k, { level: 1, xp: 0, xpToNext: 100 }])),
    potential: { unlocked: false, tier: "RARE", maxTier: "EPIC", lines: [], rollsSinceTierUp: 0, ceilingAt: 9 },
    ovr: 58,
    completion: 0.3,
  };
}

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
  /** 미확인 피원정 리포트 수 — 홈 알림 한 줄의 나머지 절반. */
  unseenAwayReports?: number;
  /**
   * 덱 유무 (#286 W3.5). `"missing"` = `GET /api/deck` **404** — 서버가 새 유저·미지급 계정에
   * 실제로 주는 응답이고, `useDeck` 이 그걸 `null` 로 정규화한다.
   */
  deck?: "present" | "missing";
  /** 보유 카드 수 (#286 W3.5). 11 미만이면 자동완성으로도 덱을 못 채운다 = 영입 분기. */
  ownedCount?: number;
  /**
   * `POST /api/matches` 실패 주입 (#286 W3.5 L3) — 클라 가드를 통과한 뒤 서버가 거부하는 경합.
   * `"deck-required"` = W4 가 붙일 전용 코드 / `"legacy-404"` = 지금 서버의 뭉뚱그린 404.
   */
  createMatchError?: "deck-required" | "legacy-404";
}

export async function mockAll(page: Page, opts: MockOpts = {}) {
  const {
    active = { match: null, locked: false, abandonable: false },
    openTrades = 1,
    unseenAwayReports = 0,
    deck = "present",
    ownedCount = 16,
    createMatchError,
  } = opts;

  const roster = PLAYERS.map((p, i) => ({
    ...p,
    owned: i < ownedCount,
    ownedCount: i < ownedCount ? 1 : 0,
  }));

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
    ["/api/me/away-reports", { ...AWAY_REPORTS, unseen: unseenAwayReports }],
    ["/api/relations", { morale: 62, streak: 1, players: [] }],
    ["/api/players", roster],
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
  // 강화 카드는 id 별 경로라 패턴으로 잡는다(#286 W3 강화 진입 계약).
  await page.route(
    (url) => url.pathname.startsWith("/api/growth/card/"),
    (r) => {
      const id = r.request().url().split("/api/growth/card/")[1]?.split("?")[0] ?? "P001";
      const grade = PLAYERS.find((p) => p.id === id)?.grade ?? "GOLD";
      return r.fulfill(json(growthCardPayload(id, grade)));
    },
  );
  await page.route((url) => url.pathname.startsWith("/api/logs/matches"), (r) => r.fulfill(json([])));
  for (const [path, body] of routes) {
    await page.route((url) => url.pathname === path, (r) => r.fulfill(json(body)));
  }

  /**
   * 덱 — 404 를 **캐치올보다 뒤에** 등록해야 이긴다. `{}` 로 대신하면 안 된다:
   * `useDeck` 은 404 만 `null`(=덱 없음)로 정규화하고 `{}` 는 "덱이 있다"로 읽는다.
   *
   * ⚠️ **저장이 상태를 바꾼다** — `PUT` 을 받으면 그 뒤의 `GET` 은 덱을 돌려줘야 한다.
   * 고정 404 로 두면 "덱을 만들었는데 여전히 없다"는, 서버엔 존재하지 않는 상태를 만들고
   * 계약이 그 허구를 검사하게 된다(실제로 이 목의 첫 판이 그랬다).
   */
  let deckExists = deck !== "missing";
  await page.route(
    (url) => url.pathname === "/api/deck",
    (r) => {
      if (r.request().method() === "PUT") {
        deckExists = true;
        return r.fulfill(json(DECK));
      }
      return deckExists
        ? r.fulfill(json(DECK))
        : r.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404));
    },
  );

  // 매치 생성 — 실패 주입이 없으면 평소대로 만들어 준다(GET 은 캐치올이 받는다).
  await page.route(
    (url) => url.pathname === "/api/matches",
    (r) => {
      if (r.request().method() !== "POST") return r.fulfill(json({}));
      if (createMatchError === "deck-required") {
        return r.fulfill(json({ code: "DECK_REQUIRED", message: "활성 덱이 없습니다" }, 400));
      }
      if (createMatchError === "legacy-404") {
        return r.fulfill(json({ code: "NOT_FOUND", message: "활성 덱이 없습니다" }, 404));
      }
      return r.fulfill(json({ id: "M1", state: "BRIEFING" }));
    },
  );

  await mockAppConfig(page);

  await page.addInitScript(() => {
    window.localStorage.setItem("hmb.auth.token", "tok");
    window.localStorage.setItem("hmb.auth.provider", "guest");
    window.localStorage.setItem("hmb.tutorial.done", "1");
  });
}
