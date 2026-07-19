// @vitest-environment jsdom
/**
 * W5 "이 경기 세팅 보기 → 프리셋으로 저장" 다이얼로그 렌더/저장 경로 (이슈 #98 요구 2).
 * 훅은 wholesale mock — 검증 대상은 (1) 스냅샷 요약이 실제로 DOM 에 찍히는지,
 * (2) 저장이 **빈 슬롯 우선**으로 PUT 바디를 그 스냅샷 그대로 보내는지,
 * (3) 스냅샷이 없거나 선발<11 이면 저장 경로가 노출되지 않고 안내가 뜨는지.
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CatalogPlayer } from "../api/hooks";
import type { TeamPresetSlot, TeamSnapshot } from "../api/v2";

const FULL_SNAPSHOT: TeamSnapshot = {
  formation: "4-3-3",
  starters: Array.from({ length: 11 }, (_, i) => ({
    playerId: `P${i}`,
    slotIndex: i,
    promptText: i === 0 ? "라인 올려" : null,
  })),
  bench: [{ playerId: "B0", slotIndex: 0, promptText: null }],
  teamTactics: { line: 0.8, press: 0.3, tempo: 0.7, width: 0.2 },
  teamPrompt: "역습 위주",
};

const PRESETS: TeamPresetSlot[] = [
  { slot: 1, name: "메인", snapshot: FULL_SNAPSHOT, updatedAt: "2026-07-19T00:00:00Z" },
  { slot: 2, name: null, snapshot: null, updatedAt: null },
  { slot: 3, name: null, snapshot: null, updatedAt: null },
];

const attrs = {
  technical: 70, mental: 70, physical: 70, passing: 70, shooting: 70,
  tackling: 70, pace: 70, stamina: 70, positioning: 70,
};
const PLAYERS: CatalogPlayer[] = [
  { id: "P0", name: "골키퍼짱", position: "GK", grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs },
];

const useMatch = vi.fn();
const usePlayers = vi.fn(() => ({ data: PLAYERS }));
const useTeamPresets = vi.fn(() => ({ data: PRESETS }));
interface SaveArgs {
  slot: number;
  body: Record<string, unknown>;
}
const mutateAsync = vi.fn(async (_args: SaveArgs) => ({}));
const useSaveTeamPreset = vi.fn(() => ({ mutateAsync, isPending: false }));

vi.mock("../api/hooks", () => ({
  useMatch: (...a: unknown[]) => useMatch(...a),
  usePlayers: () => usePlayers(),
}));
vi.mock("../api/hooks-v2", () => ({
  useTeamPresets: () => useTeamPresets(),
  useSaveTeamPreset: () => useSaveTeamPreset(),
}));

import { MatchSnapshotDialog } from "./MatchSnapshotDialog";

function renderDialog() {
  return render(
    h(MatchSnapshotDialog, {
      matchId: "m1",
      opponentName: "봇A",
      createdAt: "2026-07-19T10:00:00Z",
      onClose: () => {},
    }),
  );
}

beforeEach(() => {
  // clearAllMocks 는 mockReturnValue 를 지우지 않는다 — 매 테스트 기본 프리셋(2·3 빈 슬롯)으로 복구.
  useTeamPresets.mockReturnValue({ data: PRESETS });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("스냅샷 요약", () => {
  it("포메이션·선발(카탈로그 이름 조인)·팀전술·팀프롬프트를 표시한다", () => {
    useMatch.mockReturnValue({ data: { id: "m1", userDeckSnapshot: FULL_SNAPSHOT }, isLoading: false, isError: false });
    renderDialog();

    expect(screen.getByTestId("snapshot-formation").textContent).toBe("4-3-3");
    expect(screen.getByTestId("snapshot-starter-count").textContent).toContain("11");
    // 카탈로그에 있는 선수는 이름, 없으면 playerId 폴백
    expect(screen.getByTestId("snapshot-starter-P0").textContent).toBe("골키퍼짱");
    expect(screen.getByTestId("snapshot-starter-P5").textContent).toBe("P5");
    expect(screen.getByTestId("snapshot-tactic-line").textContent).toBe("0.80");
    expect(screen.getByTestId("snapshot-tactic-width").textContent).toBe("0.20");
    expect(screen.getByTestId("snapshot-team-prompt").textContent).toContain("역습 위주");
  });
});

describe("프리셋으로 저장", () => {
  it("빈 슬롯(2)이 기본 대상이고, PUT 바디는 그 경기 스냅샷 그대로다", async () => {
    useMatch.mockReturnValue({ data: { id: "m1", userDeckSnapshot: FULL_SNAPSHOT }, isLoading: false, isError: false });
    renderDialog();

    expect(screen.getByTestId("snapshot-slot-2").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("snapshot-slot-1").getAttribute("data-selected")).toBe("false");
    expect((screen.getByTestId("snapshot-name-input") as HTMLInputElement).value).toBe("vs 봇A 07.19");

    await act(async () => {
      fireEvent.click(screen.getByTestId("snapshot-save"));
    });

    expect(mutateAsync).toHaveBeenCalledTimes(1);
    const arg = mutateAsync.mock.calls[0]![0];
    expect(arg.slot).toBe(2);
    expect(arg.body).toEqual({
      name: "vs 봇A 07.19",
      formation: "4-3-3",
      starters: FULL_SNAPSHOT.starters,
      bench: FULL_SNAPSHOT.bench,
      teamTactics: FULL_SNAPSHOT.teamTactics,
      teamPrompt: "역습 위주",
    });
    expect(screen.getByTestId("snapshot-saved").textContent).toContain("슬롯 2");
  });

  it("채워진 슬롯을 고르면 라벨이 '덮어쓰기'로 바뀌고 그 슬롯으로 저장된다", async () => {
    useMatch.mockReturnValue({ data: { id: "m1", userDeckSnapshot: FULL_SNAPSHOT }, isLoading: false, isError: false });
    renderDialog();

    // 빈 슬롯(2) 기본 상태의 라벨은 비파괴 문구
    expect(screen.getByTestId("snapshot-save").textContent).toBe("슬롯 2에 저장");

    fireEvent.click(screen.getByTestId("snapshot-slot-1"));
    // 파괴적 저장은 화면 텍스트로 드러난다(툴팁 의존 금지 — 모바일엔 hover 가 없다)
    expect(screen.getByTestId("snapshot-save").textContent).toBe("슬롯 1 덮어쓰기");

    await act(async () => {
      fireEvent.click(screen.getByTestId("snapshot-save"));
    });
    expect(mutateAsync.mock.calls[0]![0].slot).toBe(1);
  });

  it("전 슬롯이 차 있으면 기본 선택이 없고 저장 버튼이 비활성(1탭 덮어쓰기 방지)", async () => {
    useTeamPresets.mockReturnValue({
      data: PRESETS.map((s) => ({ ...s, name: `프리셋${s.slot}`, snapshot: FULL_SNAPSHOT })),
    });
    useMatch.mockReturnValue({ data: { id: "m1", userDeckSnapshot: FULL_SNAPSHOT }, isLoading: false, isError: false });
    renderDialog();

    for (const n of [1, 2, 3]) {
      expect(screen.getByTestId(`snapshot-slot-${n}`).getAttribute("data-selected")).toBe("false");
    }
    const save = screen.getByTestId("snapshot-save") as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    expect(save.textContent).toBe("저장할 슬롯을 선택하세요");

    // 클릭해도 저장되지 않는다(비활성 — 실제 mutate 호출 0)
    await act(async () => {
      fireEvent.click(save);
    });
    expect(mutateAsync).not.toHaveBeenCalled();

    // 명시적으로 슬롯을 탭해야만 활성 + 파괴 문구
    fireEvent.click(screen.getByTestId("snapshot-slot-3"));
    expect((screen.getByTestId("snapshot-save") as HTMLButtonElement).disabled).toBe(false);
    expect(screen.getByTestId("snapshot-save").textContent).toBe("슬롯 3 덮어쓰기");
    await act(async () => {
      fireEvent.click(screen.getByTestId("snapshot-save"));
    });
    expect(mutateAsync.mock.calls[0]![0].slot).toBe(3);
  });

  it("이름을 수정하면 그 이름으로 저장된다", async () => {
    useMatch.mockReturnValue({ data: { id: "m1", userDeckSnapshot: FULL_SNAPSHOT }, isLoading: false, isError: false });
    renderDialog();

    fireEvent.change(screen.getByTestId("snapshot-name-input"), { target: { value: "결승전 세팅" } });
    await act(async () => {
      fireEvent.click(screen.getByTestId("snapshot-save"));
    });
    expect(mutateAsync.mock.calls[0]![0].body.name).toBe("결승전 세팅");
  });
});

describe("스냅샷이 없거나 불완전한 경기", () => {
  it("스냅샷 null 이면 안내 + 저장 경로 비노출", () => {
    useMatch.mockReturnValue({ data: { id: "m1", userDeckSnapshot: null }, isLoading: false, isError: false });
    renderDialog();

    expect(screen.getByTestId("match-snapshot-none")).toBeTruthy();
    expect(screen.queryByTestId("snapshot-save")).toBeNull();
    expect(screen.queryByTestId("match-snapshot-summary")).toBeNull();
  });

  it("선발이 11 미만이면 요약은 보여주되 저장은 막고 사유를 안내한다", () => {
    useMatch.mockReturnValue({
      data: { id: "m1", userDeckSnapshot: { ...FULL_SNAPSHOT, starters: FULL_SNAPSHOT.starters.slice(0, 10) } },
      isLoading: false,
      isError: false,
    });
    renderDialog();

    expect(screen.getByTestId("match-snapshot-summary")).toBeTruthy();
    expect(screen.getByTestId("match-snapshot-incomplete")).toBeTruthy();
    expect(screen.queryByTestId("snapshot-save")).toBeNull();
  });

  it("상세 조회 실패면 에러 안내", () => {
    useMatch.mockReturnValue({ data: undefined, isLoading: false, isError: true });
    renderDialog();
    expect(screen.getByTestId("match-snapshot-error")).toBeTruthy();
  });
});
