import { describe, expect, it } from "vitest";
import { isValidNickname } from "./validation";

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
