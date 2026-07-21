// @vitest-environment jsdom
/**
 * PlayerAvatar 렌더 계약 (PRD-v4 §F). root vitest include 가 apps/**\/*.test.ts 라
 * JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { PlayerAvatar } from "./PlayerAvatar";
import { __clearLegendDotAssets, __setLegendDotAsset, type AvatarPlayer } from "./char-assets";

const STUB = "data:image/png;base64,iVBORw0KGgo=";

function player(overrides: Partial<AvatarPlayer> = {}): AvatarPlayer {
  return { id: "P001", grade: "LEGEND", name: "레전드선수", ...overrides };
}

afterEach(() => {
  cleanup();
  __clearLegendDotAssets();
});

describe("PlayerAvatar", () => {
  it("에셋 없으면 placeholder(이니셜 표시, img 없음)", () => {
    const { getByTestId, container } = render(h(PlayerAvatar, { player: player() }));
    const el = getByTestId("player-avatar-P001");
    expect(el.getAttribute("data-avatar-kind")).toBe("placeholder");
    expect(container.querySelector("img")).toBeNull();
    expect(el.textContent).toContain("레"); // 이니셜
  });

  it("비-LEGEND 는 에셋 있어도 placeholder", () => {
    __setLegendDotAsset("P001", STUB);
    const { getByTestId, container } = render(
      h(PlayerAvatar, { player: player({ grade: "SILVER" }) }),
    );
    expect(getByTestId("player-avatar-P001").getAttribute("data-avatar-kind")).toBe("placeholder");
    expect(container.querySelector("img")).toBeNull();
  });

  it("LEGEND + 에셋 있으면 legend-dot(img src=에셋)", () => {
    __setLegendDotAsset("P001", STUB);
    const { getByTestId, container } = render(h(PlayerAvatar, { player: player() }));
    expect(getByTestId("player-avatar-P001").getAttribute("data-avatar-kind")).toBe("legend-dot");
    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img!.getAttribute("src")).toBe(STUB);
  });

  it("img onError → placeholder 로 스왑(깨진 이미지 제거)", () => {
    __setLegendDotAsset("P001", STUB);
    const { getByTestId, container } = render(h(PlayerAvatar, { player: player() }));
    const img = container.querySelector("img")!;
    fireEvent.error(img);
    expect(getByTestId("player-avatar-P001").getAttribute("data-avatar-kind")).toBe("placeholder");
    expect(container.querySelector("img")).toBeNull();
  });

  it("role=img + aria-label(선수 이름) 접근성", () => {
    const { getByTestId } = render(h(PlayerAvatar, { player: player({ name: "손흥민" }) }));
    const el = getByTestId("player-avatar-P001");
    expect(el.getAttribute("role")).toBe("img");
    expect(el.getAttribute("aria-label")).toBe("손흥민");
  });
});
