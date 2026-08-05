// @vitest-environment jsdom
/**
 * #442 R1 — **엔트리 동선**(목록 [엔트리] → "명단에서 바꿀 선수를 선택하세요" → 슬롯 탭) 계약.
 *
 * hero 설계: *"선수목록 들어가서 선수를 누르면 투입을 누를수 있고, 투입 누르면 '교체할 선수를
 * 선택해주세요' 하고 후보군과 선발군 활성화되게하자."*
 *
 * ⚠️ **용어는 R3-A 에서 바뀌었다**(hero: *"엔트리나, 명단으로 사용하자. 투입이랑 교체 대신 그
 * 단어가 맞는거 같아."*). 위 원문의 "투입"·"교체"는 **설계 인용이지 화면 문구가 아니다** —
 * 화면은 [엔트리] / "명단에서 바꿀 선수를 선택하세요" 다. 라벨 계약이 아래에 리터럴로 박혀 있다.
 *
 * 실화면·실터치 판정은 `e2e/p442-phone-substitution.spec.ts` 가 한다(폰 뷰포트 + 터치 이벤트는
 * jsdom 이 원리적으로 못 잰다). 여기서 박는 것은 **상태 기계와 후보 경계** — 특히 마지막 것:
 *
 *   ⛔ **경기전(`poolScope="bench"`)에서 이 동선이 R2 의 뒷문이 되면 안 된다.**
 *      후보 산출은 `poolPlayers` 하나뿐이어야 한다 — [엔트리]가 별도 규칙으로 후보를 다시 뽑으면
 *      그 순간 같은 판정이 두 곳에 적힌다(#439 major-2 가 정확히 그렇게 났다).
 *
 *   ⛔ **R3-B 잠금이 그 규칙을 스코프별로 갈라 놓는다** — "이미 명단에 있나"의 답이 화면마다
 *      다르기 때문이다(덱셋팅 = 덱에 자리가 있나 / 경기전 = 선발인가). 그래서 판정은
 *      `poolScope` 를 아는 `DeckEditor` **한 곳**(`assignLockedIds`)에서만 나오고, 아래 계약이
 *      **경기전 벤치 선수가 열려 있는지**를 같이 잰다 — 거기서 틀리면 R2 동선이 통째로 죽는다.
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
  /** 벤치 — 경기전에 엔트리로 올릴 수 있는 유일한 부류. */
  P("FW2", "교체공격수", "FW", 74),
  /** 스쿼드 밖 — 경기전에는 목록에도 [엔트리]에도 없어야 한다. */
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

/** 목록 시트를 열고 그 선수의 [엔트리]를 누른다. */
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

/** 그 선수의 [엔트리] 버튼(시트가 열려 있어야 한다). */
const assignBtn = (playerId: string) =>
  screen.getByTestId(`pool-assign-${playerId}`) as HTMLButtonElement;

afterEach(cleanup);

/**
 * ⚠️ **상태기계 계약은 `bench`(경기전) 스코프에서 잰다.** 주인공 FW2 는 벤치 선수라 R3-B 가
 * **덱셋팅에서는 잠근다**(이미 덱에 있다) — 상태기계 자체는 스코프와 무관하므로 **손잡이가 열려
 * 있는 쪽**에서 재는 것이 맞다. 그리고 이 동선을 hero 가 요구한 자리가 경기전이다.
 *
 * ⚠️ 주인공을 "덱셋팅 + 미배치 선수(FW9)"로 바꾸면 **계약의 뜻이 달라진다** — 풀에서 찬 자리로
 * 가는 것은 스왑이 아니라 **점유자 드롭**이라(`tactics-logic.movePlayerToSlot` 머리말) "밀려난
 * 선수가 스쿼드에서 사라지지 않는다"를 잴 수 없다. 덱셋팅 갈래는 아래 R3-B 블록과
 * e2e ⑤(미배치 FW4 → 빈 슬롯)가 덮는다.
 */
describe("#442 R1 — 엔트리 대기 상태", () => {
  it("[엔트리] 를 누르면 시트가 닫히고 '명단에서 바꿀 선수를 선택하세요' 가 뜬다", () => {
    render_("bench");
    startAssign("FW2");
    expect(screen.queryByTestId("pool-sheet")).toBeNull();
    expect(screen.getByTestId("assign-bar").textContent).toContain("명단에서 바꿀 선수를 선택하세요");
    expect(screen.getByTestId("assign-bar").textContent).toContain("교체공격수");
  });

  it("선발군 + 후보군 슬롯이 **전부** 대상이 된다(빈 자리 = 배치 · 찬 자리 = 맞바꾸기)", () => {
    render_("bench");
    expect(assignTargets(), "대기 전에는 대상이 하나도 없다").toEqual([]);
    startAssign("FW2");
    const t = assignTargets();
    expect(t.filter((x) => x.startsWith("board-slot-starter-"))).toHaveLength(11);
    expect(t.filter((x) => x.startsWith("board-slot-bench-"))).toHaveLength(7);
  });

  it("취소하면 대상 표시가 사라지고, 그 뒤 슬롯을 눌러도 자리가 바뀌지 않는다", () => {
    render_("bench");
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
  it("찬 자리를 누르면 **맞바꾸기**다 — 밀려난 선수는 올라온 선수가 있던 자리로 간다", () => {
    render_("bench");
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));

    expect(occupantOf("starter", 9)).toBe("FW2");
    expect(occupantOf("bench", 0), "밀려난 선발이 스쿼드에서 사라지면 안 된다").toBe("FW1");
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 4/11");
    expect(screen.queryByTestId("assign-bar"), "자리가 정해지면 대기 상태도 끝난다").toBeNull();
  });

  it("빈 자리를 누르면 **배치**다 — 아무도 밀려나지 않는다", () => {
    render_("bench");
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("board-slot-starter-10"));

    expect(occupantOf("starter", 10)).toBe("FW2");
    expect(occupantOf("starter", 9), "원래 있던 선수는 그대로다").toBe("FW1");
    expect(occupantOf("bench", 0), "올라온 선수가 떠난 자리만 빈다").toBeNull();
    expect(screen.getByTestId("starter-count").textContent).toBe("선발 5/11");
  });

  it("프롬프트는 선수를 따라간다(맞바꾸기가 지시를 지우지 않는다)", () => {
    render_("bench");
    startAssign("FW2");
    fireEvent.click(screen.getByTestId("board-slot-starter-9"));
    // 배치 뒤 레일은 올린 선수를 본다 — 그 선수의 문장이 그대로여야 한다.
    expect((screen.getByTestId("rail-prompt-input") as HTMLTextAreaElement).value).toBe("측면을 넓게");
  });
});

describe("#442 R1 — R2(경기전 = 벤치만) 의 뒷문이 아니다", () => {
  it("경기전 시트에서 [엔트리] 는 **벤치 선수에게만** 있다", () => {
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

  it("덱셋팅(대조군)은 보유 전원에게 [엔트리] 가 있다 — 규칙은 후보 목록이 하나 정한다", () => {
    render_("owned");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    const offered = [...document.querySelectorAll('[data-testid^="pool-assign-"]')].map((e) =>
      e.getAttribute("data-testid")!.replace("pool-assign-", ""),
    );
    expect([...offered].sort()).toEqual([...PLAYERS.map((p) => p.id)].sort());
  });
});

/**
 * #442 R3-A — **용어**(hero: *"엔트리나, 명단으로 사용하자. 투입이랑 교체 대신 그 단어가 맞는거
 * 같아."*). 라벨은 리터럴로 박는다 — 상수를 import 하면 상수를 바꾸는 변이가 통과한다
 * (`apps/web/CLAUDE.md` "초록으로 거짓말하는 방식" ②).
 */
describe("#442 R3-A — 용어는 엔트리 / 명단이다", () => {
  it("행 버튼 라벨이 '엔트리' 다", () => {
    render_("owned");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    expect(assignBtn("FW9").textContent).toBe("엔트리");
  });

  it("안내 배너에 '투입'·'교체' 가 남아 있지 않다", () => {
    render_("bench");
    startAssign("FW2");
    const bar = screen.getByTestId("assign-bar").textContent ?? "";
    expect(bar).toContain("명단에서 바꿀 선수를 선택하세요");
    expect(bar, "구 용어가 한 글자도 남으면 안 된다").not.toMatch(/투입|교체할/);
  });
});

/**
 * #442 R3-B — **이미 명단에 있는 선수는 [엔트리] 가 잠긴다**
 * (hero: *"투입 가능한 선수들만 옆에 띄우거나 이미 있는 선수는 버튼 비활성화 된 모습으로 보이게하자."*
 *  — 숨기기가 아니라 **비활성화** 쪽을 택했다: 행이 사라지면 목록의 선수 수가 화면마다 달라져
 *  스캔이 어렵고, 바로 위 대조군 계약("보유 전원에게 손잡이가 있다")의 취지도 유지된다).
 *
 * ⚠️ **"명단"이 화면마다 다른 것이 이 계약의 전부다** — 덱셋팅은 덱(선발+후보), 경기전은 선발이다.
 * 경기전 후보는 **전원이 벤치 선수**라, 여기서 "자리를 가졌나"로 판정하면 **전부 잠겨 R2 동선이
 * 통째로 죽는다**. 그래서 마지막 계약이 그 갈래를 직접 잰다.
 *
 * ⚠️ **행 본문 탭(`onPick`)은 잠그지 않는다** — 잠그면 지시 대상 전환·[이 자리 선수 바꾸기]
 * 동선이 같이 죽는다(기존 계약 7건이 그 위에 서 있다). 잠기는 것은 **버튼 하나**다.
 */
describe("#442 R3-B — 이미 명단에 있는 선수는 [엔트리] 가 잠긴다", () => {
  it("덱셋팅 — 덱에 자리가 있는 선수는 비활성, 미배치 선수는 활성", () => {
    render_("owned");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    // 선발 4명 + 벤치 1명 = 덱에 있다 → 잠김.
    for (const id of ["GK1", "DF1", "MF1", "FW1", "FW2"]) {
      expect(assignBtn(id).disabled, `${id} 는 이미 덱에 있다`).toBe(true);
    }
    // 스쿼드 밖 = 지금 엔트리에 넣을 수 있는 유일한 선수.
    expect(assignBtn("FW9").disabled, "미배치 선수는 열려 있어야 한다").toBe(false);
  });

  it("잠긴 버튼은 눌러도 대기 상태로 들어가지 않는다", () => {
    render_("owned");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    fireEvent.click(assignBtn("FW1"));
    expect(screen.queryByTestId("assign-bar"), "잠금이 라벨뿐이면 여기서 죽는다").toBeNull();
    expect(screen.getByTestId("pool-sheet"), "시트도 그대로 열려 있다").toBeTruthy();
  });

  it("행 본문 탭은 잠기지 않는다 — 배치된 선수도 지시 대상으로 고를 수 있다", () => {
    render_("owned");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    expect((screen.getByTestId("pick-MF1") as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByTestId("pick-MF1"));
    expect((screen.getByTestId("rail-prompt-input") as HTMLTextAreaElement).value).toBe("안쪽으로");
  });

  it("⛔ 경기전 — 벤치 선수는 선발 명단에 아직 없다 → 잠기지 않는다", () => {
    render_("bench");
    fireEvent.click(screen.getByTestId("pool-sheet-open"));
    expect(
      assignBtn("FW2").disabled,
      "여기서 잠기면 경기전 엔트리 동선(R2)이 통째로 죽는다",
    ).toBe(false);
  });
});
