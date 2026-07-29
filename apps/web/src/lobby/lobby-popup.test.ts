/**
 * 로비 팝업 큐 계약 (#248 §5 web 10 — #245 머지 전 단계의 순수함수 판정).
 *
 * "동시에 하나만 열린다"와 "공지가 원정보다 먼저"를 한 곳에서 강제한다.
 * 후속(#248 UX): **튜토리얼 중에는 저절로 뜨는 팝업을 미룬다** — 삼키지 않는다.
 */
import { describe, expect, it } from "vitest";
import {
  LOBBY_POPUP_PRIORITY,
  LOBBY_POPUP_UNBIDDEN,
  pickLobbyPopup,
} from "./lobby-popup";

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

/**
 * 튜토리얼 게이트 — **신규 유저가 무엇을 하라는 안내를 받기 전에 점검 공지부터 읽는 일이
 * 없어야 한다**(재현: `/api/me` tutorialDone=false 로 로비 진입 시 공지가 코치마크를 덮었다).
 *
 * 성질 셋을 박제한다:
 *  ① 튜토리얼 중에는 공지가 **안 열린다**
 *  ② 그 억제는 **미룸이지 삼킴이 아니다** — 같은 입력에서 게이트만 내리면 곧바로 공지가 나온다
 *  ③ **유저가 눌러서 연 팝업은 막지 않는다** — 누른 버튼이 먹통이 되면 새 버그다
 */
describe("pickLobbyPopup — 튜토리얼 중 차단(#248 UX 후속)", () => {
  it("튜토리얼이 도는 동안에는 공지를 열지 않는다", () => {
    expect(pickLobbyPopup({ notice: true }, { tutorialHold: true })).toBeNull();
  });

  it("삼키지 않는다 — 튜토리얼이 끝나면 같은 입력에서 공지가 나온다", () => {
    const ready = { notice: true } as const;
    expect(pickLobbyPopup(ready, { tutorialHold: true })).toBeNull();
    expect(pickLobbyPopup(ready, { tutorialHold: false })).toBe("notice");
    // 게이트를 넘기지 않는 기존 호출부도 그대로 동작한다(하위호환).
    expect(pickLobbyPopup(ready)).toBe("notice");
  });

  it("유저가 눌러서 연 팝업(원정)은 튜토리얼 중에도 막지 않는다", () => {
    // 원정은 [게임 시작] 클릭으로만 열린다(hero E1) — 미루면 그 클릭이 먹통이 된다.
    expect(pickLobbyPopup({ away: true }, { tutorialHold: true })).toBe("away");
  });

  it("차단된 공지가 뒤 순위를 막지 않는다 — 원정이 그 자리를 이어받는다", () => {
    expect(pickLobbyPopup({ notice: true, away: true }, { tutorialHold: true })).toBe("away");
  });

  it("무엇을 미룰지는 종류 이름이 아니라 `스스로 뜨는가` 표가 정한다", () => {
    expect(LOBBY_POPUP_UNBIDDEN.notice).toBe(true);
    expect(LOBBY_POPUP_UNBIDDEN.away).toBe(false);
    // 표에 등록된 종류 집합 = 우선순위 배열 집합. 갈라지면 게이트가 새는 종류가 생긴다.
    expect(Object.keys(LOBBY_POPUP_UNBIDDEN).sort()).toEqual([...LOBBY_POPUP_PRIORITY].sort());
  });
});
