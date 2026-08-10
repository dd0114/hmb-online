import { describe, it, expect } from "vitest";
import { aiModeNotice } from "./game-logic";

/**
 * #471 AC3 — 시작 화면 안내의 **발화 조건**만 검정한다(문구는 조정 가능, 조건은 계약).
 * 핵심 성질: `unknown`·미제공에서 안내가 뜨면 그건 거짓말이다.
 */
describe("aiModeNotice", () => {
  it("stub 이면 안내한다 — 스태틱 엔진임이 문장에 있다", () => {
    const msg = aiModeNotice({ mode: "stub", reason: "logged-out" });
    expect(msg).toBeTruthy();
    expect(msg).toContain("스태틱");
  });

  it("live 면 안내하지 않는다", () => {
    expect(aiModeNotice({ mode: "live", reason: "logged-in" })).toBeNull();
  });

  it("unknown 이면 안내하지 않는다(신고 전 창에서 배너가 번쩍이면 안 된다)", () => {
    expect(aiModeNotice({ mode: "unknown", reason: "no-report" })).toBeNull();
  });

  it("서버가 ai 를 안 주면(구 서버) 안내하지 않는다", () => {
    expect(aiModeNotice(undefined)).toBeNull();
    expect(aiModeNotice(null)).toBeNull();
  });
});
