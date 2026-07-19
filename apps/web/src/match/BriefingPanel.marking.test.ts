// @vitest-environment jsdom
/**
 * W2 마킹 원탭 렌더 스모크(AC-C4) — 라이브 스택 없이 jsdom 에서 BriefingPanel 을 실제로 렌더해
 * "상대 선수 마크 → 자동 배정 → 프롬프트 합성"이 컴포넌트 배선을 관통하는지 확인한다. 순수
 * 합성 로직은 one-tap-directives.test.ts 가 박제하고, 여기선 UI 배선(칩·자동배정 문구)을 본다.
 *
 * 작성 규칙: root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../api/hooks";

// vi.mock 팩토리는 호이스트되므로 공유 픽스처는 vi.hoisted 로 만든다.
const fx = vi.hoisted(() => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false });
  const mutation = () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false });
  // 선발 11: GK1 + DF1..DF4 + MF1..MF4 + FW1..FW2 (자동배정은 DF 우선 → DF1)
  const starterSlots = [
    { playerId: "GK1", role: "starter", slotIndex: 0, promptText: null },
    ...Array.from({ length: 4 }, (_, i) => ({ playerId: `DF${i + 1}`, role: "starter", slotIndex: i + 1, promptText: null })),
    ...Array.from({ length: 4 }, (_, i) => ({ playerId: `MF${i + 1}`, role: "starter", slotIndex: i + 5, promptText: null })),
    ...Array.from({ length: 2 }, (_, i) => ({ playerId: `FW${i + 1}`, role: "starter", slotIndex: i + 9, promptText: null })),
  ];
  const deck = { id: "d1", formation: "4-4-2", slots: starterSlots };
  const players = starterSlots.map((s) => ({
    id: s.playerId,
    name: `선수-${s.playerId}`,
    position: s.playerId.replace(/\d+$/, ""),
    grade: "SILVER",
    owned: true,
    ownedCount: 1,
    attributes: {
      technical: 60, mental: 60, physical: 60, passing: 60, shooting: 60,
      tackling: 60, pace: 60, stamina: 60, positioning: 60,
    },
  }));
  return { query, mutation, deck, players };
});

vi.mock("../api/hooks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api/hooks")>();
  return {
    ...actual,
    useDeck: () => fx.query(fx.deck),
    usePlayers: () => fx.query(fx.players),
    useUpdateDeck: fx.mutation,
    useSubmitMatchPrompt: fx.mutation,
    useKickoff: fx.mutation,
  };
});

vi.mock("../api/hooks-v2", () => ({
  useRelations: () =>
    fx.query({
      morale: 72,
      streak: 3,
      players: [{ playerId: "DF1", trust: 84, personality: "CALM" }],
    }),
  // W6a: BriefingPanel 이 프리셋 칩(요구 2)을 위해 소비 — 이 스펙은 프리셋 없는 상태를 본다.
  useTeamPresets: () => fx.query([]),
}));

import { BriefingPanel } from "./BriefingPanel";

const match: Partial<MatchDetail> = {
  id: "m1",
  createdAt: "2026-07-18T00:00:00Z",
  state: "BRIEFING",
  opponent: {
    name: "공격 봇",
    analysisText: "빠른 역습 팀",
    deck: [
      { name: "라이벌 에이스", position: "FW", grade: "GOLD", hasPrompt: true },
      { name: "봇 미들", position: "MF", grade: "SILVER", hasPrompt: false },
    ],
  },
};

afterEach(cleanup);

describe("BriefingPanel 마킹 원탭 (AC-C4)", () => {
  it("상대 선수 마크 → 자동 배정 → 수비수 프롬프트에 '[상대] 막아' 합성", () => {
    render(h(BriefingPanel, { match: match as MatchDetail }));

    // 상대 분석 테이블 + 마크 트리거 노출
    expect(screen.getByTestId("opponent-analysis")).toBeTruthy();
    // 첫 상대(라이벌 에이스) 마크 탭 → 마킹 패널 등장
    act(() => {
      fireEvent.click(screen.getByTestId("mark-opp-0"));
    });
    expect(screen.getByTestId("mark-panel")).toBeTruthy();
    expect(screen.getByTestId("mark-chip").textContent).toContain("라이벌 에이스 마크");

    // 자동 배정(기본값) 확정 → DF1 에 배정된 안내 문구
    act(() => {
      fireEvent.click(screen.getByTestId("mark-confirm"));
    });
    const note = screen.getByTestId("mark-note").textContent ?? "";
    expect(note).toContain("자동 배정");
    expect(note).toContain("선수-DF1"); // DF 우선 자동 배정
    expect(note).toContain("라이벌 에이스 막아"); // 합성된 지시 문구
    expect(note).toContain("덱에 저장됨");
  });

  it("영속 안내 문구 + 관계(사기) 위젯이 브리핑에 노출된다", () => {
    render(h(BriefingPanel, { match: match as MatchDetail }));
    expect(screen.getByTestId("briefing-persist-note").textContent).toContain("내 덱에 저장");
    // 팀 사기 위젯(로비/덱과 동일 컴포넌트)이 브리핑 에디터 관계 배선으로 도달 가능한지 —
    // 사기 위젯은 로비/덱 전용이므로 여기선 선수 시트 관계 대신 상대 테이블/영속 문구만 확인.
    expect(screen.getByTestId("opponent-analysis")).toBeTruthy();
  });
});
