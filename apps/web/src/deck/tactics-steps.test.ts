/**
 * 5스텝 세그먼트 ↔ 0..1 계약 매핑 (#106 R2).
 * 서버 계약은 실수 그대로라 매핑이 어긋나면 전술이 조용히 달라진다 → 단위로 박제한다.
 */
import { describe, expect, it } from "vitest";
import { TACTICS_KEYS } from "./tactics-logic";
import {
  isStepValue,
  STEP_COUNT,
  STEP_LABELS,
  STEP_VALUES,
  stepAriaLabel,
  stepDisplayOf,
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

/**
 * ── #106 R3a m2: 팀 레이어의 "표시 = 전송" ────────────────────────────────────────────────
 * 예전엔 서버/프리셋에서 온 0.6 이 "보통"(=0.5)으로 **눌린 것처럼** 그려지고 전송은 0.6 이었다.
 * 선수 레이어에서 금지한 표시≠전송이므로, 근사일 때는 눌림(pressed)이 아니라 **근사 표시**로
 * 그리고 실제 값을 노출한다. 값 자체는 사용자가 누르기 전까지 바뀌지 않는다(정규화 기각).
 */
describe("m2 — 근사 표시(표시 = 전송)", () => {
  it("스텝값과 정확히 같을 때만 '스텝값'이다", () => {
    for (const v of STEP_VALUES) expect(isStepValue(v)).toBe(true);
    for (const v of [0.6, 0.13, 0.8, 0.499]) expect(isStepValue(v)).toBe(false);
    expect(isStepValue(Number.NaN)).toBe(false);
  });

  it("정확한 스텝값은 근사가 아니고 라벨이 그대로다", () => {
    const d = stepDisplayOf("press", 0.5);
    expect(d).toEqual({ index: 2, approx: false, label: "보통", valueText: "0.5" });
  });

  it("중간값은 근사로 표시되고 **실제 전송값**을 함께 노출한다", () => {
    const d = stepDisplayOf("press", 0.6);
    expect(d.approx).toBe(true);
    expect(d.index).toBe(2); // 가장 가까운 위치에 표시하되
    expect(d.valueText).toBe("0.6"); // 값은 0.6 이라고 정직하게 말한다
  });

  it("근사 표시는 값을 바꾸지 않는다(정규화 금지) — 스텝을 누를 때만 계약값이 된다", () => {
    const incoming = 0.6;
    const d = stepDisplayOf("line", incoming);
    expect(incoming).toBe(0.6); // 표시 계산은 순수하다
    expect(valueOfStep(d.index)).toBe(0.5); // 사용자가 그 스텝을 누르면 비로소 0.5
  });

  it("유한하지 않은 값도 안전하게 표시된다", () => {
    const d = stepDisplayOf("tempo", Number.NaN);
    expect(d.approx).toBe(true);
    expect(d.valueText).toBe("—");
  });
});
