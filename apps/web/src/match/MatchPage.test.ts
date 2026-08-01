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
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../api/hooks";
import { TokenProvider } from "../auth/TokenContext";
import { WAITING_SCENE_LINES } from "./waiting-scenes";

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
    useSetAuto: mutation, // #249 오토 토글
    useResume: mutation,
    useRetry: mutation,
    useHalftime: mutation,
    useCreateMatch: mutation,
    useAbandonMatch: mutation, // #217 — FAILED 패널의 포기 버튼
    useActiveMatch: () => query(undefined),
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
    // #244: 상대 정보는 시트 뒤. #285: 그 진입점이 **팀시트 전력 줄** 안으로 옮겨왔다.
    expect(screen.getByTestId("opp-sheet-open")).toBeTruthy();
    expect(
      screen.getByTestId("sheet-power").contains(screen.getByTestId("opp-sheet-open")),
      "진입점이 상대 이름·전력이 있는 줄 안에 있다(별도 상단 줄로 되돌아가지 않는다)",
    ).toBe(true);
    fireEvent.click(screen.getByTestId("opp-sheet-open"));
    expect(screen.getByTestId("opponent-analysis").textContent).toContain("공격 봇");
    expect(screen.getByTestId("kickoff-button")).toBeTruthy();
    /*
     * 🪦 은퇴 — `briefing-timer`. 클라 로컬 180초 카운트다운이라 새로고침에 리셋되고 만료해도
     * 아무 일도 없었다(#285, hero "불필요"). PRD-v2 D5 의 "표시만" 이 이 형태로 굳은 것 —
     * 되살리려면 서버 권위 마감부터다. 지금 화면에 없다는 것 자체를 계약으로 못 박는다.
     */
    expect(screen.queryByTestId("briefing-timer")).toBeNull();
  });

  // #382 — 서술은 축구장 정경 로테이션이다. 라우팅 테스트는 "그 자리에 정경 문장이 있다"까지만
  // 보고, 로테이션 동작 자체는 GenWaitPanel.test.ts(가짜 타이머)가 태운다.
  it("GEN1 → GenWaitPanel with 전반 phase copy + 정경 문구", () => {
    renderWithState({ ...base, state: "GEN1" });
    expect(screen.getByTestId("genwait-panel").textContent).toContain("전반");
    const scene = screen.getByTestId("genwait-scene").textContent ?? "";
    expect(WAITING_SCENE_LINES).toContain(scene);
    // 🪦 은퇴한 서술형(#193 "10초 안팎"·구 "70초 × 양팀") — hero 가 걷어냈다(#382).
    const panel = screen.getByTestId("genwait-panel").textContent ?? "";
    expect(panel).not.toContain("10초");
    expect(panel).not.toContain("70초");
    expect(panel).not.toContain("작전 반영");
  });

  it("GEN2 → GenWaitPanel with 후반 phase copy + 정경 문구", () => {
    renderWithState({ ...base, state: "GEN2" });
    expect(screen.getByTestId("genwait-panel").textContent).toContain("후반");
    expect(WAITING_SCENE_LINES).toContain(screen.getByTestId("genwait-scene").textContent ?? "");
  });

  // 감독시간 상태명은 **둘**이다 — 현행 `HALFTIME`(P4-E2 #170)과 레거시 `H1_BREAK`.
  // 여기가 `H1_BREAK` 하나로만 열려 있어서 #226(감독시간 헤더가 재생을 따라감)이 배포까지 갔다.
  // 새 감독시간 규칙을 넣을 때는 반드시 **두 이름 다** 태워라.
  it.each(["HALFTIME", "H1_BREAK"] as const)("%s → h1 score + half-1 viewer + HalftimePanel", (state) => {
    renderWithState({ ...base, state, scoreH1Home: 2, scoreH1Away: 1 });
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
    // #217 AC3: 재시도가 계속 실패하는 매치가 곧 계정 잠금이 되지 않게, 이 화면에 탈출구가 있어야 한다.
    expect(screen.getByTestId("abandon-button")).toBeTruthy();
  });

  it("ABANDONED → 회수 안내 + 로비 복귀 (알 수 없는 상태로 떨어지지 않는다, #217)", () => {
    renderWithState({ ...base, state: "ABANDONED" as never });
    expect(screen.getByTestId("abandoned-panel")).toBeTruthy();
    expect(screen.getByTestId("abandoned-to-lobby")).toBeTruthy();
    expect(screen.queryByTestId("unknown-state")).toBeNull();
  });

  it("unknown state → visible fallback (schema-growth safe)", () => {
    renderWithState({ ...base, state: "EXTRA_TIME" as never });
    expect(screen.getByTestId("unknown-state").textContent).toContain("EXTRA_TIME");
  });
});
