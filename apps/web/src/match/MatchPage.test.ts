// @vitest-environment jsdom
/**
 * Mock-driven state-router render test: each MatchState renders its panel
 * (LLD-web §2). api/hooks is mocked wholesale — this only asserts routing,
 * not data flow (that's the Playwright E2E's job).
 *
 * NOTE: written as .test.ts with createElement (no JSX) because the root vitest
 * include pattern is `apps/**\/*.test.ts` (root config is outside apps/web scope).
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../api/hooks";
import { TokenProvider } from "../auth/TokenContext";

const mockMatch = vi.fn();

vi.mock("../api/hooks", () => {
  const query = (data: unknown = undefined) => ({
    data,
    isLoading: false,
    isError: false,
  });
  const mutation = () => ({
    mutate: vi.fn(),
    mutateAsync: vi.fn(),
    isPending: false,
  });
  return {
    useMe: () =>
      query({
        user: { id: "u1", nickname: "테스터" },
        wallet: { points: 0 },
        records: { wins: 0, draws: 0, losses: 0 },
      }),
    useMatch: () => mockMatch(),
    useDeck: () => query(null),
    usePlayers: () => query([]),
    usePresets: () => query([]),
    useHalfLog: () => query(undefined),
    useMatchResult: () => query(undefined),
    useSubmitMatchPrompt: mutation,
    useUpdateDeck: mutation,
    useKickoff: mutation,
    useResume: mutation,
    useRetry: mutation,
    useHalftime: mutation,
    useCreateMatch: mutation,
  };
});

// BriefingPanel 이 hooks-v2 의 useRelations(AC-C4)·useTeamPresets(W6a 프리셋 칩)를 쓴다 —
// 라우팅 렌더 테스트에선 무데이터로 목.
vi.mock("../api/hooks-v2", () => ({
  useRelations: () => ({ data: undefined, isLoading: false, isError: false }),
  useTeamPresets: () => ({ data: undefined, isLoading: false, isError: false }),
}));

import { MatchPage } from "./MatchPage";

function renderWithState(match: Partial<MatchDetail> | undefined) {
  mockMatch.mockReturnValue({ data: match, isLoading: false, isError: false });
  // MatchPage uses useQueryClient directly (me invalidation on FINISHED) → provider required.
  // ResultPage 는 성장 리포트 훅(useMatchGrowthReport→useToken)을 쓰므로 TokenProvider 도 필요(#179).
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    h(
      QueryClientProvider,
      { client: qc },
      h(
        TokenProvider,
        null,
        h(
          MemoryRouter,
          { initialEntries: ["/match/m1"] },
          h(Routes, null, h(Route, { path: "/match/:id", element: h(MatchPage) })),
        ),
      ),
    ),
  );
}

const base = { id: "m1", createdAt: "2026-07-18T00:00:00Z" };

afterEach(() => {
  cleanup();
  mockMatch.mockReset();
});

describe("MatchPage state router", () => {
  it("BRIEFING → BriefingPanel (with opponent analysis + kickoff)", () => {
    renderWithState({
      ...base,
      state: "BRIEFING",
      opponent: {
        name: "공격 봇",
        analysisText: "공격적인 팀입니다",
        deck: Array.from({ length: 11 }, (_, i) => ({
          name: `봇선수${i}`,
          position: "MF" as const,
          grade: "BRONZE" as const,
          hasPrompt: i % 2 === 0,
        })),
      },
    });
    expect(screen.getByTestId("briefing-panel")).toBeTruthy();
    expect(screen.getByTestId("opponent-analysis").textContent).toContain("공격 봇");
    expect(screen.getByTestId("kickoff-button")).toBeTruthy();
    expect(screen.getByTestId("briefing-timer")).toBeTruthy();
  });

  it("GEN1 → GenWaitPanel with 전반 phase copy", () => {
    renderWithState({ ...base, state: "GEN1" });
    expect(screen.getByTestId("genwait-panel").textContent).toContain("전반 작전 반영 중");
  });

  it("GEN2 → GenWaitPanel with 후반 phase copy", () => {
    renderWithState({ ...base, state: "GEN2" });
    expect(screen.getByTestId("genwait-panel").textContent).toContain("후반 작전 반영 중");
  });

  it("H1_BREAK → h1 score + half-1 viewer + HalftimePanel", () => {
    renderWithState({ ...base, state: "H1_BREAK", scoreH1Home: 2, scoreH1Away: 1 });
    expect(screen.getByTestId("h1-score").textContent).toContain("2 : 1");
    expect(screen.getByTestId("halftime-panel")).toBeTruthy();
    expect(screen.getByTestId("resume-button")).toBeTruthy();
  });

  it("FINISHED → ResultPage (badge from match.result fallback)", () => {
    renderWithState({ ...base, state: "FINISHED", scoreHome: 3, scoreAway: 1, result: "WIN" });
    expect(screen.getByTestId("result-page")).toBeTruthy();
    expect(screen.getByTestId("result-badge").textContent).toBe("승리");
    expect(screen.getByTestId("final-score").textContent).toContain("3 : 1");
  });

  it("FAILED → fail reason + retry button", () => {
    renderWithState({ ...base, state: "FAILED", failReason: "AI 잡 타임아웃" });
    expect(screen.getByTestId("failed-panel")).toBeTruthy();
    expect(screen.getByTestId("fail-reason").textContent).toContain("AI 잡 타임아웃");
    expect(screen.getByTestId("retry-button")).toBeTruthy();
  });

  it("unknown state → visible fallback (schema-growth safe)", () => {
    renderWithState({ ...base, state: "EXTRA_TIME" as never });
    expect(screen.getByTestId("unknown-state").textContent).toContain("EXTRA_TIME");
  });
});
