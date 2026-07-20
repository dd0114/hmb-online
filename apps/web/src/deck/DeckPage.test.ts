// @vitest-environment jsdom
/**
 * 덱 화면 = 세팅 하나 (이슈 #106 R1). 훅을 wholesale 목킹해 DeckPage 를 렌더하고 박제한다:
 *   - 프리셋 진입점(슬롯 칩·요약카드·새 프리셋·프롬프트 프리셋 패널)이 **화면에 없다**
 *   - 프리셋 API 훅(useTeamPresets / useSaveTeamPreset / useApplyTeamPreset / usePresets)을 **호출조차 하지 않는다**
 *   - 저장은 활성 덱 PUT /api/deck **하나만** 호출한다
 *
 * 작성 규칙: root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

const fx = vi.hoisted(() => {
  const attributes = {
    technical: 70, mental: 70, physical: 70, passing: 70, shooting: 70,
    tackling: 70, pace: 70, stamina: 70, positioning: 70,
  };
  const players = [
    { id: "GK1", name: "골리", position: "GK", grade: "GOLD", owned: true, ownedCount: 1, attributes, personality: "CALM" },
    ...Array.from({ length: 11 }, (_, i) => ({
      id: `P${i + 1}`,
      name: `선수${i + 1}`,
      position: i < 4 ? "DF" : i < 8 ? "MF" : "FW",
      grade: "SILVER",
      owned: true,
      ownedCount: 1,
      attributes,
      personality: "CALM",
    })),
  ];
  const deck = {
    id: "d1",
    formation: "4-4-2",
    slots: [
      { playerId: "GK1", role: "starter", slotIndex: 0, promptText: null },
      ...Array.from({ length: 10 }, (_, i) => ({
        playerId: `P${i + 1}`,
        role: "starter",
        slotIndex: i + 1,
        promptText: null,
      })),
    ],
  };
  return {
    players,
    deck,
    updateDeck: vi.fn(async () => deck),
    presetHookCalls: [] as string[],
  };
});

vi.mock("../api/hooks", () => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  return {
    useDeck: () => query(fx.deck),
    usePlayers: () => query(fx.players),
    usePresets: () => {
      fx.presetHookCalls.push("usePresets");
      return query([]);
    },
    useCreatePreset: () => {
      fx.presetHookCalls.push("useCreatePreset");
      return { mutateAsync: vi.fn(), isPending: false };
    },
    useDeletePreset: () => {
      fx.presetHookCalls.push("useDeletePreset");
      return { mutateAsync: vi.fn(), isPending: false };
    },
    useUpdateDeck: () => ({ mutateAsync: fx.updateDeck, isPending: false }),
  };
});

vi.mock("../api/hooks-v2", () => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  return {
    useRelations: () => query({ morale: 60, streak: 0, players: [] }),
    useTodayConditions: () => query({ GK1: 0.8 }),
    useTeamPresets: () => {
      fx.presetHookCalls.push("useTeamPresets");
      return query([]);
    },
    useSaveTeamPreset: () => {
      fx.presetHookCalls.push("useSaveTeamPreset");
      return { mutateAsync: vi.fn(), isPending: false };
    },
    useApplyTeamPreset: () => {
      fx.presetHookCalls.push("useApplyTeamPreset");
      return { mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false };
    },
  };
});

import { DeckPage } from "./DeckPage";

function renderPage() {
  return render(h(MemoryRouter, { initialEntries: ["/deck"] }, h(DeckPage)));
}

afterEach(() => {
  cleanup();
  fx.presetHookCalls.length = 0;
  fx.updateDeck.mockClear();
});

describe("DeckPage — 프리셋 UI 를 화면에서 내림 (#106 R1)", () => {
  it("프리셋 진입점이 하나도 렌더되지 않는다", () => {
    renderPage();
    expect(screen.getByTestId("deck-editor")).toBeTruthy();
    for (const id of [
      "slot-selector", "slot-chip-1", "slot-chip-2", "slot-new-button",
      "preset-summary", "preset-summary-name", "preset-rename-button",
      "preset-name", "preset-body", "preset-create",
    ]) {
      expect(screen.queryByTestId(id), `${id} 가 화면에 남아 있으면 안 된다`).toBeNull();
    }
  });

  it("프리셋 관련 API 훅을 아예 호출하지 않는다 (계약은 존치, 화면만 내림)", () => {
    renderPage();
    expect(fx.presetHookCalls).toEqual([]);
  });

  it("팀 시트 골격(시트 바 3지표 + 보드 + 레일)이 그대로 선다", () => {
    renderPage();
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 11/11");
    expect(screen.getByTestId("bench-count").textContent).toBe("벤치 0/7");
    expect(screen.getByTestId("board-card")).toBeTruthy();
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("team");
  });
});

describe("DeckPage — 저장은 활성 덱 하나", () => {
  it("저장 시 PUT /api/deck 만 호출한다", async () => {
    renderPage();
    fireEvent.click(screen.getByTestId("save-deck"));
    await waitFor(() => expect(fx.updateDeck).toHaveBeenCalledTimes(1));
    const body = (fx.updateDeck.mock.calls as unknown as Array<[{ formation: string; slots: unknown[] }]>)[0]![0];
    expect(body.formation).toBe("4-4-2");
    expect(body.slots).toHaveLength(11);
    expect(fx.presetHookCalls).toEqual([]);
  });

  it("편집하면 미저장 뱃지가 뜬다(dirty 가드 유지)", () => {
    renderPage();
    expect(screen.queryByTestId("deck-dirty-badge")).toBeNull();
    fireEvent.change(screen.getByTestId("editor-team-prompt"), { target: { value: "강하게 압박" } });
    expect(screen.getByTestId("deck-dirty-badge")).toBeTruthy();
  });
});
