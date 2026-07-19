// @vitest-environment jsdom
/**
 * 팀 시트 골격 계약 (이슈 #106 R1) — jsdom 에서 DeckEditor 를 실제로 렌더해 박제한다:
 *   ① 시트 바가 3지표(선발/벤치/지시)를 낸다
 *   ② 벤치 스트립이 **보드 카드 안**에 있다(별도 블록 금지)
 *   ③ 선수를 누르면 **선수정보 시트가 아니라 레일**이 그 선수로 바뀐다
 *   ④ 탭-투-플레이스: 슬롯 탭 → 리스트 자동 필터 → 선수 탭 → 배치
 *   ⑤ 화면에 프리셋 진입점이 없다
 *
 * 작성 규칙: root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeckEditor } from "./DeckEditor";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "./tactics-logic";
import { emptyDraft, type DeckDraft } from "./deck-logic";
import type { CatalogPlayer } from "../api/hooks";

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const P = (id: string, name: string, position: string, overall: number) =>
  ({
    id, name, position, grade: "SILVER", owned: true, ownedCount: 1,
    attributes: attrs(overall), personality: "CALM",
  }) as unknown as CatalogPlayer;

const PLAYERS: CatalogPlayer[] = [
  P("GK1", "골리", "GK", 70),
  P("DF1", "수비수", "DF", 72),
  P("MF1", "미드필더", "MF", 80),
  P("MF2", "미드필더2", "MF", 66),
  P("FW1", "공격수", "FW", 88),
];

const byId = new Map(PLAYERS.map((p) => [p.id, p]));

function initialState(draft: DeckDraft = emptyDraft("4-4-2")): EditorState {
  return { draft, tactics: { ...DEFAULT_TEAM_TACTICS }, teamPrompt: "" };
}

/** 제어 컴포넌트라 상태를 들고 있는 얇은 하네스로 감싼다(실사용과 동일한 흐름). */
function Harness({ initial }: { initial: EditorState }) {
  const [state, setState] = useState(initial);
  const [ai, setAi] = useState(false);
  return h(DeckEditor, {
    state,
    onChange: setState,
    aiManaged: ai,
    onToggleAi: setAi,
    players: PLAYERS,
    playersById: byId,
    conditions: { MF1: 0.5, FW1: 0.9 },
  });
}

function renderSheet(draft?: DeckDraft) {
  return render(h(Harness, { initial: initialState(draft) }));
}

const placedDraft = (): DeckDraft => ({
  formation: "4-4-2",
  slots: [
    { playerId: "MF1", role: "starter", slotIndex: 6, promptText: "안쪽으로 파고들어라" },
    { playerId: "FW1", role: "starter", slotIndex: 9, promptText: null },
    { playerId: "GK1", role: "bench", slotIndex: 0, promptText: null },
  ],
});

afterEach(cleanup);

describe("① 시트 바 — 3지표", () => {
  it("선발 n/11 · 벤치 n/7 · 지시 n/11 을 모두 렌더한다", () => {
    renderSheet(placedDraft());
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 2/11");
    expect(screen.getByTestId("bench-count").textContent).toBe("벤치 1/7");
    expect(screen.getByTestId("directive-count").textContent).toContain("지시 1/11");
  });

  it("포메이션 셀렉트와 전력 게이지가 시트 바 안에 있다", () => {
    renderSheet(placedDraft());
    const bar = screen.getByTestId("team-sheet-bar");
    expect(bar.contains(screen.getByTestId("formation-select"))).toBe(true);
    expect(bar.contains(screen.getByTestId("sheet-power"))).toBe(true);
  });
});

describe("② 전술보드 = SoT", () => {
  it("벤치 스트립은 보드 카드 **안**에 있다 (별도 블록 금지)", () => {
    renderSheet(placedDraft());
    const card = screen.getByTestId("board-card");
    expect(card.contains(screen.getByTestId("board-bench-section"))).toBe(true);
    expect(card.contains(screen.getByTestId("board-bench"))).toBe(true);
    expect(card.contains(screen.getByTestId("tactics-board"))).toBe(true);
  });

  it("보드 하단 바(초기화/Auto)도 같은 카드 안", () => {
    render(
      h(function Wrap() {
        const [state, setState] = useState(initialState(placedDraft()));
        return h(DeckEditor, {
          state,
          onChange: setState,
          aiManaged: false,
          onToggleAi: () => {},
          players: PLAYERS,
          playersById: byId,
          onAuto: () => {},
        });
      }),
    );
    const card = screen.getByTestId("board-card");
    expect(card.contains(screen.getByTestId("board-reset"))).toBe(true);
    expect(card.contains(screen.getByTestId("auto-fill"))).toBe(true);
  });
});

describe("③ 선수 탭 → 선수정보 시트가 아니라 레일이 바뀐다", () => {
  it("선택이 없으면 레일은 팀 지시", () => {
    renderSheet(placedDraft());
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("team");
    expect(screen.getByTestId("rail-title").textContent).toBe("팀 지시");
    expect(screen.getByTestId("editor-team-prompt")).toBeTruthy();
  });

  it("토큰을 누르면 레일이 그 선수 지시로 바뀌고, 선수정보 시트는 뜨지 않는다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    const rail = screen.getByTestId("directive-rail");
    expect(rail.getAttribute("data-mode")).toBe("player");
    expect(screen.getByTestId("rail-title").textContent).toBe("미드필더");
    // 한 줄 신원 (번호 · 이름 · 포지션 · 컨디션)
    expect(screen.getByTestId("rail-subtitle").textContent).toContain("MF");
    expect(screen.getByTestId("rail-subtitle").textContent).toContain("컨디션");
    // 구 PlayerSheet 는 없다
    expect(screen.queryByTestId("player-sheet")).toBeNull();
    expect(screen.queryByTestId("sheet-prompt-input")).toBeNull();
    // 그 선수의 프롬프트가 레일에 실려 있다
    expect((screen.getByTestId("rail-prompt-input") as HTMLTextAreaElement).value).toBe(
      "안쪽으로 파고들어라",
    );
  });

  it("레일 닫기 → 팀 지시로 복귀", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    fireEvent.click(screen.getByTestId("rail-close"));
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("team");
  });

  it("레일에서 프롬프트를 고치면 지시 지표가 올라간다(보드↔레일 동기)", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9")); // FW1 (프롬프트 없음)
    fireEvent.change(screen.getByTestId("rail-prompt-input"), { target: { value: "과감하게 슛" } });
    expect(screen.getByTestId("directive-count").textContent).toContain("지시 2/11");
  });
});

describe("④ 탭-투-플레이스", () => {
  it("빈 슬롯 탭 → 리스트가 그 포지션으로 자동 필터 → 선수 탭 → 배치", () => {
    renderSheet();
    // MF 슬롯(4-4-2 slotIndex 6) 탭
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    expect(screen.getByTestId("picker-filter-MF").getAttribute("aria-selected")).toBe("true");
    // 그 포지션 추천순 상위(MF1=80)가 리스트에 있다
    fireEvent.click(screen.getByTestId("pick-MF1"));
    expect(screen.getByTestId("board-slot-starter-6").getAttribute("data-filled")).toBe("true");
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 1/11");
    // 배치 직후 레일이 그 선수로 전환된다
    expect(screen.getByTestId("rail-title").textContent).toBe("미드필더");
  });

  it("역방향(선수 먼저 탭 → 슬롯 탭)도 동일하게 배치된다", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("pick-FW1"));
    // 첫 탭은 배치가 아니라 '집어듦'
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 0/11");
    expect(screen.getByTestId("pick-FW1").getAttribute("data-pending")).toBe("true");
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 1/11");
    expect(screen.getByTestId("board-slot-starter-9").getAttribute("data-filled")).toBe("true");
  });

  it("토큰 → 토큰 탭 = 자리 교체", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-6")); // MF1 선택
    fireEvent.click(screen.getByTestId("board-slot-starter-9")); // FW1 자리 탭
    expect(screen.getByTestId("board-slot-starter-9").querySelector('[data-testid="token-MF1"]')).toBeTruthy();
    expect(screen.getByTestId("board-slot-starter-6").querySelector('[data-testid="token-FW1"]')).toBeTruthy();
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 2/11");
  });

  it("배치 대기 중에는 보드 바가 명시적 취소를 준다(모바일 독이 접혀도 취소 가능)", () => {
    render(
      h(function Wrap() {
        const [state, setState] = useState(initialState());
        return h(DeckEditor, {
          state,
          onChange: setState,
          aiManaged: false,
          onToggleAi: () => {},
          players: PLAYERS,
          playersById: byId,
          onAuto: () => {},
        });
      }),
    );
    expect(screen.queryByTestId("place-cancel")).toBeNull();
    fireEvent.click(screen.getByTestId("pick-FW1"));
    expect(screen.getByTestId("place-pending-hint").textContent).toContain("공격수");
    fireEvent.click(screen.getByTestId("place-cancel"));
    expect(screen.queryByTestId("place-cancel")).toBeNull();
    expect(screen.getByTestId("pick-FW1").getAttribute("data-pending")).toBe("false");
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("team");
  });

  it("집어든 행을 다시 탭하면 해제된다(슬롯 재탭과 대칭)", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("pick-FW1"));
    expect(screen.getByTestId("pick-FW1").getAttribute("data-pending")).toBe("true");
    fireEvent.click(screen.getByTestId("pick-FW1"));
    expect(screen.getByTestId("pick-FW1").getAttribute("data-pending")).toBe("false");
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 0/11");
  });

  it("배치(리스트→보드)는 독을 펼치지 않고, 이미 배치된 토큰 탭은 펼친다", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    fireEvent.click(screen.getByTestId("pick-MF1")); // 배치
    expect(screen.getByTestId("rail-dock").getAttribute("data-open")).toBe("false");
    fireEvent.click(screen.getByTestId("rail-close")); // 선택 비우고
    fireEvent.click(screen.getByTestId("board-slot-starter-6")); // 이미 배치된 선수 선택
    expect(screen.getByTestId("rail-dock").getAttribute("data-open")).toBe("true");
  });

  it("벤치 빈칸으로도 탭 배치된다(벤치가 보드와 같은 탭 규칙)", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("board-slot-bench-0"));
    fireEvent.click(screen.getByTestId("pick-GK1"));
    expect(screen.getByTestId("bench-count").textContent).toBe("벤치 1/7");
  });
});

describe("⑤ 프리셋 진입점 부재", () => {
  it("프리셋 슬롯 선택기·요약카드·프롬프트 프리셋 패널이 화면에 없다", () => {
    renderSheet(placedDraft());
    expect(screen.queryByTestId("slot-selector")).toBeNull();
    expect(screen.queryByTestId("slot-chip-1")).toBeNull();
    expect(screen.queryByTestId("preset-summary")).toBeNull();
    expect(screen.queryByTestId("preset-name")).toBeNull();
    expect(screen.queryByTestId("slot-new-button")).toBeNull();
  });
});
