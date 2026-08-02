// @vitest-environment node
/**
 * "왜 이 후보인가" 문장 계약 (#405 W3).
 *
 * 지키려는 결함은 하나다: **모르는 것을 말하지 않는다.** 서버 enum 은 늘어나고(`EVENT_TYPES` 는
 * "일부는 가중 0 이지만 열거는 전수"), 초판 선택권 행에는 `reason` 자체가 없다. 그때 raw 값을
 * 흘리거나 그럴듯한 문장을 지어내면 근거 줄이 **틀린 근거**가 된다 — 근거의 값어치는 정확성뿐이다.
 */
import { describe, expect, it } from "vitest";
import { reasonTextOf } from "./choice-reason";

describe("reasonTextOf — 만들 수 있는 것", () => {
  it("EVENT: 종류 + 횟수", () => {
    expect(reasonTextOf({ kind: "EVENT", detail: { type: "shot", count: 4 } })).toBe("이 경기 슛 4회");
    expect(reasonTextOf({ kind: "EVENT", detail: { type: "interception", count: 1 } })).toBe(
      "이 경기 가로채기 1회",
    );
  });

  it("BEHAVIOR: 파라미터가 아니라 **지시문 투**로 — 유저에겐 '내가 시킨 것'이다", () => {
    expect(reasonTextOf({ kind: "BEHAVIOR", detail: { param: "shootTendency", value: 0.82 } })).toBe(
      '지시 "적극적으로 슛"',
    );
    expect(reasonTextOf({ kind: "BEHAVIOR", detail: { param: "widthTendency", value: 0.79 } })).toBe(
      '지시 "넓게 벌려"',
    );
  });

  it("POSITION / RESULT / LEGACY", () => {
    expect(reasonTextOf({ kind: "POSITION", detail: { position: "MF" } })).toBe("포지션 MF 핵심");
    expect(reasonTextOf({ kind: "RESULT", detail: { result: "WIN" } })).toBe("승리 보너스");
    expect(reasonTextOf({ kind: "LEGACY", detail: {} })).toBe("이관 보상");
  });
});

describe("reasonTextOf — 말하지 않는 것 (전부 null)", () => {
  it("BASE = 균등 바닥만으로 뽑혔다 = 말할 근거가 없다", () => {
    expect(reasonTextOf({ kind: "BASE", detail: {} })).toBeNull();
  });

  it("reason 자체가 없다(W2b 초판 행) — 지어내지 않는다", () => {
    expect(reasonTextOf(null)).toBeNull();
    expect(reasonTextOf(undefined)).toBeNull();
  });

  it("모르는 kind — 서버가 축을 늘려도 화면이 죽지 않고 조용히 비운다", () => {
    expect(reasonTextOf({ kind: "MORALE", detail: { x: 1 } })).toBeNull();
  });

  it("매핑 밖 이벤트 종류(진행 신호)는 raw 를 흘리지 않는다", () => {
    expect(reasonTextOf({ kind: "EVENT", detail: { type: "kickoff", count: 2 } })).toBeNull();
    expect(reasonTextOf({ kind: "EVENT", detail: { type: "half_whistle", count: 1 } })).toBeNull();
  });

  it("매핑 밖 behavior 파라미터 — 파라미터 이름을 그대로 보여주지 않는다", () => {
    expect(reasonTextOf({ kind: "BEHAVIOR", detail: { param: "newKnob", value: 0.5 } })).toBeNull();
  });

  it("EVENT 인데 횟수가 없다/0 이다 — 근거의 무게가 횟수에 있으므로 생략", () => {
    expect(reasonTextOf({ kind: "EVENT", detail: { type: "shot" } })).toBeNull();
    expect(reasonTextOf({ kind: "EVENT", detail: { type: "shot", count: 0 } })).toBeNull();
  });

  it("detail 이 비었거나 모양이 아니어도 던지지 않는다", () => {
    expect(reasonTextOf({ kind: "POSITION", detail: {} })).toBeNull();
    expect(reasonTextOf({ kind: "RESULT", detail: { result: "ABANDONED" } })).toBeNull();
    expect(reasonTextOf({ kind: "EVENT" } as never)).toBeNull();
    expect(reasonTextOf({ kind: "EVENT", detail: null })).toBeNull();
  });
});
