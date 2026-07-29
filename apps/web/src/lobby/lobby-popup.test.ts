/**
 * 로비 팝업 큐 계약 (#248 §5 web 10 — #245 머지 전 단계의 순수함수 판정).
 *
 * "동시에 하나만 열린다"와 "공지가 원정보다 먼저"를 한 곳에서 강제한다.
 */
import { describe, expect, it } from "vitest";
import { LOBBY_POPUP_PRIORITY, pickLobbyPopup } from "./lobby-popup";

describe("pickLobbyPopup", () => {
  it("둘 다 준비돼도 **하나만** 고르고, 그건 공지다(hero Q4)", () => {
    expect(pickLobbyPopup({ notice: true, away: true })).toBe("notice");
  });

  it("공지가 없으면 원정 차례", () => {
    expect(pickLobbyPopup({ notice: false, away: true })).toBe("away");
  });

  it("준비된 게 없으면 null — 빈 모달을 띄우지 않는다", () => {
    expect(pickLobbyPopup({})).toBeNull();
    expect(pickLobbyPopup({ notice: false, away: false })).toBeNull();
  });

  it("우선순위 배열이 SoT 다 — 공지가 원정보다 앞", () => {
    expect([...LOBBY_POPUP_PRIORITY]).toEqual(["notice", "away"]);
    expect(LOBBY_POPUP_PRIORITY.indexOf("notice")).toBeLessThan(LOBBY_POPUP_PRIORITY.indexOf("away"));
  });

  it("등록되지 않은 종류는 무시한다", () => {
    expect(pickLobbyPopup({ unknown: true } as never)).toBeNull();
  });
});
