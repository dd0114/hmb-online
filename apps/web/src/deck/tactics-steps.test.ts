/**
 * 5스텝 세그먼트 ↔ 0..1 계약 매핑 (#106 R2).
 * 서버 계약은 실수 그대로라 매핑이 어긋나면 전술이 조용히 달라진다 → 단위로 박제한다.
 */
import { describe, expect, it } from "vitest";
import { TACTICS_KEYS } from "./tactics-logic";
import {
  STEP_COUNT,
  STEP_LABELS,
  STEP_VALUES,
  stepAriaLabel,
  stepIndexOf,
  stepLabelOf,
  valueOfStep,
} from "./tactics-steps";

describe("5스텝 → 계약값", () => {
  it("0 / .25 / .5 / .75 / 1 로 매핑된다 (#106 확정)", () => {
    expect([...STEP_VALUES]).toEqual([0, 0.25, 0.5, 0.75, 1]);
    expect([0, 1, 2, 3, 4].map(valueOfStep)).toEqual([0, 0.25, 0.5, 0.75, 1]);
  });

  it("범위 밖 인덱스는 클램프된다", () => {
    expect(valueOfStep(-3)).toBe(0);
    expect(valueOfStep(99)).toBe(1);
  });
});

describe("계약값 → 스텝(표시 스냅)", () => {
  it("정확히 스텝값이면 그 스텝", () => {
    expect(STEP_VALUES.map((v) => stepIndexOf(v))).toEqual([0, 1, 2, 3, 4]);
  });

  it("중간값은 가장 가까운 스텝으로 스냅한다(서버/프리셋 유입 대비)", () => {
    expect(stepIndexOf(0.6)).toBe(2); // 0.5
    expect(stepIndexOf(0.8)).toBe(3); // 0.75
    expect(stepIndexOf(0.13)).toBe(1); // 0.25
  });

  it("범위 밖·NaN 도 안전하다", () => {
    expect(stepIndexOf(-1)).toBe(0);
    expect(stepIndexOf(2)).toBe(4);
    expect(stepIndexOf(Number.NaN)).toBe(2);
  });

  it("왕복: 스텝 → 값 → 스텝 이 동일하다", () => {
    for (let i = 0; i < STEP_COUNT; i++) expect(stepIndexOf(valueOfStep(i))).toBe(i);
  });
});

describe("라벨", () => {
  it("4종 전부 5개 라벨을 갖고, 가운데는 보통이다", () => {
    for (const key of TACTICS_KEYS) {
      expect(STEP_LABELS[key]).toHaveLength(5);
      expect(STEP_LABELS[key][2]).toBe("보통");
    }
  });

  it("항목마다 방향 언어가 다르다(라인=높낮이 / 폭=좁고넓음)", () => {
    expect(stepLabelOf("line", 1)).toContain("높");
    expect(stepLabelOf("width", 1)).toContain("넓");
    expect(stepLabelOf("press", 0)).toContain("약");
    expect(stepLabelOf("tempo", 0)).toContain("느");
  });

  it("aria 라벨은 항목명 + 스텝", () => {
    expect(stepAriaLabel("press", 4)).toBe("압박 매우강함");
  });
});
