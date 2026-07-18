import { describe, expect, it } from "vitest";
import {
  OAUTH_PROVIDERS,
  buildLoginBody,
  consentTitle,
  providerMeta,
} from "./login-flow";

describe("login-flow (AC-A1)", () => {
  it("exposes exactly two OAuth mock providers (google, apple) — guest is separate", () => {
    expect(OAUTH_PROVIDERS.map((p) => p.id)).toEqual(["mock:google", "mock:apple"]);
  });

  it("labels are generic (no real brand trademark strings)", () => {
    const labels = OAUTH_PROVIDERS.map((p) => p.label).join(" ");
    // 제네릭 표기만 — 실 브랜드 로고/상표 모사 금지.
    expect(labels).toContain("구글");
    expect(labels).toContain("애플");
  });

  it("buildLoginBody produces the {nickname, provider} request shape the server expects", () => {
    expect(buildLoginBody("mock:google", "손민수")).toEqual({
      nickname: "손민수",
      provider: "mock:google",
    });
    expect(buildLoginBody("mock:apple", "kane")).toEqual({
      nickname: "kane",
      provider: "mock:apple",
    });
    // 게스트도 provider 를 명시 전송(서버 SUPPORTED_PROVIDERS 가 guest 를 지원).
    expect(buildLoginBody("guest", "게스트1")).toEqual({
      nickname: "게스트1",
      provider: "guest",
    });
  });

  it("consentTitle is the generic 'OO 계정으로 계속' mock copy (not a brand consent screen)", () => {
    expect(consentTitle(providerMeta("mock:google"))).toBe("구글 계정으로 계속");
    expect(consentTitle(providerMeta("mock:apple"))).toBe("애플 계정으로 계속");
  });

  it("providerMeta falls back to guest for unknown/blank provider", () => {
    expect(providerMeta(null).id).toBe("guest");
    expect(providerMeta("mock:facebook").id).toBe("guest");
    expect(providerMeta("mock:google").id).toBe("mock:google");
  });
});
