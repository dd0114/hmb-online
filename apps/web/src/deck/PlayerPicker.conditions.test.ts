// @vitest-environment jsdom
/**
 * 요구 6(이슈 #98) — 선수 리스트에 **컨디션 표시**. 스탯총량(종합) 옆에 ConditionClock 이 붙고,
 * 값이 없으면(로딩/미응답/미보유) 시계 없이도 행이 정상 렌더돼야 한다(graceful).
 *
 * 작성 규칙: root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { DndContext } from "@dnd-kit/core";
import { afterEach, describe, expect, it } from "vitest";
import { PlayerPicker } from "./PlayerPicker";
import { emptyDraft } from "./deck-logic";
import type { CatalogPlayer } from "../api/hooks";

const attrs = (v: number) => ({
  technical: v, mental: v, physical: v, passing: v, shooting: v,
  tackling: v, pace: v, stamina: v, positioning: v,
});

const players: CatalogPlayer[] = [
  { id: "P1", name: "골리", position: "GK", grade: "SILVER", owned: true, ownedCount: 1, attributes: attrs(70) },
  { id: "P2", name: "공격수", position: "FW", grade: "GOLD", owned: true, ownedCount: 1, attributes: attrs(80) },
] as unknown as CatalogPlayer[];

function renderPicker(conditions?: Record<string, number>) {
  return render(
    h(DndContext, null, h(PlayerPicker, { players, draft: emptyDraft(), onPick: () => {}, conditions })),
  );
}

afterEach(cleanup);

describe("PlayerPicker 컨디션 표시", () => {
  it("컨디션 맵이 있으면 각 행에 시계(값 포함)를 렌더한다", () => {
    renderPicker({ P1: 0.82, P2: 0.17 });
    expect(screen.getByTestId("pick-cond-P1").getAttribute("data-condition")).toBe("0.82");
    expect(screen.getByTestId("pick-cond-P2").getAttribute("data-condition")).toBe("0.17");
    // 스탯총량은 그대로(회귀 없음)
    expect(screen.getByTestId("pick-overall-P2").textContent).toBe("80");
  });

  it("컨디션 맵이 없으면 시계 없이 렌더된다(로딩/미응답 graceful)", () => {
    renderPicker(undefined);
    expect(screen.queryByTestId("pick-cond-P1")).toBeNull();
    expect(screen.getByTestId("pick-overall-P1").textContent).toBe("70");
  });

  it("일부 선수만 값이 있어도 해당 행만 시계를 렌더한다", () => {
    renderPicker({ P2: 0.5 });
    expect(screen.queryByTestId("pick-cond-P1")).toBeNull();
    expect(screen.getByTestId("pick-cond-P2").getAttribute("data-condition")).toBe("0.50");
  });
});
