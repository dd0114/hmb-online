// @vitest-environment jsdom
/**
 * W6a 브리핑 프리셋 선택(이슈 #98 요구 2 — "게임 시작 시엔 1/2/3 중 선택 → 그 위에 매치용 추가
 * 수정 → 진행"). jsdom 에서 BriefingPanel 을 실제 렌더해 칩 배선을 박제한다:
 *   빈 슬롯 비활성 · 미선택 시 활성 덱 초기화 유지(회귀 금지) · 선택 시 editor 가 스냅샷으로 교체
 *   · 매치용 수정 후 다른 프리셋 선택 시 덮어쓰기 확인 다이얼로그(취소/확인).
 * 순수 판정 로직은 briefing-preset-logic.test.ts 가 별도로 박제한다.
 *
 * 작성 규칙: root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MatchDetail } from "../api/hooks";

const fx = vi.hoisted(() => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  const mutation = () => ({ mutate: () => {}, mutateAsync: async () => {}, isPending: false });
  const attributes = {
    technical: 60, mental: 60, physical: 60, passing: 60, shooting: 60,
    tackling: 60, pace: 60, stamina: 60, positioning: 60,
  };
  // 활성 덱 = DECK* 선수 11 (프리셋과 겹치지 않는 id 라 교체가 눈에 보인다)
  const deckSlots = Array.from({ length: 11 }, (_, i) => ({
    playerId: `DECK${i + 1}`,
    role: "starter",
    slotIndex: i,
    promptText: null,
  }));
  const deck = { id: "d1", formation: "4-4-2", slots: deckSlots };

  const presetStarters = (prefix: string) =>
    Array.from({ length: 11 }, (_, i) => ({ playerId: `${prefix}${i + 1}`, slotIndex: i, promptText: null }));

  const presets = [
    {
      slot: 1,
      name: "메인 전술",
      snapshot: {
        formation: "4-4-2",
        starters: presetStarters("MAIN"),
        bench: [],
        teamTactics: { line: 0.5, press: 0.5, tempo: 0.5, width: 0.5 },
        teamPrompt: "메인 팀 지시",
      },
    },
    {
      slot: 2,
      name: "백업 전술",
      snapshot: {
        formation: "4-3-3",
        starters: presetStarters("BACK"),
        bench: [],
        teamTactics: { line: 0.6, press: 0.6, tempo: 0.6, width: 0.6 },
        teamPrompt: "백업 팀 지시",
      },
    },
    { slot: 3, name: null, snapshot: null },
  ];

  const players = [
    ...deckSlots.map((s) => s.playerId),
    ...presetStarters("MAIN").map((s) => s.playerId),
    ...presetStarters("BACK").map((s) => s.playerId),
  ].map((id) => ({
    id,
    name: `선수-${id}`,
    position: id.endsWith("1") ? "GK" : "MF",
    grade: "SILVER",
    owned: true,
    ownedCount: 1,
    attributes,
  }));

  // 훅이 렌더 시점에 읽는 가변 홀더 — "전부 빈 슬롯" 케이스를 같은 모듈 목으로 재현하기 위함.
  const presetsState = { value: presets as unknown[] };
  return { query, mutation, deck, players, presets, presetsState };
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
  useRelations: () => fx.query({ morale: 70, streak: 0, players: [] }),
  useTeamPresets: () => fx.query(fx.presetsState.value),
}));

import { BriefingPanel } from "./BriefingPanel";

const match: Partial<MatchDetail> = {
  id: "m1",
  createdAt: "2026-07-18T00:00:00Z",
  state: "BRIEFING",
  opponent: { name: "공격 봇", analysisText: "빠른 역습", deck: [] },
};

function renderPanel() {
  render(h(BriefingPanel, { match: match as MatchDetail }));
}

const teamPrompt = () => screen.getByTestId("editor-team-prompt") as HTMLTextAreaElement;

afterEach(() => {
  cleanup();
  fx.presetsState.value = fx.presets;
});

describe("BriefingPanel 프리셋 선택 (요구 2, W6a)", () => {
  it("저장된 프리셋이 하나도 없으면(신규 유저) 칩 행 자체를 숨긴다", () => {
    fx.presetsState.value = [
      { slot: 1, name: null, snapshot: null },
      { slot: 2, name: null, snapshot: null },
      { slot: 3, name: null, snapshot: null },
    ];
    renderPanel();
    expect(screen.queryByTestId("briefing-presets")).toBeNull();
    expect(screen.queryByTestId("briefing-preset-chip-1")).toBeNull();
    expect(screen.queryByTestId("briefing-preset-hint")).toBeNull();
    // 회귀 금지: 프리셋 없이도 활성 덱으로 정상 초기화된다.
    expect(screen.getByTestId("token-DECK1")).toBeTruthy();
  });

  it("칩 [1][2][3] 노출 — 채워진 슬롯만 선택 가능, 빈 슬롯은 비활성 + '비어 있음'", () => {
    renderPanel();
    const c1 = screen.getByTestId("briefing-preset-chip-1") as HTMLButtonElement;
    const c3 = screen.getByTestId("briefing-preset-chip-3") as HTMLButtonElement;
    expect(c1.disabled).toBe(false);
    expect(c1.textContent).toContain("메인 전술");
    expect(c3.disabled).toBe(true);
    expect(c3.textContent).toContain("비어 있음");
    expect(screen.getByTestId("briefing-preset-hint")).toBeTruthy();
  });

  it("프리셋 미선택 시 활성 덱으로 초기화(현행 동작 유지 — 회귀 금지)", () => {
    renderPanel();
    expect(screen.getByTestId("token-DECK1")).toBeTruthy();
    expect(screen.queryByTestId("token-MAIN1")).toBeNull();
    expect(screen.getByTestId("briefing-preset-chip-1").getAttribute("data-selected")).toBe("false");
  });

  it("칩 선택 → editor 가 그 스냅샷으로 교체(라인업·팀 프롬프트)", () => {
    renderPanel();
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-1"));
    });
    expect(screen.getByTestId("token-MAIN1")).toBeTruthy();
    expect(screen.queryByTestId("token-DECK1")).toBeNull();
    expect(teamPrompt().value).toBe("메인 팀 지시");
    expect(screen.getByTestId("briefing-preset-chip-1").getAttribute("data-selected")).toBe("true");
  });

  it("매치용 수정 후 다른 프리셋 선택 → 확인 다이얼로그, 취소 시 수정 유지", () => {
    renderPanel();
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-1"));
    });
    act(() => {
      fireEvent.change(teamPrompt(), { target: { value: "오늘은 수비적으로" } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-2"));
    });
    expect(screen.getByTestId("briefing-preset-confirm")).toBeTruthy();
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-confirm-cancel"));
    });
    expect(screen.queryByTestId("briefing-preset-confirm")).toBeNull();
    expect(teamPrompt().value).toBe("오늘은 수비적으로");
    expect(screen.getByTestId("token-MAIN1")).toBeTruthy();
  });

  it("확인 다이얼로그에서 '불러오기' → 수정 폐기하고 새 프리셋 로드", () => {
    renderPanel();
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-1"));
    });
    act(() => {
      fireEvent.change(teamPrompt(), { target: { value: "오늘은 수비적으로" } });
    });
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-2"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-confirm-load"));
    });
    expect(screen.queryByTestId("briefing-preset-confirm")).toBeNull();
    expect(screen.getByTestId("token-BACK1")).toBeTruthy();
    expect(teamPrompt().value).toBe("백업 팀 지시");
    expect(screen.getByTestId("briefing-preset-chip-2").getAttribute("data-selected")).toBe("true");
  });

  it("수정 없이 프리셋을 바로 바꾸면 다이얼로그 없이 교체", () => {
    renderPanel();
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-1"));
    });
    act(() => {
      fireEvent.click(screen.getByTestId("briefing-preset-chip-2"));
    });
    expect(screen.queryByTestId("briefing-preset-confirm")).toBeNull();
    expect(screen.getByTestId("token-BACK1")).toBeTruthy();
  });
});
