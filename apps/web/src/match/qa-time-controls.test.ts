/**
 * QA 초단위 시간 컨트롤 계약 (#180). hero: "게임속도가 빨라 틱단위로 짚기 어렵다 —
 * 정확한 초에 멈춰서 'mm:ss 에 X 발생' 이라고 말할 수 있어야 한다."
 */
import { describe, expect, it } from "vitest";
import {
  clampTick,
  indexFromPct,
  parseClockInput,
  pctFromIndex,
  qaKeyAction,
  stepSeconds,
} from "./qa-time-controls";

describe("stepSeconds / clampTick", () => {
  it("초 단위로 앞뒤 이동", () => {
    expect(stepSeconds(100, 1, 5399)).toBe(101);
    expect(stepSeconds(100, -1, 5399)).toBe(99);
    expect(stepSeconds(100, 5, 5399)).toBe(105);
    expect(stepSeconds(100, -5, 5399)).toBe(95);
  });

  it("경기 처음/끝을 넘지 않는다", () => {
    expect(stepSeconds(2, -5, 5399)).toBe(0);
    expect(stepSeconds(5397, 5, 5399)).toBe(5399);
    expect(clampTick(-10, 100)).toBe(0);
    expect(clampTick(1e9, 100)).toBe(100);
    expect(clampTick(Number.NaN, 100)).toBe(0);
  });
});

describe("parseClockInput", () => {
  it("사람이 치는 여러 형태를 받는다", () => {
    expect(parseClockInput("12:34")).toBe(754);
    expect(parseClockInput(`12'34"`)).toBe(754);
    expect(parseClockInput("12 34")).toBe(754);
    expect(parseClockInput(" 1:02 ")).toBe(62);
    expect(parseClockInput("1:2")).toBe(62);
    expect(parseClockInput("754")).toBe(754); // 초(=틱)만
  });

  it("해석 불가는 null — 오타로 엉뚱한 데로 튀지 않는다", () => {
    for (const bad of ["", "   ", "abc", "12:99", "12:345", "-5", null, undefined]) {
      expect(parseClockInput(bad)).toBeNull();
    }
  });
});

describe("스크럽 인덱스 ↔ %", () => {
  it("인덱스는 정수로 스냅된다(스냅샷 사이에 어정쩡하게 서지 않게)", () => {
    expect(indexFromPct(0, 5401)).toBe(0);
    expect(indexFromPct(100, 5401)).toBe(5400);
    expect(indexFromPct(50, 5401)).toBe(2700);
    // 0.0093% ≈ 0.5 인덱스 → 반올림.
    expect(indexFromPct(0.0093, 5401)).toBe(1);
  });

  it("왕복 변환이 자기 자신으로 돌아온다", () => {
    for (const idx of [0, 1, 137, 2700, 5400]) {
      expect(indexFromPct(pctFromIndex(idx, 5401), 5401)).toBe(idx);
    }
  });

  it("스냅샷이 1개 이하면 0 (0으로 나누지 않는다)", () => {
    expect(pctFromIndex(3, 1)).toBe(0);
    expect(indexFromPct(50, 0)).toBe(0);
  });
});

describe("qaKeyAction 단축키", () => {
  it("←/→ = ∓1초, Shift 조합 = ∓5초", () => {
    expect(qaKeyAction({ key: "ArrowLeft" })).toEqual({ kind: "second", delta: -1 });
    expect(qaKeyAction({ key: "ArrowRight" })).toEqual({ kind: "second", delta: 1 });
    expect(qaKeyAction({ key: "ArrowLeft", shiftKey: true })).toEqual({ kind: "second", delta: -5 });
    expect(qaKeyAction({ key: "ArrowRight", shiftKey: true })).toEqual({ kind: "second", delta: 5 });
  });

  it(", / . = ∓1프레임, Space = 재생/정지", () => {
    expect(qaKeyAction({ key: "," })).toEqual({ kind: "frame", delta: -1 });
    expect(qaKeyAction({ key: "." })).toEqual({ kind: "frame", delta: 1 });
    expect(qaKeyAction({ key: " " })).toEqual({ kind: "toggle" });
  });

  it("입력창에 타이핑 중이면 단축키를 먹지 않는다", () => {
    expect(qaKeyAction({ key: "ArrowLeft", typing: true })).toBeNull();
    expect(qaKeyAction({ key: " ", typing: true })).toBeNull();
  });

  it("모르는 키는 무시", () => {
    expect(qaKeyAction({ key: "a" })).toBeNull();
    expect(qaKeyAction({ key: "Enter" })).toBeNull();
  });
});
