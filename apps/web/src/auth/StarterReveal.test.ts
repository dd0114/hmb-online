// @vitest-environment jsdom
/**
 * 가입 최상위 지급 연출 (#209 AC3) — 카드가 **덮인 채로 열리고**, 눌러야 공개되며,
 * 공개 전에는 닫히지 않는다(지급을 못 보고 지나치는 경로 0).
 *
 * 지급이 없는 계정(개편 이전 가입)에서는 카드 없이 기존 문구만 뜨고 바로 닫을 수 있어야 한다 —
 * 연출이 없다고 가입 동선이 막히면 안 된다.
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StarterReveal } from "./StarterReveal";
import type { StarterGrantResponse } from "../api/p3";

afterEach(cleanup);

const LEGEND: StarterGrantResponse = {
  granted: true,
  player: {
    id: "P005",
    name: "Diego Maradona",
    position: "MF",
    grade: "LEGEND",
    owned: true,
    ownedCount: 1,
    attributes: {
      technical: 95, mental: 90, physical: 80, passing: 92, shooting: 88,
      tackling: 60, pace: 90, stamina: 82, positioning: 90,
    },
  },
};

function renderReveal(grant: StarterGrantResponse | null | undefined, onClose = vi.fn()) {
  render(h(StarterReveal, { grant, onClose }));
  return onClose;
}

describe("StarterReveal (#209 AC3)", () => {
  it("최상위 지급이 있으면 카드가 덮인 채 열린다", () => {
    renderReveal(LEGEND);
    const card = screen.getByTestId("starter-reveal-card");
    expect(card.getAttribute("data-revealed")).toBe("false");
    // 공개 전에는 선수 이름이 새지 않는다(카드 뒷면 = 이미지 요청도 없다).
    expect(screen.queryByTestId("starter-reveal-grant")).toBeNull();
    expect(screen.queryByTestId("starter-reveal-close")).toBeNull();
  });

  it("카드를 누르면 공개되고 지급 문구가 나온다", () => {
    renderReveal(LEGEND);
    fireEvent.click(screen.getByTestId("starter-reveal-card"));

    expect(screen.getByTestId("starter-reveal-card").getAttribute("data-revealed")).toBe("true");
    const grant = screen.getByTestId("starter-reveal-grant");
    expect(grant.textContent).toContain("Diego Maradona");
    expect(grant.textContent).toContain("15명"); // 기본팩 14 + 최상위 1
  });

  it("공개 전에는 닫히지 않는다 — 확인 버튼도 ESC 도 없다", () => {
    const onClose = renderReveal(LEGEND);
    expect(screen.queryByTestId("starter-reveal-close")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("starter-reveal"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("starter-reveal-open"));
    fireEvent.click(screen.getByTestId("starter-reveal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("지급이 없으면(구 계정·조회 실패) 카드 없이 문구만 — 곧바로 닫을 수 있다", () => {
    const onClose = renderReveal(null);
    expect(screen.queryByTestId("starter-reveal-card")).toBeNull();
    fireEvent.click(screen.getByTestId("starter-reveal-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("granted=false 응답도 지급 없음으로 다룬다", () => {
    renderReveal({ granted: false, player: null });
    expect(screen.queryByTestId("starter-reveal-card")).toBeNull();
    expect(screen.getByTestId("starter-reveal-close")).toBeTruthy();
  });
});
