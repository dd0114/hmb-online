import { describe, it, expect } from "vitest";
import { promptHash, stableStringify } from "./protocol.js";

describe("잡 프로토콜 — promptHash(멱등키)", () => {
  it("키 순서와 무관하게 같은 컨텍스트면 같은 해시", () => {
    const a = { directive: "공격", seed: "42", prefix: "H", rosterContext: "R" };
    const b = { rosterContext: "R", prefix: "H", seed: "42", directive: "공격" };
    expect(promptHash("coach", a)).toBe(promptHash("coach", b));
  });

  it("컨텍스트가 다르면 다른 해시, kind 가 다르면 다른 해시", () => {
    const ctx = { directive: "공격", seed: "42" };
    expect(promptHash("coach", ctx)).not.toBe(promptHash("coach", { ...ctx, directive: "수비" }));
    expect(promptHash("coach", ctx)).not.toBe(promptHash("other", ctx));
  });

  it("중첩 객체·배열도 canonical (undefined 필드는 무시)", () => {
    expect(stableStringify({ b: [1, { y: 2, x: 1 }], a: undefined })).toBe('{"b":[1,{"x":1,"y":2}]}');
  });

  it("해시는 32 hex", () => {
    expect(promptHash("coach", { d: 1 })).toMatch(/^[0-9a-f]{32}$/);
  });
});
