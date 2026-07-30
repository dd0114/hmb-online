import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import { decklessBranch, deckMissing, isDeckRequiredError, STARTER_REQUIRED } from "./deckless";

/**
 * #286 W3.5 — 덱 없는 유저 가드의 **순수 판정** 계약.
 *
 * e2e 가 동선을 보고, 여기서는 **경계**를 본다. 경계가 틀리면 동선은 멀쩡히 돌면서 엉뚱한
 * 유저를 막는다(정상 유저가 첫 클릭마다 안내를 맞는 식으로).
 */

describe("deckMissing — '없다'와 '아직 모른다'는 다르다", () => {
  it("404 정규화값(null)만 '없다'로 읽는다", () => {
    expect(deckMissing(null)).toBe(true);
  });

  it("로딩 중(undefined)은 막지 않는다", () => {
    // ⚠️ 여기서 true 를 돌려주면 **정상 유저 전원**이 홈 첫 클릭에 안내를 맞는다 —
    // 덱 조회가 끝나기 전에 타일을 누르는 건 흔한 타이밍이다.
    expect(deckMissing(undefined)).toBe(false);
  });

  it("덱이 있으면 막지 않는다", () => {
    expect(deckMissing({ formation: "4-3-3", slots: [] })).toBe(false);
  });
});

describe("decklessBranch — 카드가 모자라면 덱 화면으로 보내지 않는다", () => {
  it("보유가 정원 미만이면 영입 분기", () => {
    const b = decklessBranch(10);
    expect(b.kind).toBe("recruit");
    expect(b).toMatchObject({ owned: 10, required: STARTER_REQUIRED });
  });

  it("정원과 같으면 덱 구성 분기 — 경계는 '미만'이다", () => {
    // 11명이면 벤치는 없어도 선발은 채워진다 = 저장이 가능하다.
    expect(decklessBranch(STARTER_REQUIRED).kind).toBe("build");
  });

  it("보유 수를 모르면 덱 구성 분기로 떨어진다", () => {
    // 덱 화면은 어차피 저장을 막고 부족분을 그 자리에서 보여준다 —
    // 모를 때는 **덜 아는 화면**으로 보내는 쪽이 안전하다.
    expect(decklessBranch(undefined).kind).toBe("build");
    expect(decklessBranch(null).kind).toBe("build");
  });
});

describe("isDeckRequiredError — 서버 거부를 받아내되 넓히지 않는다", () => {
  it("전용 코드(W4)를 받는다", () => {
    expect(isDeckRequiredError(new ApiError(400, { code: "DECK_REQUIRED", message: "활성 덱이 없습니다" }))).toBe(true);
  });

  it("지금 서버의 뭉뚱그린 404 + 덱 문구도 받는다", () => {
    expect(isDeckRequiredError(new ApiError(404, { code: "NOT_FOUND", message: "활성 덱이 없습니다" }))).toBe(true);
  });

  it("덱과 무관한 404 는 받지 않는다", () => {
    // ⚠️ 404 를 전부 삼키면 엉뚱한 실패까지 "덱을 만드세요"로 덮어 **진짜 원인을 가린다**.
    expect(isDeckRequiredError(new ApiError(404, { code: "NOT_FOUND", message: "매치를 찾을 수 없습니다" }))).toBe(false);
  });

  it("다른 실패는 받지 않는다", () => {
    expect(isDeckRequiredError(new ApiError(409, { code: "MATCH_IN_PROGRESS", message: "진행 중" }))).toBe(false);
    expect(isDeckRequiredError(new Error("network"))).toBe(false);
    expect(isDeckRequiredError(null)).toBe(false);
    expect(isDeckRequiredError(undefined)).toBe(false);
  });
});
