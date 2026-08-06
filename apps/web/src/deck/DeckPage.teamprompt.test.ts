// @vitest-environment jsdom
/**
 * 덱 팀 프롬프트 저장 배선 — #253 (오픈베타 데이터 유실).
 *
 * 원증상: 덱 화면에서 팀 문장을 쓰고 [저장]을 누르면 `PUT /api/deck` 이 **한 번** 나가는데
 * 바디에 팀 문장이 없었다. 화면은 "저장되었습니다"를 띄우고 리로드하면 값이 사라졌다.
 * 선수별 문장은 슬롯에 실려 정상 저장되므로 "선수 문장은 남는데 팀 문장만 없어진다"로 보였다.
 *
 * 그래서 여기서 박제하는 것은 **바디 내용**이다 — 호출 횟수(#106 계약)만 보던 기존 스위트는
 * 이 유실을 통과시켰다. 서버가 못 받는 필드는 UI 를 아무리 고쳐도 안 남는다.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { emptyDraft, toUpdateRequest } from "./deck-logic";

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
    // 서버에 이미 저장돼 있는 팀 문장 — 화면은 이걸 되불러와야 한다.
    teamPrompt: "저장돼 있던 팀 지시",
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
  return { players, deck, updateDeck: vi.fn(async () => deck) };
});

vi.mock("../api/hooks", () => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  return {
    useDeck: () => query(fx.deck),
    usePlayers: () => query(fx.players),
    usePresets: () => query([]),
    useCreatePreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useDeletePreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useUpdateDeck: () => ({ mutateAsync: fx.updateDeck, isPending: false }),
  };
});

/**
 * #455 A2-2 — `DeckPage` 가 강화 `↑` 뱃지 신호를 위해 `usePendingChoices()` 를 부른다.
 * 이 파일은 `TokenProvider` 없이 렌더하므로(그래서 위 두 모듈도 통째로 목이다) 이것도 스텁한다.
 * **빈 목록 = 뱃지 없음** — 이 파일의 단언은 뱃지 축과 무관하고, 그 축은 `p455-a22` 가 잰다.
 */
vi.mock("../api/growth-hooks", () => ({
  usePendingChoices: () => ({ data: [], isLoading: false, isError: false, isSuccess: true }),
}));

vi.mock("../api/hooks-v2", () => {
  const query = (data: unknown) => ({ data, isLoading: false, isError: false, isSuccess: true });
  return {
    useRelations: () => query({ morale: 60, streak: 0, players: [] }),
    useTodayConditions: () => query({ GK1: 0.8 }),
    useTeamPresets: () => query([]),
    useSaveTeamPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
    useApplyTeamPreset: () => ({ mutateAsync: vi.fn(), isPending: false }),
  };
});

// eslint-disable-next-line import/first
import { DeckPage } from "./DeckPage";

function renderPage() {
  return render(h(MemoryRouter, null, h(DeckPage)));
}

function savedBody(): { formation: string; teamPrompt: string | null; slots: unknown[] } {
  const calls = fx.updateDeck.mock.calls as unknown as Array<[{ formation: string; teamPrompt: string | null; slots: unknown[] }]>;
  return calls[calls.length - 1]![0];
}

afterEach(() => {
  cleanup();
  fx.updateDeck.mockClear();
});

describe("deck-logic.toUpdateRequest — 팀 문장이 바디에 실린다 (#253)", () => {
  it("쓴 문장이 그대로 PUT 바디에 들어간다", () => {
    expect(toUpdateRequest(emptyDraft("4-4-2"), "전원 압박").teamPrompt).toBe("전원 압박");
  });

  it("공백만 있으면 null(=없음)로 정규화한다 — 서버 정규화와 같은 규칙", () => {
    expect(toUpdateRequest(emptyDraft("4-4-2"), "   ").teamPrompt).toBeNull();
    expect(toUpdateRequest(emptyDraft("4-4-2"), "").teamPrompt).toBeNull();
  });
});

describe("DeckPage — 팀 프롬프트 저장 관통 (#253)", () => {
  it("저장된 팀 문장을 다시 채운다(빈칸에서 시작하지 않는다)", () => {
    renderPage();
    const field = screen.getByTestId("editor-team-prompt") as HTMLTextAreaElement;
    expect(field.value).toBe("저장돼 있던 팀 지시");
  });

  it("[저장] 이 팀 문장을 실어 보낸다 — 원증상 회귀 가드", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("editor-team-prompt"), {
      target: { value: "전원 강하게 압박하고 라인 올려" },
    });
    fireEvent.click(screen.getByTestId("save-deck"));

    await waitFor(() => expect(fx.updateDeck).toHaveBeenCalledTimes(1));
    // 호출 횟수만 세던 기존 계약은 이 유실을 잡지 못했다 — 바디를 본다.
    expect(savedBody().teamPrompt).toBe("전원 강하게 압박하고 라인 올려");
    expect(savedBody().slots).toHaveLength(11);
  });

  it("문장을 지우고 저장하면 지워진 채로 나간다(전체 교체 시맨틱)", async () => {
    renderPage();
    fireEvent.change(screen.getByTestId("editor-team-prompt"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("save-deck"));

    await waitFor(() => expect(fx.updateDeck).toHaveBeenCalledTimes(1));
    expect(savedBody().teamPrompt).toBeNull();
  });
});
