// @vitest-environment node
/**
 * 카드 축 윈도우 계약 (#405 W3, 서버 `619d18b`).
 *
 * 원점은 **등급 `startLo`** 여야 한다 — 감쇠가 `r = (v − startLo)/(ceiling − startLo)` 라
 * 그 값이 아니면 gain 차이가 막대 길이로 안 읽힌다. 구 서버(값 부재)에서는 근사로 떨어지되
 * **근사임을 알려야** 호출부가 `시작 N` 라벨을 안 붙인다(근사치에 정확한 이름 = 거짓말).
 */
import { describe, expect, it } from "vitest";
import { cardAxisWindow } from "./growth-config";

const base = { shooting: 36, pace: 40, tackling: 44 };
const caps = { shooting: 73, pace: 73, tackling: 73 };

describe("cardAxisWindow", () => {
  it("startLo 가 오면 그 값이 원점이고 exact 다", () => {
    expect(cardAxisWindow(base, caps, 32)).toEqual({ lo: 32, hi: 73, exact: true });
  });

  it("⚠️ startLo 는 발행 원본 최소값(36)이 아니다 — 둘을 섞으면 감쇠식과 축이 어긋난다", () => {
    expect(cardAxisWindow(base, caps, 32).lo).toBe(32);
    expect(cardAxisWindow(base, caps).lo).not.toBe(32);
  });

  it("startLo 가 없으면(구 서버) 근사 앵커 + exact=false — 호출부가 라벨을 안 붙인다", () => {
    const w = cardAxisWindow(base, caps);
    expect(w).toEqual({ lo: 31, hi: 73, exact: false }); // min(base) 36 − 여유 5
  });

  it("null/undefined 도 근사 경로다(부재를 0 으로 읽어 원점을 0 으로 만들지 않는다)", () => {
    expect(cardAxisWindow(base, caps, null).exact).toBe(false);
    expect(cardAxisWindow(base, caps, null).lo).toBe(31);
    expect(cardAxisWindow(base, caps, Number.NaN).lo).toBe(31);
  });

  it("startLo 0 은 유효한 값이다 — falsy 로 걸러 근사로 떨어지면 안 된다", () => {
    expect(cardAxisWindow(base, caps, 0)).toEqual({ lo: 0, hi: 73, exact: true });
  });

  it("천장이 원점 이하로 뒤집혀도 폭 0 축을 만들지 않는다(전 막대가 0% 가 된다)", () => {
    expect(cardAxisWindow(base, { a: 30 }, 40).hi).toBe(41);
  });

  it("응답이 손상돼 아무 값도 없으면 0–100 으로 눕는다", () => {
    expect(cardAxisWindow(undefined, undefined)).toEqual({ lo: 0, hi: 100, exact: false });
  });
});
