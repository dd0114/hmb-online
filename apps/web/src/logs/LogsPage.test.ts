// @vitest-environment jsdom
/**
 * W4 로그 탭 렌더 스모크(AC-E) — 라이브 스택 없이 jsdom 에서 LogsPage 를 실제로 렌더해
 * (1) 경기 로그의 **유저 관점 오리엔트 스코어**가 DOM 에 찍히는지(어웨이 flip 실측),
 * (2) 리더보드 내 순위 하이라이트, (3) 개인 기록 카탈로그 조인을 본다. 훅은 wholesale mock.
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchLogItem, RankingsResponse } from "../api/v2";
import type { CatalogPlayer } from "../api/hooks";

const matchLogs: MatchLogItem[] = [
  // 유저 홈 승리: 원값 홈2:어웨이1 → 표시 "2 : 1"
  {
    id: "home-win",
    mode: "league",
    opponentName: "봇A",
    result: "WIN",
    scoreHome: 2,
    scoreAway: 1,
    userWasHome: true,
    seasonNo: 1,
    round: 3,
    hasHalves: true,
    createdAt: "2026-07-19T10:00:00Z",
  },
  // 유저 어웨이 패배: 원값 홈3:어웨이1 → 유저 관점 "1 : 3" (flip 실측 핵심)
  {
    id: "away-loss",
    mode: "league",
    opponentName: "봇B",
    result: "LOSS",
    scoreHome: 3,
    scoreAway: 1,
    userWasHome: false,
    seasonNo: 1,
    round: 4,
    hasHalves: true,
    createdAt: "2026-07-19T12:00:00Z",
  },
];

const rankings: RankingsResponse = {
  leaderboard: [
    { userId: "u1", nickname: "1등", wins: 10, winRate: 0.8, rank: 1 },
    { userId: "me", nickname: "나", wins: 5, winRate: 0.5, rank: 2 },
  ],
  me: { userId: "me", nickname: "나", wins: 5, winRate: 0.5, rank: 2 },
  personalRecords: {
    topScorer: { playerId: "p9", name: "폴백이름", position: "FW", grade: "GOLD" },
    topScorerGoals: 7,
    longestWinStreak: 3,
    totalMatches: 20,
  },
};

const players: CatalogPlayer[] = [
  {
    id: "p9",
    name: "조인된스트라이커",
    position: "FW",
    grade: "DIA",
    owned: true,
    ownedCount: 1,
    attributes: {
      technical: 80, mental: 80, physical: 80, passing: 80, shooting: 90,
      tackling: 50, pace: 85, stamina: 80, positioning: 88,
    },
  },
];

const useMatchLogs = vi.fn();
const useTradeLogs = vi.fn(() => ({ data: [], isLoading: false, isError: false }));
const useRankings = vi.fn(() => ({ data: rankings, isLoading: false, isError: false }));
const usePlayers = vi.fn(() => ({ data: players }));

vi.mock("../api/hooks-v2", () => ({
  useMatchLogs: (...a: unknown[]) => useMatchLogs(...a),
  useTradeLogs: () => useTradeLogs(),
  useRankings: () => useRankings(),
}));
vi.mock("../api/hooks", () => ({
  usePlayers: () => usePlayers(),
}));

import { LogsPage } from "./LogsPage";

function renderPage() {
  return render(h(MemoryRouter, { initialEntries: ["/logs"] }, h(LogsPage)));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("LogsPage 경기 탭 — 유저 관점 오리엔트 실측", () => {
  it("어웨이 패배 행은 픽스처 원값(3:1)이 아니라 유저 관점(1:3)으로 표시", () => {
    useMatchLogs.mockReturnValue({ data: matchLogs, isLoading: false, isError: false });
    renderPage();
    expect(screen.getByTestId("match-score-home-win").textContent).toBe("2 : 1");
    // 원값 홈3:어웨이1 이지만 유저가 어웨이였으므로 내 스코어 먼저 = "1 : 3"
    expect(screen.getByTestId("match-score-away-loss").textContent).toBe("1 : 3");
    expect(screen.getByTestId("match-log-away-loss").getAttribute("data-user-was-home")).toBe("false");
    expect(screen.getByTestId("match-result-away-loss").textContent).toBe("패");
  });

  it("하프 로그 있으면 재생 태그 노출", () => {
    useMatchLogs.mockReturnValue({ data: matchLogs, isLoading: false, isError: false });
    renderPage();
    expect(screen.getByTestId("match-replay-home-win")).toBeTruthy();
  });
});

describe("LogsPage 랭킹 탭 — 하이라이트 + 카탈로그 조인", () => {
  it("내 순위 행 하이라이트 + 최다 득점 선수는 카탈로그 이름으로 조인", () => {
    useMatchLogs.mockReturnValue({ data: [], isLoading: false, isError: false });
    renderPage();
    // 랭킹 탭으로 전환
    fireEvent.click(screen.getByTestId("logs-tab-rankings"));
    expect(screen.getByTestId("lb-me").getAttribute("data-me")).toBe("true");
    const scorer = screen.getByTestId("top-scorer");
    // PlayerRef.name='폴백이름' 이지만 카탈로그 조인으로 '조인된스트라이커' 표시
    expect(within(scorer).getByText("조인된스트라이커")).toBeTruthy();
    expect(within(scorer).getByText("7골")).toBeTruthy();
  });
});
