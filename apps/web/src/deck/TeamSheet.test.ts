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

/**
 * ⑥ A안 지시 레일 (#106 R2). 핵심은 `AI에 전달될 지시문` 미리보기가 **두 레이어를 구분해** 보여주고
 * 그 합이 **실제 전송값(promptText)** 과 같다는 것 — 어긋나면 A안이 화면에서 거짓말을 한다.
 */
describe("⑥ 지시 레일 A안 — 선수 컨텍스트", () => {
  /** 마지막으로 draft 에 반영된 promptText (= 서버 PUT 으로 나가는 값). */
  function sentPrompt(state: EditorState, playerId: string): string {
    return state.draft.slots.find((s) => s.playerId === playerId)?.promptText ?? "";
  }

  function renderCapturing() {
    let latest: EditorState | null = null;
    render(
      h(function Wrap() {
        const [state, setState] = useState(initialState(placedDraft()));
        latest = state;
        return h(DeckEditor, {
          state,
          onChange: setState,
          aiManaged: false,
          onToggleAi: () => {},
          players: PLAYERS,
          playersById: byId,
          conditions: { MF1: 0.5, FW1: 0.9 },
        });
      }),
    );
    return () => latest!;
  }

  it("역할은 세그먼트 컨트롤(4종) — 누르면 pressed 가 옮겨간다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9")); // FW1 (프롬프트 없음)
    expect(screen.getByTestId("rail-role-balanced").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("rail-role-attack"));
    expect(screen.getByTestId("rail-role-attack").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("rail-role-balanced").getAttribute("aria-pressed")).toBe("false");
  });

  it("역할·칩이 미리보기 문장에 즉시 반영된다(칩은 카탈로그 순서)", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    // 아직 아무것도 없으면 빈 상태 안내
    expect(screen.getByTestId("rail-compose-empty")).toBeTruthy();

    fireEvent.click(screen.getByTestId("rail-role-attack"));
    fireEvent.click(screen.getByTestId("rail-chip-tempo")); // 카탈로그 끝
    fireEvent.click(screen.getByTestId("rail-chip-marking")); // 카탈로그 처음
    const text = screen.getByTestId("rail-compose-directive").textContent!;
    expect(text).toContain("공격 가담");
    expect(text.indexOf("마크")).toBeLessThan(text.indexOf("템포")); // 선택 순서가 아니라 카탈로그 순서
    // 자유 문장이 없으면 "내가 쓴 문장" 줄도 없다(레이어 구분)
    expect(screen.queryByTestId("rail-compose-own")).toBeNull();
  });

  it("미리보기 두 줄 = 실제 전송 promptText (A안 핵심 계약)", () => {
    const get = renderCapturing();
    fireEvent.click(screen.getByTestId("board-slot-starter-9")); // FW1
    fireEvent.click(screen.getByTestId("rail-role-attack"));
    fireEvent.click(screen.getByTestId("rail-chip-overlap"));
    fireEvent.click(screen.getByTestId("rail-chip-runbehind"));
    fireEvent.change(screen.getByTestId("rail-prompt-input"), {
      target: { value: "상대 풀백이 느리다, 안쪽으로 파고들어라" },
    });

    const shown = [
      screen.getByTestId("rail-compose-directive").textContent!,
      screen.getByTestId("rail-compose-own").textContent!,
    ].join("\n");
    expect(sentPrompt(get(), "FW1")).toBe(shown);
    // 그리고 두 레이어가 실제로 섞이지 않았다
    expect(screen.getByTestId("rail-compose-directive").textContent).not.toContain("풀백");
    expect(screen.getByTestId("rail-compose-own").textContent).toBe("상대 풀백이 느리다, 안쪽으로 파고들어라");
  });

  it("칩을 껐다 켜도 문장이 중복 누적되지 않는다(합성 = 상태의 함수)", () => {
    const get = renderCapturing();
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    fireEvent.click(screen.getByTestId("rail-chip-press"));
    const once = sentPrompt(get(), "FW1");
    fireEvent.click(screen.getByTestId("rail-chip-press")); // 끄고
    fireEvent.click(screen.getByTestId("rail-chip-press")); // 다시 켜기
    expect(sentPrompt(get(), "FW1")).toBe(once);
  });

  it("영속된 프롬프트를 다시 열면 두 레이어로 복원된다(칩 1회 탭에 합성문이 중복되지 않는다)", () => {
    // MF1 의 저장된 프롬프트는 자유 문장뿐 → 전부 "내가 쓴 문장"으로 복원
    const get = renderCapturing();
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    expect((screen.getByTestId("rail-prompt-input") as HTMLTextAreaElement).value).toBe("안쪽으로 파고들어라");
    expect(screen.getByTestId("rail-compose-own").textContent).toBe("안쪽으로 파고들어라");

    // 칩을 켜면 지시 줄이 새로 생기고, 자유 문장은 그대로 한 번만 남는다
    fireEvent.click(screen.getByTestId("rail-chip-marking"));
    const sent = sentPrompt(get(), "MF1");
    expect(sent.split("안쪽으로 파고들어라")).toHaveLength(2); // 정확히 1회 등장
    expect(sent.startsWith(screen.getByTestId("rail-compose-directive").textContent!)).toBe(true);

    // 다른 선수로 갔다가 돌아와도 레이어가 유지된다(저장값 재파싱)
    fireEvent.click(screen.getByTestId("rail-close"));
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    expect(screen.getByTestId("rail-chip-marking").getAttribute("aria-pressed")).toBe("true");
    expect((screen.getByTestId("rail-prompt-input") as HTMLTextAreaElement).value).toBe("안쪽으로 파고들어라");
    expect(sentPrompt(get(), "MF1")).toBe(sent);
  });
});

describe("⑥ 지시 레일 A안 — 팀 컨텍스트 5스텝 세그먼트", () => {
  function renderCapturing() {
    let latest: EditorState | null = null;
    render(
      h(function Wrap() {
        const [state, setState] = useState(initialState(placedDraft()));
        latest = state;
        return h(DeckEditor, {
          state,
          onChange: setState,
          aiManaged: false,
          onToggleAi: () => {},
          players: PLAYERS,
          playersById: byId,
        });
      }),
    );
    return () => latest!;
  }

  it("슬라이더가 아니라 5스텝 버튼이고, 기본 0.5 는 가운데(보통)가 눌려 있다", () => {
    renderSheet(placedDraft());
    for (const key of ["line", "press", "tempo", "width"]) {
      const group = screen.getByTestId(`tactics-${key}`);
      expect(group.tagName).not.toBe("INPUT");
      expect(group.querySelectorAll("button")).toHaveLength(5);
      expect(screen.getByTestId(`tactics-${key}-step-2`).getAttribute("aria-pressed")).toBe("true");
    }
  });

  it("스텝을 누르면 계약값이 0/.25/.5/.75/1 로 나간다", () => {
    const get = renderCapturing();
    fireEvent.click(screen.getByTestId("tactics-press-step-3"));
    expect(get().tactics.press).toBe(0.75);
    fireEvent.click(screen.getByTestId("tactics-line-step-0"));
    expect(get().tactics.line).toBe(0);
    fireEvent.click(screen.getByTestId("tactics-width-step-4"));
    expect(get().tactics.width).toBe(1);
    // 나머지 축은 건드리지 않는다
    expect(get().tactics.tempo).toBe(0.5);
  });

  it("서버에서 온 중간값(0.6)도 가장 가까운 스텝으로 표시된다(값 자체는 유지)", () => {
    render(
      h(function Wrap() {
        const [state, setState] = useState<EditorState>({
          draft: placedDraft(),
          tactics: { line: 0.6, press: 0.5, tempo: 0.5, width: 0.5 },
          teamPrompt: "",
        });
        return h(DeckEditor, {
          state,
          onChange: setState,
          aiManaged: false,
          onToggleAi: () => {},
          players: PLAYERS,
          playersById: byId,
        });
      }),
    );
    expect(screen.getByTestId("tactics-line-step-2").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("tactics-line").getAttribute("data-value")).toBe("0.6");
  });

  it("AI에 맡기기면 스텝이 비활성화된다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("tactics-ai-toggle"));
    expect((screen.getByTestId("tactics-press-step-3") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("tactics-ai-note")).toBeTruthy();
  });

  it("팀 한마디는 그대로 유지된다", () => {
    renderSheet(placedDraft());
    expect(screen.getByTestId("editor-team-prompt")).toBeTruthy();
  });
});

describe("⑦ r1 — 배치 직후 토큰 1탭이면 그 선수 지시가 열린다", () => {
  it("탭 배치 → 토큰 1탭 → 레일은 그 선수(팀 지시로 튕기지 않는다) + 모바일 독이 펼쳐진다", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    fireEvent.click(screen.getByTestId("pick-MF1")); // 배치
    fireEvent.click(screen.getByTestId("board-slot-starter-6")); // 그 토큰 1탭
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("player");
    expect(screen.getByTestId("rail-title").textContent).toBe("미드필더");
    expect(screen.getByTestId("rail-dock").getAttribute("data-open")).toBe("true");
  });

  it("해제는 보드 바 [선택 해제] 또는 레일 × 로 한다", () => {
    renderSheet(placedDraft());
    expect(screen.queryByTestId("select-clear")).toBeNull();
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    fireEvent.click(screen.getByTestId("select-clear"));
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("team");
    expect(screen.queryByTestId("select-clear")).toBeNull();
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
