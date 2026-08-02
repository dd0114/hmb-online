// @vitest-environment jsdom
/**
 * 전술보드 슬롯의 **접근가능 이름** 계약 (#406 W1b — 2차 발견의 회귀 방지).
 *
 * <p>`SlotCell` 의 `aria-label` 분기 조건은 <b>`slot`</b>(자리가 찼나)이지 `player`
 * (카탈로그가 아나)가 아니다. 그 한 글자를 `player` 로 되돌리면 <b>카탈로그가 모르는 선수</b>가
 * 앉은 자리에서 화면은 `미상 선수` 를 그리는데 스크린리더만 <b>"빈 슬롯"</b> 이라고 말한다
 * — `data-filled="true"` 인데도. 같은 상태를 두 가지로 말하는 것이 결함이다.
 *
 * <p>⚠️ 그 수정에 <b>계약이 0건이었다</b>(#406 W1b 3차 지적). 지우거나 되돌려도 죽는 테스트가
 * 없으면 다음 사람이 "왜 `player` 가 아니지?" 하며 조용히 되돌린다.
 *
 * <p>여기서 죽여야 하는 변이 셋:
 * <ol>
 *   <li>분기 조건 `slot` → `player` (미상 선수 자리가 "빈 슬롯"이 된다)</li>
 *   <li>축 `short` → `full` (보이는 라벨과 접근가능 이름이 갈린다 — 표본에 `shortName` 이 있어야 죽는다)</li>
 *   <li>빈 슬롯까지 이름을 붙임 (대조군이 죽인다)</li>
 * </ol>
 *
 * <p>작성 규칙: root vitest include 가 `apps/**\/*.test.ts` 라 JSX 대신 createElement.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { TacticsBoard } from "./TacticsBoard";
import { emptyDraft, type DeckDraft } from "./deck-logic";
import type { CatalogPlayer } from "../api/hooks";

afterEach(cleanup);

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

/**
 * `shortName` 은 openapi 생성 타입에 아직 없다(#411 서버 작업) — 초크포인트가 **구조 판정**으로
 * 읽으므로 표본에는 실어 둔다. 이게 없으면 축 변이(short↔full)가 살아남는다.
 */
const KNOWN = {
  id: "P001", name: "레프 야신", shortName: "야신", position: "GK", grade: "LEGEND",
  owned: true, ownedCount: 1, attributes: attrs(80), personality: "CALM",
} as unknown as CatalogPlayer;

/** 카탈로그가 **모르는** 선수 — 덱에는 앉아 있다(은퇴·미발행·구 스냅샷). */
const UNKNOWN_ID = "P999";

function draftWith(): DeckDraft {
  const base = emptyDraft("4-4-2");
  return {
    ...base,
    slots: [
      { playerId: KNOWN.id, role: "starter", slotIndex: 0, promptText: "" },
      { playerId: UNKNOWN_ID, role: "starter", slotIndex: 1, promptText: "" },
    ] as DeckDraft["slots"],
  };
}

function renderBoard() {
  return render(
    h(TacticsBoard, {
      draft: draftWith(),
      playersById: new Map([[KNOWN.id, KNOWN]]),
      selectedSlot: null,
      selectedPlayerId: null,
      onSlotTap: () => {},
    }),
  );
}

/** 슬롯 버튼 안에서 **화면에 보이는** 이름 조각(토큰 이름줄). */
function visibleName(slotTestId: string): string {
  const cell = screen.getByTestId(slotTestId);
  const token = cell.querySelector("[data-testid^='token-']");
  expect(token, `${slotTestId} 에 토큰이 없다`).toBeTruthy();
  // 토큰 안 첫 텍스트 노드 묶음 중 이름줄 — 번호/포지션과 섞이지 않게 span 을 직접 고른다.
  const spans = [...token!.querySelectorAll("span")].map((s) => s.textContent?.trim() ?? "");
  return spans.find((t) => t === "야신" || t === "레프 야신" || t === "미상 선수") ?? spans.join("|");
}

describe("전술보드 슬롯 — 화면과 aria-label 이 같은 말을 한다 (#406 W1b)", () => {
  it("카탈로그 미상 선수: 보이는 이름도 접근가능 이름도 `미상 선수` 이고, **빈 슬롯이 아니다**", () => {
    renderBoard();
    const cell = screen.getByTestId("board-slot-starter-1");
    // 상태 축 — 자리는 차 있다.
    expect(cell.getAttribute("data-filled")).toBe("true");
    // 화면 축.
    expect(visibleName("board-slot-starter-1")).toBe("미상 선수");
    // 접근가능 이름 축 — 같은 말을 해야 한다.
    const label = cell.getAttribute("aria-label") ?? "";
    expect(label).toContain("미상 선수");
    expect(label).toContain("선발");
    // ★ 변이 ①: 분기를 `player` 로 되돌리면 여기가 "빈 슬롯" 이 된다.
    expect(label).not.toBe("빈 슬롯");
    expect(label).not.toContain("빈 슬롯");
    // playerId 가 새지 않는다(사다리 3단).
    expect(label).not.toContain(UNKNOWN_ID);
  });

  it("카탈로그가 아는 선수: 두 축이 **같은 문자열**이다 — 밀집 UI 라 short", () => {
    renderBoard();
    const cell = screen.getByTestId("board-slot-starter-0");
    const shown = visibleName("board-slot-starter-0");
    // ★ 변이 ②: aria 축을 full 로 바꾸면 `레프 야신` 이 되어 갈린다.
    expect(shown).toBe("야신");
    expect(cell.getAttribute("aria-label")).toBe("야신 — 선발");
  });

  /** 대조군 — 이 단언이 없으면 "모든 슬롯에 이름을 붙인다"는 변이가 통과한다. */
  it("빈 슬롯은 `빈 슬롯` 이라고 말한다(그리고 토큰이 없다)", () => {
    renderBoard();
    const cell = screen.getByTestId("board-slot-starter-2");
    expect(cell.getAttribute("data-filled")).toBe("false");
    expect(cell.getAttribute("aria-label")).toBe("빈 슬롯");
    expect(cell.querySelector("[data-testid^='token-']")).toBeNull();
  });

  /** 벤치도 같은 규칙(역할 문구만 다르다) — 축이 하나라는 것 자체가 계약이다. */
  it("벤치 빈 슬롯도 같은 문구를 쓴다", () => {
    renderBoard();
    expect(screen.getByTestId("board-slot-bench-0").getAttribute("aria-label")).toBe("빈 슬롯");
  });
});
