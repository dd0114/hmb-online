import { describe, expect, it } from "vitest";
import { logLineNumber } from "./LogPanel";

/**
 * #334 minor-1 — 로그 등번호 조회가 **#324 의 규약**(`skinLookup`: 팀 키 우선 → 단독 키 폴백)을
 * 따르는가. 코어는 그 규약을 쓰는데 이 화면만 raw 조회를 하고 있었다.
 *
 * <p>라이브 로그엔 `team` 이 항상 있어 **도달 불가** 경로지만, 그래서 더 계약이 필요하다 —
 * 되돌려도 아무 게이트가 안 깨지는 자리가 정확히 이번 작업에서 두 번 문제가 됐다.
 */
describe("logLineNumber — 조회 규약", () => {
  it("팀 키가 있으면 자기 팀 번호를 쓴다", () => {
    const nums = { "home:P078": "3", "away:P078": "5" };
    expect(logLineNumber(nums, { playerId: "P078", team: "home" })).toBe("3");
    expect(logLineNumber(nums, { playerId: "P078", team: "away" })).toBe("5");
  });

  it("team 이 없는 로그는 단독 키로 폴백한다 — 번호가 사라지면 안 된다", () => {
    expect(logLineNumber({ P078: "9" }, { playerId: "P078" })).toBe("9");
  });

  it("표에 없으면 코어가 준 number 로 떨어진다(엔진 픽스처 경로)", () => {
    expect(logLineNumber({}, { playerId: "H9", number: "9" })).toBe("9");
  });

  it("playerId 도 number 도 없으면 undefined", () => {
    expect(logLineNumber({}, {})).toBeUndefined();
  });
});
