// @vitest-environment jsdom
/**
 * 도감 카드 — **비활성 표기 "off"** 계약 (#207 U-D7).
 *
 * 왜 이 표기가 필요한가: 비활성 유닛은 가챠 풀·트레이드 타깃에서 빠지지만 **보유분은 도감에
 * 계속 내려온다**(카드를 뺏지 않는 정책). 표기가 없으면 "도감에 있는데 아무리 뽑아도 안
 * 나온다 = 버그인가?"가 된다. hero 지시대로 배지 디자인 논의 없이 **텍스트 "off"** 만.
 *
 * .test.ts + createElement (root vitest include = apps/**\/*.test.ts).
 */
import { createElement as h } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PlayerCard } from "./PlayerCard";
import { resetCharAssetsCache } from "../common/char-assets-store";
import type { CatalogPlayer } from "../api/hooks";

const ATTRS = {
  technical: 70,
  mental: 70,
  physical: 70,
  passing: 70,
  shooting: 70,
  tackling: 70,
  pace: 70,
  stamina: 70,
  positioning: 70,
};

function player(over: Partial<CatalogPlayer> = {}): CatalogPlayer {
  return {
    id: "P001",
    name: "Lev Yashin",
    position: "GK",
    grade: "LEGEND",
    attributes: ATTRS,
    owned: true,
    ownedCount: 1,
    ...over,
  } as CatalogPlayer;
}

function renderCard(p: CatalogPlayer) {
  resetCharAssetsCache();
  // 에셋 번들은 이 계약과 무관 — 네트워크를 죽여 CSS 폴백으로 고정한다.
  vi.stubGlobal("fetch", vi.fn(async () => {
    throw new Error("offline");
  }));
  return render(h(PlayerCard, { player: p, expanded: false, onToggle: () => {} }));
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("비활성 표기 'off' (#207 U-D7)", () => {
  it("보유 중인 비활성 카드에 'off' 를 붙인다", () => {
    renderCard(player({ id: "P001", active: false, owned: true }));
    const off = screen.getByTestId("codex-off-P001");
    expect(off.textContent).toBe("off"); // 텍스트 그대로 — 배지 디자인 없음
  });

  it("활성 카드에는 안 붙는다", () => {
    renderCard(player({ id: "P173", active: true }));
    expect(screen.queryByTestId("codex-off-P173")).toBeNull();
  });

  it("`active` 가 없는 응답(구 서버·additive 이전)에도 안 붙는다 — 무회귀", () => {
    const p = player({ id: "P050" });
    delete (p as { active?: boolean }).active;
    renderCard(p);
    expect(screen.queryByTestId("codex-off-P050")).toBeNull();
  });

  it("보유수 표기와 공존한다(둘 다 보인다)", () => {
    renderCard(player({ id: "P002", active: false, owned: true, ownedCount: 3 }));
    expect(screen.getByTestId("codex-off-P002")).toBeTruthy();
    expect(screen.getByText("×3")).toBeTruthy();
  });

  it("미보유 비활성(서버 필터를 통과해 흘러온 경우)에도 잠금과 함께 보인다", () => {
    // 서버가 미보유 비활성을 걸러 내려주는 것이 계약이지만, 클라가 그 전제에 의존해
    // **표기를 빼먹지는 않는다** — 흘러오면 그대로 보여야 진단이 된다.
    renderCard(player({ id: "P003", active: false, owned: false }));
    expect(screen.getByTestId("codex-off-P003")).toBeTruthy();
    expect(screen.getByTitle("미보유")).toBeTruthy();
  });
});
