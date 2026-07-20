import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  AUTH_LOGIN_PATH,
  AUTH_REGISTER_PATH,
  BAD_CREDENTIALS_MESSAGE,
  DUPLICATE_LOGIN_ID_MESSAGE,
  LOCAL_PROVIDER,
  OAUTH_PROVIDERS,
  buildLocalLoginBody,
  buildLoginBody,
  buildRegisterBody,
  consentTitle,
  localAuthErrorToFields,
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

/* ── 자체 로그인(local) — PRD-v4 §A (AC-A1/AC-A2) ── */

describe("local provider (additive, 기존 플로우 무회귀)", () => {
  it("OAUTH_PROVIDERS 에는 local 이 들어가지 않는다 (동의 모달 경로가 아님)", () => {
    expect(OAUTH_PROVIDERS.map((p) => p.id)).toEqual(["mock:google", "mock:apple"]);
  });

  it("providerMeta('local') 뱃지는 '아이디'", () => {
    expect(providerMeta(LOCAL_PROVIDER).id).toBe("local");
    expect(providerMeta("local").badge).toBe("아이디");
  });

  it("기존 provider 뱃지는 그대로 (무회귀)", () => {
    expect(providerMeta("guest").badge).toBe("게스트");
    expect(providerMeta("mock:google").badge).toBe("구글");
    expect(providerMeta("mock:apple").badge).toBe("애플");
  });

  it("경로 상수는 계약(api/p3.ts)과 동일", () => {
    expect(AUTH_REGISTER_PATH).toBe("/api/auth/register");
    expect(AUTH_LOGIN_PATH).toBe("/api/auth/login");
    // 로그인 경로는 기존 닉네임 플로우와 같은 엔드포인트를 공유한다(provider 로 분기).
    expect(AUTH_LOGIN_PATH).toBe("/api/auth/login");
  });
});

describe("local request builders", () => {
  it("buildRegisterBody = {loginId,password,nickname} (여분 필드 없음)", () => {
    const body = buildRegisterBody({ loginId: "tester01", password: "pw1234", nickname: "감독" });
    expect(body).toEqual({ loginId: "tester01", password: "pw1234", nickname: "감독" });
    expect(Object.keys(body).sort()).toEqual(["loginId", "nickname", "password"]);
  });

  it("buildLocalLoginBody = {provider:'local',loginId,password} — 닉네임 미전송", () => {
    const body = buildLocalLoginBody({ loginId: "tester01", password: "pw1234" });
    expect(body).toEqual({ provider: "local", loginId: "tester01", password: "pw1234" });
    expect(Object.keys(body)).not.toContain("nickname");
  });

  it("buildLoginBody(기존 닉네임 경로)는 그대로 동작한다 (무회귀)", () => {
    expect(buildLoginBody("guest", "게스트1")).toEqual({ nickname: "게스트1", provider: "guest" });
  });
});

describe("localAuthErrorToFields (서버 에러 → 화면 필드)", () => {
  it("409 DUPLICATE_LOGIN_ID → loginId 필드 에러", () => {
    const err = new ApiError(409, { code: "DUPLICATE_LOGIN_ID", message: "dup" });
    expect(localAuthErrorToFields(err)).toEqual({ loginId: DUPLICATE_LOGIN_ID_MESSAGE });
  });

  it("401 BAD_CREDENTIALS → 폼 전역 에러(계정 열거 방지)", () => {
    const err = new ApiError(401, { code: "BAD_CREDENTIALS", message: "bad" });
    expect(localAuthErrorToFields(err)).toEqual({ form: BAD_CREDENTIALS_MESSAGE });
  });

  it("AC-A2: 서버 message 원문(비밀번호 에코 가능)을 그대로 쓰지 않는다", () => {
    const secret = "sup3rs3cret";
    const err = new ApiError(401, { code: "BAD_CREDENTIALS", message: `pw ${secret} wrong` });
    expect(JSON.stringify(localAuthErrorToFields(err))).not.toContain(secret);
  });

  it("알 수 없는 에러 / 네트워크 실패 → 일반 폼 에러", () => {
    expect(localAuthErrorToFields(new Error("network down")).form).toBeTruthy();
    expect(localAuthErrorToFields(new ApiError(500, { code: "INTERNAL_ERROR", message: "x" })).form)
      .toBeTruthy();
  });
});

/* ── minor-2: code 우선 판별 (status 는 폴백) ── */

describe("localAuthErrorToFields — code 우선", () => {
  it("로그인 폼의 임의 409(중복ID 아님)를 '이미 사용 중인 아이디'로 오표기하지 않는다", () => {
    const err = new ApiError(409, { code: "INVALID_STATE", message: "conflict" });
    const fields = localAuthErrorToFields(err);
    expect(fields.loginId).toBeUndefined();
    expect(fields.form).toBeTruthy();
  });

  it("임의 401(BAD_CREDENTIALS 아님)은 자격 오류 문구로 단정하지 않는다", () => {
    const err = new ApiError(401, { code: "UNAUTHORIZED", message: "session expired" });
    expect(localAuthErrorToFields(err).form).not.toBe(BAD_CREDENTIALS_MESSAGE);
  });

  it("code 가 명시되면 status 가 달라도 code 를 따른다", () => {
    expect(localAuthErrorToFields(new ApiError(400, { code: "DUPLICATE_LOGIN_ID", message: "d" })))
      .toEqual({ loginId: DUPLICATE_LOGIN_ID_MESSAGE });
    expect(localAuthErrorToFields(new ApiError(403, { code: "BAD_CREDENTIALS", message: "b" })))
      .toEqual({ form: BAD_CREDENTIALS_MESSAGE });
  });

  it("code 가 일반 봉투(INTERNAL_ERROR 등)면 status 폴백으로 판별한다", () => {
    // 서버가 code 를 세분화하지 않고 status 만 맞게 주는 경우의 하위호환.
    expect(localAuthErrorToFields(new ApiError(409, { code: "INTERNAL_ERROR", message: "x" })))
      .toEqual({ loginId: DUPLICATE_LOGIN_ID_MESSAGE });
    expect(localAuthErrorToFields(new ApiError(401, { code: "INTERNAL_ERROR", message: "x" })))
      .toEqual({ form: BAD_CREDENTIALS_MESSAGE });
  });
});
