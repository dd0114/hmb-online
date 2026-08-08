// @vitest-environment jsdom
/**
 * #479 — 스플래시 노출 판정.
 *
 * 세 규칙(세션당 1회 · 딥링크 면제 · 저장소 예외 폴백)을 각각 태운다. 한 테스트에 묶으면
 * 앞 단언에서 죽어 뒤가 **실행조차 안 된다**(모듈 규율 §계약이 초록으로 거짓말하는 방식 #6·#238).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SPLASH_SEEN_KEY,
  markSplashSeen,
  readSplashSeen,
  shouldShowSplash,
} from "./splash-gate";

afterEach(() => {
  window.sessionStorage.clear();
  vi.restoreAllMocks();
});

describe("shouldShowSplash", () => {
  it("첫 진입이면 띄운다", () => {
    expect(shouldShowSplash({ seen: false, returnTo: null })).toBe(true);
  });

  it("이번 세션에 이미 봤으면 안 띄운다", () => {
    expect(shouldShowSplash({ seen: true, returnTo: null })).toBe(false);
  });

  /**
   * ⚠️ 공유 딥링크(#298)로 온 사람의 방문 목적은 그 링크의 목적지다. 광고를 먼저 세우면
   * "목적지를 잃지 않는다"를 화면에서 다시 깨는 셈이다.
   */
  it("returnTo 가 있으면(딥링크) 안 띄운다", () => {
    expect(shouldShowSplash({ seen: false, returnTo: "/share/notice/abc" })).toBe(false);
  });

  it("returnTo 빈 문자열은 딥링크가 아니다 — 띄운다", () => {
    expect(shouldShowSplash({ seen: false, returnTo: "" })).toBe(true);
  });
});

describe("저장소", () => {
  it("mark → read 왕복", () => {
    expect(readSplashSeen()).toBe(false);
    markSplashSeen();
    expect(window.sessionStorage.getItem(SPLASH_SEEN_KEY)).toBe("1");
    expect(readSplashSeen()).toBe(true);
  });

  /**
   * ⚠️ 사파리 프라이빗·쿠키 차단에서는 `sessionStorage` **접근 자체가 throw** 한다.
   * 폴백 방향은 "안 봤다"(= 스플래시를 띄운다) — 최악이 "광고를 한 번 더 본다" 라서 그쪽이
   * 안전측이다. 반대로 폴백하면 그 환경 전체에서 기능이 통째로 죽는다.
   */
  it("sessionStorage 가 던져도 read 는 false 로 폴백한다", () => {
    vi.spyOn(window.sessionStorage, "getItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(readSplashSeen()).toBe(false);
  });

  it("sessionStorage 가 던져도 mark 는 동선을 막지 않는다", () => {
    vi.spyOn(window.sessionStorage, "setItem").mockImplementation(() => {
      throw new Error("SecurityError");
    });
    expect(() => markSplashSeen()).not.toThrow();
  });
});
