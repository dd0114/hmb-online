// @vitest-environment jsdom
/**
 * #442 R1 — **투입 동선**(목록 [투입] → "교체할 선수를 선택해주세요" → 슬롯 탭) 계약.
 *
 * hero 설계: *"선수목록 들어가서 선수를 누르면 투입을 누를수 있고, 투입 누르면 '교체할 선수를
 * 선택해주세요' 하고 후보군과 선발군 활성화되게하자."*
 *
 * 실화면·실터치 판정은 `e2e/p442-phone-substitution.spec.ts` 가 한다(폰 뷰포트 + 터치 이벤트는
 * jsdom 이 원리적으로 못 잰다). 여기서 박는 것은 **상태 기계와 후보 경계** — 특히 마지막 것:
 *
 *   ⛔ **경기전(`poolScope="bench"`)에서 이 동선이 R2 의 뒷문이 되면 안 된다.**
 *      후보 산출은 `poolPlayers` 하나뿐이어야 한다 — [투입]이 별도 규칙으로 후보를 다시 뽑으면
 *      그 순간 같은 판정이 두 곳에 적힌다(#439 major-2 가 정확히 그렇게 났다).
 *
 * 작성 규칙: root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h, useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { DeckEditor } from "./DeckEditor";
import { DEFAULT_TEAM_TACTICS, type EditorState } from "./tactics-logic";
import type { DeckDraft } from "./deck-logic";
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
  P("FW1", "공격수", "FW", 88),
  /** 벤치 — 경기전에 투입 가능한 유일한 부류. */
  P("FW2", "교체공격수", "FW", 74),
  /** 스쿼드 밖 — 경기전에는 목록에도 [투입]에도 없어야 한다. */
  P("FW9", "외부공격수", "FW", 92),
];
const byId = new Map(PLAYERS.map((p) => [p.id, p]));

/** 선발 4(0·3·6·9) + 벤치 1 — 빈 자리가 남아 있어 "빈 슬롯 = 배치"도 같이 잰다. */
const draft = (): DeckDraft => ({
  formation: "4-4-2",
  slots: [
    { playerId: "GK1", role: "starter", slotIndex: 0, promptText: null },
    { playerId: "DF1", role: "starter", slotIndex: 3, promptText: null },
    { playerId: "MF1", role: "starter", slotIndex: 6, promptText: "안쪽으로" },
    { playerId: "FW1", role: "starter", slotIndex: 9, promptText: null },
    { playerId: "FW2", role: "bench", slotIndex: 0, promptText: "측면을 넓게" },
  ],
});

function Harness({ poolScope }: { poolScope?: "owned" | "bench" }) {
  const [state, setState] = useState<EditorState>({
    draft: draft(), tactics: { ...DEFAULT_TEAM_TACTICS }, teamPrompt: "",
  });
  return h(DeckEditor, {
    state,
    onChange: setState,
    aiManaged: false,
    onToggleAi: () => {},
    players: PLAYERS,
    playersById: byId,
    ...(poolScope ? { poolScope } : {}),
  });
}

const render_ = (poolScope?: "owned" | "bench") => render(h(Harness, { poolScope }));

/** 목록 시트를 열고 그 선수의 [투입]을 누른다. */
function startAssign(playerId: string) {
  fireEvent.click(screen.getByTestId("pool-sheet-open"));
  fireEvent.click(screen.getByTestId(`pool-assign-${playerId}`));
}

/** 슬롯 → 그 자리 선수(없으면 null). */
function occupantOf(role: "starter" | "bench", i: number): string | null {
  const cell = screen.getByTestId(`board-slot-${role}-${i}`);
  const tok = cell.querySelector('[data-testid^="token-"]');
  return tok ? tok.getAttribute("data-testid")!.replace("token-", "") : null;
}

const assignTargets = () =>
  [...document.querySelectorAll('[data-assign-target="true"]')].map((e) => e.getAttribute("data-testid")!);

afterEach(cleanup);

describe("#442 R1 — 투입 대기 상태", () => {
  it("[투입] 을 누르면 시트가 닫히고 '교체할 선수를 선택해주세요' 가 뜬다", () => {
    render_();
    startAssign("FW2");
    expect(screen.queryByTestId("pool-sheet")).toBeNull();
    expect(screen.getByTestId("assign-bar").textContent).toContain("교체할 선수를 선택해주세요");
    expect(screen.getByTestId("assign-bar").textContent).toContain("교체공격수");
  });

  it("선발군 + 후보군 슬롯이 **전부** 대상이 된다(빈 자리 = 배치 · 찬 자리 = 교체)", () => {
    render_();
    expect(assignTargets(), "대기 전에는 대상이 하나도 없다").toEqual([]);
    startAssign("FW2");
    const t = assignTargets();
    expect(t.filter((x) => x.startsWith("board-slot-starter-"))).toHaveLength(11);
    expect(t.filter((x) => x.startsWith("board-slot-bench-"))).toHaveLength(7);
  });

  it("취소하면 대상 표시가 사라지고, 그 뒤 슬롯을 눌러도 교체가 일어나지 않는다", () => {
    render_();
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("assign-cancel"));
    expect(screen.queryByTestId("assign-bar")).toBeNull();
    expect(assignTargets()).toEqual([]);

    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    expect(occupantOf("starter", 9), "취소 뒤의 탭은 지시 대상만 바꾼다").toBe("FW1");
    expect(occupantOf("bench", 0)).toBe("FW2");
  });
});

describe("#442 R1 — 슬롯 탭이 하는 일", () => {
  it("찬 자리를 누르면 **교체**다 — 밀려난 선수는 투입 선수가 있던 자리로 간다", () => {
    render_();
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));

    expect(occupantOf("starter", 9)).toBe("FW2");
    expect(occupantOf("bench", 0), "밀려난 선발이 스쿼드에서 사라지면 안 된다").toBe("FW1");
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 4/11");
    expect(screen.queryByTestId("assign-bar"), "교체가 끝나면 대기 상태도 끝난다").toBeNull();
  });

  it("빈 자리를 누르면 **배치**다 — 아무도 밀려나지 않는다", () => {
    render_();
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("board-slot-starter-10"));

    expect(occupantOf("starter", 10)).toBe("FW2");
    expect(occupantOf("starter", 9), "원래 있던 선수는 그대로다").toBe("FW1");
    expect(occupantOf("bench", 0), "투입 선수가 떠난 자리만 빈다").toBeNull();
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 5/11");
  });

  it("프롬프트는 선수를 따라간다(교체가 지시를 지우지 않는다)", () => {
    render_();
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    // 배치 뒤 레일은 투입한 선수를 본다 — 그 선수의 문장이 그대로여야 한다.
    expect((screen.getByTestId("rail-prompt-input") as HTMLTextAreaElement).value).toBe("측면을 넓게");
  });
});

describe("#442 R1 — R2(경기전 = 벤치만) 의 뒷문이 아니다", () => {
  it("경기전 시트에서 [투입] 은 **벤치 선수에게만** 있다", () => {
    render_("bench");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    const offered = [...document.querySelectorAll('[data-testid^="pool-assign-"]')].map((e) =>
      e.getAttribute("data-testid")!.replace("pool-assign-", ""),
    );
    // 벤치는 FW2 하나뿐 — 선발 4명도, 스쿼드 밖 FW9 도 손잡이가 없다.
    expect(offered).toEqual(["FW2"]);
    expect(screen.queryByTestId("pool-assign-FW9")).toBeNull();
    expect(screen.queryByTestId("pool-assign-FW1")).toBeNull();
  });

  it("덱셋팅(대조군)은 보유 전원에게 [투입] 이 있다 — 규칙은 후보 목록이 하나 정한다", () => {
    render_("owned");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    const offered = [...document.querySelectorAll('[data-testid^="pool-assign-"]')].map((e) =>
      e.getAttribute("data-testid")!.replace("pool-assign-", ""),
    );
    expect([...offered].sort()).toEqual([...PLAYERS.map((p) => p.id)].sort());
  });
});
