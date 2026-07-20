import { describe, expect, it } from "vitest";
import {
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  hasFieldErrors,
  isValidNickname,
  isValidPassword,
  validateLocalCredentials,
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

/* ── 자체 로그인(local) 검증 — PRD-v4 §A. 규칙 SoT = server-java ──
 * 식별자는 nickname 하나뿐이다(별도 loginId 없음 — RegisterRequest.java).
 * 비번 길이는 LocalAuthProvider 의 password-min/max-length(기본 4~64).
 */

describe("식별자 규칙 = 서버 Nicknames.PATTERN 과 동일 (별도 loginId 규칙 없음)", () => {
  it("서버가 허용하는 유니코드/기호 조합을 그대로 허용한다", () => {
    // 구 loginId 규칙(영문/숫자 4~20)이 살아 있으면 아래가 전부 깨진다 — 이중 규칙 재발 방지.
    for (const id of ["감독", "유저123", "ab", "u-1", "u_1", "a".repeat(16)]) {
      expect(isValidNickname(id)).toBe(true);
    }
  });

  it("서버 패턴 밖은 거부한다", () => {
    for (const id of ["", "a", "a".repeat(17), "has space", "user@name", "user.name"]) {
      expect(isValidNickname(id)).toBe(false);
    }
  });
});

describe("isValidPassword (서버 4~64자)", () => {
  it("경계값: min-1 거부 / min 허용 / max 허용 / max+1 거부", () => {
    expect(MIN_PASSWORD_LENGTH).toBe(4);
    expect(MAX_PASSWORD_LENGTH).toBe(64);
    expect(isValidPassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).toBe(false);
    expect(isValidPassword("a".repeat(MIN_PASSWORD_LENGTH))).toBe(true);
    expect(isValidPassword("a".repeat(MAX_PASSWORD_LENGTH))).toBe(true);
    expect(isValidPassword("a".repeat(MAX_PASSWORD_LENGTH + 1))).toBe(false);
  });

  it.each(["", "1", "abc"])("rejects short (%s)", (pw) => expect(isValidPassword(pw)).toBe(false));
});

describe("validateLocalCredentials (로그인·회원가입 공통)", () => {
  it("유효 입력이면 에러 없음", () => {
    expect(validateLocalCredentials({ nickname: "감독", password: "1234" })).toEqual({});
  });

  it("필드별로 에러를 나눠 돌려준다 (필드는 nickname/password 둘뿐)", () => {
    const errors = validateLocalCredentials({ nickname: "x", password: "1" });
    expect(Object.keys(errors).sort()).toEqual(["nickname", "password"]);
    expect(hasFieldErrors(errors)).toBe(true);
    expect(hasFieldErrors({})).toBe(false);
  });

  it("64자 초과 비밀번호도 왕복 전에 막는다 (서버 max 미러)", () => {
    const errors = validateLocalCredentials({ nickname: "감독", password: "a".repeat(65) });
    expect(errors.password).toBeTruthy();
    expect(errors.nickname).toBeUndefined();
  });

  it("AC-A2: 에러 메시지에 입력한 비밀번호가 섞이지 않는다", () => {
    const secret = "sup3rs3cret";
    const errors = validateLocalCredentials({ nickname: "x", password: secret });
    expect(JSON.stringify(errors)).not.toContain(secret);
  });
});
