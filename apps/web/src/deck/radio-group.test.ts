import { describe, expect, it } from "vitest";
import { radioKeyIndex, rovingTabIndex } from "./radio-group";

describe("radioKeyIndex — APG radiogroup 방향키", () => {
  it("→/↓ 는 다음, ←/↑ 는 이전", () => {
    expect(radioKeyIndex("ArrowRight", 1, 5)).toBe(2);
    expect(radioKeyIndex("ArrowDown", 1, 5)).toBe(2);
    expect(radioKeyIndex("ArrowLeft", 1, 5)).toBe(0);
    expect(radioKeyIndex("ArrowUp", 1, 5)).toBe(0);
  });

  it("양 끝에서 순환한다(APG 권장)", () => {
    expect(radioKeyIndex("ArrowRight", 4, 5)).toBe(0);
    expect(radioKeyIndex("ArrowLeft", 0, 5)).toBe(4);
  });

  it("Home/End 는 양 끝으로", () => {
    expect(radioKeyIndex("Home", 3, 5)).toBe(0);
    expect(radioKeyIndex("End", 1, 5)).toBe(4);
  });

  it("처리 대상이 아닌 키는 null(호출자가 기본 동작을 막지 않는다)", () => {
    for (const k of ["Tab", "Enter", " ", "a", "Escape"]) {
      expect(radioKeyIndex(k, 2, 5), k).toBeNull();
    }
  });

  it("빈 그룹은 null", () => {
    expect(radioKeyIndex("ArrowRight", 0, 0)).toBeNull();
  });
});

describe("rovingTabIndex — 그룹 전체가 탭스톱 하나", () => {
  it("선택된 항목만 0, 나머지는 -1", () => {
    const tabs = [0, 1, 2, 3, 4].map((i) => rovingTabIndex(i, 2));
    expect(tabs).toEqual([-1, -1, 0, -1, -1]);
    expect(tabs.filter((t) => t === 0)).toHaveLength(1);
  });
});
