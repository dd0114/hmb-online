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

  /**
   * ⚠️ **문구를 리터럴로 박는다** (#403 W4, 목업 ⑥). `toBeTruthy()` 만 있던 동안 이 뱃지가 무엇을
   * 말하는지는 계약 밖이었다 — 그 경기를 열면 다시보기뿐 아니라 **개인 성적·선수 상세**까지
   * 같은 화면에서 나오므로(요구 D) `재생` 만 적으면 화면이 자기가 할 수 있는 일을 안 말한다.
   * testid 는 **바꾸지 않는다**(참조하는 계약이 조용히 아무것도 못 찾게 되는 것을 막는다).
   */
  it("하프 로그 있으면 기록 태그 노출 — 문구는 `▶ 기록`", () => {
    useMatchLogs.mockReturnValue({ data: matchLogs, isLoading: false, isError: false });
    renderPage();
    const tag = screen.getByTestId("match-replay-home-win");
    expect(tag).toBeTruthy();
    expect(tag.textContent?.trim()).toBe("▶ 기록");
  });

  it("하프 로그 없는 경기엔 그 뱃지가 없다 — 열어도 기록이 없는 경기를 기록으로 부르지 않는다", () => {
    // 표본을 **그 축 하나만** 바꿔 만든다(규칙 하나당 표본 하나 — 기존 행은 손대지 않는다).
    const mixed = [matchLogs[0]!, { ...matchLogs[1]!, hasHalves: false }];
    useMatchLogs.mockReturnValue({ data: mixed, isLoading: false, isError: false });
    renderPage();
    // 양성 앵커(위 행)가 같은 화면에 있으므로 이 0 은 "아직 안 그려짐"이 아니다.
    expect(screen.getByTestId("match-replay-home-win")).toBeTruthy();
    expect(screen.queryByTestId("match-replay-away-loss")).toBeNull();
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
