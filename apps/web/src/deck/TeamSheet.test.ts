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

  // R3b C: 역할은 **배타 선택**이라 radiogroup/radio 시맨틱이다(toggle 버튼 aria-pressed 아님).
  it("역할은 라디오 세그먼트(4종) — 누르면 checked 가 옮겨간다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9")); // FW1 (프롬프트 없음)
    fireEvent.click(screen.getByTestId("rail-tune-toggle")); // #244: 역할·칩은 ⚙ 뒤
    expect(screen.getByTestId("rail-role").getAttribute("role")).toBe("radiogroup");
    expect(screen.getByTestId("rail-role-balanced").getAttribute("role")).toBe("radio");
    expect(screen.getByTestId("rail-role-balanced").getAttribute("aria-checked")).toBe("true");
    fireEvent.click(screen.getByTestId("rail-role-attack"));
    expect(screen.getByTestId("rail-role-attack").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("rail-role-balanced").getAttribute("aria-checked")).toBe("false");
    // 세부 지시 칩은 다중 토글이라 aria-pressed 를 유지한다(둘을 섞지 않는다).
    expect(screen.getByTestId("rail-chip-press").getAttribute("aria-pressed")).toBe("false");
  });

  it("역할·칩이 미리보기 문장에 즉시 반영된다(칩은 카탈로그 순서)", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    fireEvent.click(screen.getByTestId("rail-tune-toggle")); // #244: 역할·칩은 ⚙ 뒤
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
    fireEvent.click(screen.getByTestId("rail-tune-toggle")); // #244: 역할·칩은 ⚙ 뒤
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
    fireEvent.click(screen.getByTestId("rail-tune-toggle")); // #244: 역할·칩은 ⚙ 뒤
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
    fireEvent.click(screen.getByTestId("rail-tune-toggle")); // #244: 역할·칩은 ⚙ 뒤
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
    fireEvent.click(screen.getByTestId("team-tune-toggle")); // #244: 다이얼은 ⚙ 뒤
    for (const key of ["line", "press", "tempo", "width"]) {
      const group = screen.getByTestId(`tactics-${key}`);
      expect(group.tagName).not.toBe("INPUT");
      expect(group.querySelectorAll("button")).toHaveLength(5);
      expect(group.getAttribute("role")).toBe("radiogroup");
      expect(screen.getByTestId(`tactics-${key}-step-2`).getAttribute("aria-checked")).toBe("true");
    }
  });

  it("스텝을 누르면 계약값이 0/.25/.5/.75/1 로 나간다", () => {
    const get = renderCapturing();
    fireEvent.click(screen.getByTestId("team-tune-toggle")); // #244: 다이얼은 ⚙ 뒤
    fireEvent.click(screen.getByTestId("tactics-press-step-3"));
    expect(get().tactics.press).toBe(0.75);
    fireEvent.click(screen.getByTestId("tactics-line-step-0"));
    expect(get().tactics.line).toBe(0);
    fireEvent.click(screen.getByTestId("tactics-width-step-4"));
    expect(get().tactics.width).toBe(1);
    // 나머지 축은 건드리지 않는다
    expect(get().tactics.tempo).toBe(0.5);
  });

  /**
   * R3a m2 — 이 테스트는 원래 "0.6 도 가장 가까운 스텝(보통)이 **눌린 것으로** 표시된다"를 박제했는데,
   * 그게 곧 팀 레이어의 표시(0.5)≠전송(0.6) 이었다. 계약을 정직한 표기로 갱신한다:
   * 눌림이 아니라 **근사 표시**(어느 스텝도 checked 아님 + 실제 값 배지), 값은 그대로 0.6.
   *
   * R3b C — 예전엔 가장 가까운 스텝에 `aria-pressed="mixed"` 를 줬다. SR 은 mixed 를 "부분적으로
   * 눌림"(체크박스 3-state)으로 읽어 "값이 단계 사이"라는 실제 의미와 어긋났고, radio 롤은 mixed 를
   * 지원하지도 않는다 → `aria-checked=false` + 상태를 **말로** 설명하는 aria-label + aria-describedby.
   */
  it("서버에서 온 중간값(0.6)은 눌림이 아니라 근사로 표시되고 실제 값을 노출한다", () => {
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
    fireEvent.click(screen.getByTestId("team-tune-toggle")); // #244: 다이얼은 ⚙ 뒤
    // 표시 = 전송: 어느 스텝도 선택 상태가 아니고, 가장 가까운 스텝이 근사로만 표시된다
    for (let i = 0; i < 5; i++) {
      expect(screen.getByTestId(`tactics-line-step-${i}`).getAttribute("aria-checked")).toBe("false");
    }
    expect(screen.getByTestId("tactics-line-step-2").getAttribute("aria-label")).toContain("단계 사이");
    // 근사 배지가 그룹의 설명으로 연결돼 SR 이 "왜 아무것도 안 눌렸는지"를 듣는다
    expect(screen.getByTestId("tactics-line").getAttribute("aria-describedby")).toBe("tactics-line-approx");
    expect(screen.getByTestId("tactics-line").getAttribute("data-approx")).toBe("true");
    expect(screen.getByTestId("tactics-line-approx").textContent).toContain("0.6");
    // 값 자체는 사용자가 누르기 전까지 그대로다(정규화 금지)
    expect(screen.getByTestId("tactics-line").getAttribute("data-value")).toBe("0.6");
    // 정확한 스텝값인 다른 축은 근사 표시가 없다(잡음 금지)
    expect(screen.getByTestId("tactics-press").getAttribute("data-approx")).toBe("false");
    expect(screen.queryByTestId("tactics-press-approx")).toBeNull();
  });

  it("AI에 맡기기면 스텝이 비활성화된다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("team-tune-toggle")); // #244: 다이얼은 ⚙ 뒤
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
  it("탭 배치 → 토큰 1탭 → 레일은 그 선수(팀 지시로 튕기지 않는다)", () => {
    renderSheet();
    fireEvent.click(screen.getByTestId("board-slot-starter-6"));
    fireEvent.click(screen.getByTestId("pick-MF1")); // 배치
    fireEvent.click(screen.getByTestId("board-slot-starter-6")); // 그 토큰 1탭
    expect(screen.getByTestId("directive-rail").getAttribute("data-mode")).toBe("player");
    expect(screen.getByTestId("rail-title").textContent).toBe("미드필더");
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

/**
 * ⑥ 빈 상태 (#106 R3b A) — 선발 0/11 첫 진입.
 * 피치가 "+" 11개짜리 무언의 격자라 무엇부터 해야 하는지가 없었다. 보드가 직접 말한다.
 */
describe("⑥ 빈 상태 — 선발 0/11", () => {
  function renderEmpty(opts: { onAuto?: () => void; autoDisabled?: boolean; autoHint?: string } = {}) {
    function Wrap() {
      const [state, setState] = useState(initialState());
      return h(DeckEditor, {
        state,
        onChange: setState,
        aiManaged: false,
        onToggleAi: () => {},
        players: PLAYERS,
        playersById: byId,
        ...opts,
      });
    }
    return render(h(Wrap));
  }

  it("보드 중앙 안내 + 시트 바 3지표가 모두 0", () => {
    renderEmpty();
    expect(screen.getByTestId("board-empty-hint").textContent).toContain("슬롯을 눌러");
    expect(screen.getByTestId("team-sheet-bar").getAttribute("data-empty")).toBe("true");
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 0/11");
    expect(screen.getByTestId("bench-count").textContent).toBe("벤치 0/7");
    expect(screen.getByTestId("directive-count").textContent).toContain("지시 0/11");
  });

  /**
   * ⚠️ **#455 A3 로 이 자리의 버튼이 바뀌었다** — 빈 상태 전용 CTA(`board-empty-auto`)는 없고,
   * 손잡이는 경기장 우측 하단 하나(`auto-fill`)뿐이다. 재는 성질은 그대로다: **빈 덱에서
   * 보드 안에 있고 눌린다**(첫 진입 = 정확히 이 손잡이가 필요한 화면).
   */
  it("자동 채우기가 보드 안에 있고 눌린다", () => {
    let calls = 0;
    renderEmpty({ onAuto: () => calls++ });
    const cta = screen.getByTestId("auto-fill");
    expect(screen.getByTestId("board-card").contains(cta)).toBe(true);
    // 구 3곳은 되살아나지 않았다(같은 `onAuto` 를 셋이 그리던 상태로 되돌리는 변이를 문다).
    expect(screen.queryByTestId("board-empty-auto")).toBeNull();
    expect(screen.queryByTestId("auto-fill-top")).toBeNull();
    fireEvent.click(cta);
    expect(calls).toBe(1);
  });

  it("보유 선수 < 11 이면 CTA 는 비활성이지만 직접 배치 길이 열려 있다(막다른 길 금지)", () => {
    renderEmpty({ onAuto: () => {}, autoDisabled: true, autoHint: "보유 선수 부족 (5/11)" });
    expect((screen.getByTestId("auto-fill") as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByTestId("board-empty-note").textContent).toContain("직접 배치");
    // 슬롯은 여전히 눌린다 → 탭-투-플레이스로 한 명 넣으면 안내가 사라진다.
    fireEvent.click(screen.getByTestId("board-slot-starter-0"));
    fireEvent.click(screen.getByTestId("pick-GK1"));
    expect(screen.queryByTestId("board-empty")).toBeNull();
    expect(screen.getByTestId("team-sheet-bar").getAttribute("data-empty")).toBe("false");
  });

  it("선발이 하나라도 있으면 안내는 뜨지 않는다", () => {
    renderSheet(placedDraft());
    expect(screen.queryByTestId("board-empty")).toBeNull();
  });
});

/**
 * ⑥ **자동 채우기 = 손잡이 하나** (#455 A3).
 *
 * e2e(`p455-a3-auto-fill.spec.ts`)가 실화면·히트테스트로 재는 것과 **다른 축**을 여기서 문다:
 * 저쪽은 "폰/데스크탑 실화면에서 하나이고 닿나", 여기는 **prop 조합별 분기**다. 특히
 * `placementLocked`(감독시간) 가드는 e2e 로 재려면 감독시간 목 한 벌이 필요해서, 그 한 줄을
 * 지우는 변이가 덱·경기전 스펙에서는 **살아남는다**(그 화면들은 잠금이 아니다).
 */
describe("⑥ 자동 채우기 — 하나 · 빈칸이 있을 때만", () => {
  /** 선발 11 + 벤치 앞 3칸 = 이 화면에 "채워야 할 칸"이 없는 덱. */
  const fullDraft = (): DeckDraft => ({
    formation: "4-4-2",
    slots: [
      ...Array.from({ length: 11 }, (_, i) => ({
        playerId: `S${i}`, role: "starter" as const, slotIndex: i, promptText: null,
      })),
      ...Array.from({ length: 3 }, (_, i) => ({
        playerId: `B${i}`, role: "bench" as const, slotIndex: i, promptText: null,
      })),
    ],
  });

  function renderWith(draft: DeckDraft, opts: Record<string, unknown> = {}) {
    return render(
      h(function Wrap() {
        const [state, setState] = useState(initialState(draft));
        return h(DeckEditor, {
          state,
          onChange: setState,
          aiManaged: false,
          onToggleAi: () => {},
          players: PLAYERS,
          playersById: byId,
          onAuto: () => {},
          ...opts,
        });
      }),
    );
  }

  it("빈칸이 없으면 손잡이가 **없다** (disabled 가 아니라 부재)", () => {
    renderWith(fullDraft());
    // 앵커 — 화면은 그려졌다(공허한 null 단언 금지).
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 11/11");
    expect(screen.queryByTestId("auto-fill")).toBeNull();
  });

  it("벤치 **4번째** 칸이 비는 것은 빈칸이 아니다 (hero 확정: 앞 3칸)", () => {
    // 앞 3칸이 찬 상태 = 위와 같은 덱. 4~7번째가 빈 것은 이 덱의 성질 그 자체다.
    const d = fullDraft();
    expect(d.slots.filter((s) => s.role === "bench")).toHaveLength(3);
    renderWith(d);
    expect(screen.queryByTestId("auto-fill")).toBeNull();
  });

  it("벤치 **3번째** 칸이 비면 손잡이가 있다 (경계의 반대편)", () => {
    const d = fullDraft();
    d.slots = d.slots.filter((s) => !(s.role === "bench" && s.slotIndex === 2));
    renderWith(d);
    expect(screen.getByTestId("auto-fill")).toBeTruthy();
  });

  it("배치 잠금(감독시간)이면 `onAuto` 를 줘도 손잡이가 없다", () => {
    renderWith(emptyDraft("4-4-2"), { placementLocked: true });
    // 앵커 — 잠긴 화면도 보드는 그린다(부재 단언이 "안 그려졌다"로 통과하지 않게).
    expect(screen.getByTestId("board-card")).toBeTruthy();
    expect(screen.queryByTestId("auto-fill")).toBeNull();
  });

  it("`onAuto` 가 없으면(그 화면의 기능이 아니면) 손잡이가 없다", () => {
    renderSheet(emptyDraft("4-4-2")); // Harness 는 onAuto 를 안 넘긴다
    expect(screen.queryByTestId("auto-fill")).toBeNull();
  });
});

/**
 * ⑦ 색각 대응 (#106 R3b B) — 컨디션 3단계가 **색으로만** 갈리지 않는다.
 * 색과 독립인 축: 바늘 각도 + 링 파선 + (리스트 행) 글자.
 */
describe("⑦ 컨디션 — 색 외 축", () => {
  it("리스트 행: 등급이 글자로도 읽힌다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("pool-sheet-open")); // #244: 리스트는 시트 뒤
    expect(screen.getByTestId("pick-cond-tier-FW1").textContent).toBe("최상"); // 0.9
    expect(screen.getByTestId("pick-cond-tier-MF1").textContent).toBe("보통"); // 0.5
  });

  it("리스트·보드 토큰 모두 등급을 data 축으로 노출한다(색 아님)", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("pool-sheet-open")); // #244: 리스트는 시트 뒤
    expect(screen.getByTestId("pick-cond-FW1").getAttribute("data-condition-tier")).toBe("high");
    expect(screen.getByTestId("token-clock-MF1").getAttribute("data-condition-tier")).toBe("mid");
  });

  it("레일 헤드는 컨디션을 글자로 말한다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9")); // FW1 0.9
    expect(screen.getByTestId("rail-subtitle").textContent).toContain("컨디션 최상");
  });
});

/** ⑧ a11y 골격 (#106 R3b C) */
describe("⑧ a11y", () => {
  it("세부조정 토글이 여는 대상을 aria-controls 로 가리킨다(#244 — 구: 독 토글)", () => {
    renderSheet(placedDraft());
    const toggle = screen.getByTestId("team-tune-toggle");
    expect(toggle.getAttribute("aria-controls")).toBe("team-tactics-panel");
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    fireEvent.click(toggle);
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("team-tactics-panel")).toBeTruthy();
  });

  it("문장 이동 알림 라이브 리전은 **내용이 오기 전에** 이미 DOM 에 있다", () => {
    renderSheet(placedDraft());
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    const live = screen.getByTestId("rail-moved-live");
    // 알림이 아직 없어도 리전 자체는 존재한다(등록 후 텍스트만 갈아끼워야 SR 이 읽는다).
    expect(live.getAttribute("role")).toBe("status");
    expect(live.getAttribute("aria-live")).toBe("polite");
    expect(live.textContent).toBe("");
    expect(screen.queryByTestId("rail-moved")).toBeNull();
  });
});
