import { describe, expect, it } from "vitest";
import {
  hasFieldErrors,
  isValidLoginId,
  isValidNickname,
  isValidPassword,
  validateLocalLogin,
  validateLocalRegister,
} from "./validation";

describe("isValidNickname", () => {
  it.each(["ab", "abcdefghijklmnop", "user_1", "user-1", "닉네임", "유저123"])(
    "accepts valid nickname %s",
    (nickname) => {
      expect(isValidNickname(nickname)).toBe(true);
    },
  );

  it.each([
    "", // too short
    "a", // too short (1 char)
    "abcdefghijklmnopq", // too long (17 chars)
    "has space",
    "invalid!",
    "user@name",
  ])("rejects invalid nickname %s", (nickname) => {
    expect(isValidNickname(nickname)).toBe(false);
  });
});

/* ── 자체 로그인(local) 검증 — PRD-v4 §A ── */

describe("isValidLoginId (4~20자 영문/숫자/_/-)", () => {
  it.each(["abcd", "tester01", "user_1", "user-1", "a".repeat(20)])(
    "accepts %s",
    (id) => expect(isValidLoginId(id)).toBe(true),
  );

  it.each([
    "", "abc", "a".repeat(21), "has space", "user@name", "유저아이디", "user.name", "user!",
  ])("rejects %s", (id) => expect(isValidLoginId(id)).toBe(false));
});

describe("isValidPassword (목업 최소 4자)", () => {
  it.each(["1234", "pass", "a-very-long-passphrase"])(
    "accepts length>=4 (%s)",
    (pw) => expect(isValidPassword(pw)).toBe(true),
  );
  it.each(["", "1", "abc"])("rejects short (%s)", (pw) => expect(isValidPassword(pw)).toBe(false));
});

describe("validateLocalLogin / validateLocalRegister", () => {
  it("유효 입력이면 에러 없음", () => {
    expect(validateLocalLogin({ loginId: "tester01", password: "1234" })).toEqual({});
    expect(
      validateLocalRegister({ loginId: "tester01", password: "1234", nickname: "감독" }),
    ).toEqual({});
  });

  it("필드별로 에러를 나눠 돌려준다", () => {
    const errors = validateLocalRegister({ loginId: "ab", password: "1", nickname: "x" });
    expect(Object.keys(errors).sort()).toEqual(["loginId", "nickname", "password"]);
    expect(hasFieldErrors(errors)).toBe(true);
    expect(hasFieldErrors({})).toBe(false);
  });

  it("로그인 검증은 닉네임을 요구하지 않는다", () => {
    expect(validateLocalLogin({ loginId: "tester01", password: "1234" }).nickname).toBeUndefined();
  });

  it("AC-A2: 에러 메시지에 입력한 비밀번호가 섞이지 않는다", () => {
    const secret = "sup3rs3cret";
    const errors = validateLocalRegister({ loginId: "ab", password: secret, nickname: "x" });
    expect(JSON.stringify(errors)).not.toContain(secret);
  });
});
