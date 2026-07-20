/**
 * OAuth 목 로그인 플로우 (AC-A1, P2-D1) — 순수 로직/상수(테스트 대상).
 *
 * 서버 계약: POST /api/auth/login { nickname, provider } — provider ∈ guest|mock:google|mock:apple.
 * openapi.yaml(V1) LoginRequest 에 provider 가 반영돼 있어(Phase2 additive) 요청 body 타입은
 * 생성 타입(`components["schemas"]["LoginRequest"]`)을 참조한다 — provider 열거값이 계약과 자동 동기.
 * (server-java `MockOAuthProvider.SUPPORTED_PROVIDERS` 와도 정합.)
 *
 * 실 OAuth 도입 시(AC-A2): 서버는 AuthProvider 구현체만 교체, 클라는 mock 동의 모달을 실제
 * OAuth 리다이렉트로 교체하면 되고 이 body shape·provider 값은 그대로 재사용된다.
 */
import type { components } from "../api/schema";
import { ApiError } from "../api/client";
import {
  AUTH_BAD_CREDENTIALS_CODE,
  AUTH_DUPLICATE_ID_CODE,
  AUTH_LOGIN_PATH,
  AUTH_REGISTER_PATH,
  LOCAL_PROVIDER,
} from "../api/p3";
import type { LocalLoginRequest, RegisterRequest } from "../api/p3";
import type { LocalAuthFieldErrors } from "./validation";

/** V1 생성 타입의 provider 열거(guest|mock:google|mock:apple). */
type GeneratedProviderId = NonNullable<components["schemas"]["LoginRequest"]["provider"]>;

/**
 * 서버가 받는 provider 값.
 * TODO(openapi-v3): p3srv 가 `docs/plan-v4/api/openapi-v3.yaml` 에 provider="local" 을 넣고
 * `npm run gen:types:v3` 생성물이 나오면 이 로컬 union 확장을 제거하고 생성 타입만 쓴다
 * (지금은 V1 스키마에 local 이 없어 web 측에서만 additive 로 확장 — PRD-v4 §A / api/p3.ts).
 */
export type AuthProviderId = GeneratedProviderId | typeof LOCAL_PROVIDER;

export interface OAuthProviderMeta {
  id: AuthProviderId;
  /** 로그인 화면 버튼 라벨. 실 브랜드 상표/로고 모사 금지 — 제네릭 표기. */
  label: string;
  /** mock 동의 모달 헤더에 들어갈 서비스명("OO 계정으로 계속"). */
  consentName: string;
  /** provider 뱃지(로비 헤더) 짧은 표기. */
  badge: string;
}

const GOOGLE: OAuthProviderMeta = {
  id: "mock:google",
  label: "구글로 계속",
  consentName: "구글",
  badge: "구글",
};
const APPLE: OAuthProviderMeta = {
  id: "mock:apple",
  label: "애플로 계속",
  consentName: "애플",
  badge: "애플",
};
const GUEST: OAuthProviderMeta = {
  id: "guest",
  label: "게스트로 시작",
  consentName: "게스트",
  badge: "게스트",
};
/** 자체(id/비번) 계정 — 동의 모달 없음, 전용 폼으로 진입한다(PRD-v4 §A). */
const LOCAL: OAuthProviderMeta = {
  id: LOCAL_PROVIDER,
  label: "아이디로 로그인",
  consentName: "아이디",
  badge: "아이디",
};

/** 동의 모달을 거치는 OAuth 목 provider (게스트 제외). 로그인 화면 버튼 순서. */
export const OAUTH_PROVIDERS: readonly OAuthProviderMeta[] = [GOOGLE, APPLE];

const PROVIDER_BY_ID: Record<AuthProviderId, OAuthProviderMeta> = {
  "mock:google": GOOGLE,
  "mock:apple": APPLE,
  guest: GUEST,
  [LOCAL_PROVIDER]: LOCAL,
};

export function providerMeta(id: AuthProviderId | string | null | undefined): OAuthProviderMeta {
  if (id && id in PROVIDER_BY_ID) return PROVIDER_BY_ID[id as AuthProviderId];
  return PROVIDER_BY_ID.guest;
}

/** mock 동의 모달 문구 — 제네릭("OO 계정으로 계속"), 실제 OAuth 동의화면 모사 아님. */
export function consentTitle(provider: OAuthProviderMeta): string {
  return `${provider.consentName} 계정으로 계속`;
}

/** 생성된 LoginRequest 에 provider 를 필수화한 요청 body(클라는 항상 provider 를 명시 전송). */
export type LoginRequestBody = Omit<components["schemas"]["LoginRequest"], "provider"> & {
  provider: AuthProviderId;
};

/**
 * POST /api/auth/login 요청 body 를 만든다(닉네임 기반 = guest/OAuth목 경로, 무회귀).
 * provider 는 항상 포함 — 서버 SUPPORTED_PROVIDERS 가 guest 를 명시 지원한다.
 */
export function buildLoginBody(provider: GeneratedProviderId, nickname: string): LoginRequestBody {
  return { nickname, provider };
}

/* ─────────────── 자체 로그인(local) — PRD-v4 §A(AC-A1/AC-A2), 계약 = api/p3.ts ───────────────
 * ⚠️ 평문 비밀번호 목업(P3-D2). **실 OAuth/해시 교체 지점**:
 *   - 서버가 password 를 해시 저장으로 바꾸면 이 body shape 은 그대로 두고 서버만 교체된다.
 *   - 실 OAuth 도입 시엔 이 경로 대신 mock 동의 모달 → 리다이렉트로 교체(login-flow 상단 주석).
 * AC-A2: 아래 빌더들은 **순수 함수**다 — 저장(localStorage)·로깅(console)을 하지 않는다.
 *   비밀번호는 요청 body 로만 흘러가고 호출자가 제출 직후 폼 상태를 비운다(LoginPage).
 */

export { AUTH_LOGIN_PATH, AUTH_REGISTER_PATH, LOCAL_PROVIDER };

/** POST /api/auth/register body. */
export function buildRegisterBody(input: {
  loginId: string;
  password: string;
  nickname: string;
}): RegisterRequest {
  return { loginId: input.loginId, password: input.password, nickname: input.nickname };
}

/** POST /api/auth/login body (provider="local"). 닉네임은 보내지 않는다(가입 때만 받음). */
export function buildLocalLoginBody(input: {
  loginId: string;
  password: string;
}): LocalLoginRequest {
  return { provider: LOCAL_PROVIDER, loginId: input.loginId, password: input.password };
}

export const DUPLICATE_LOGIN_ID_MESSAGE = "이미 사용 중인 아이디입니다";
export const BAD_CREDENTIALS_MESSAGE = "아이디 또는 비밀번호가 올바르지 않습니다";
const GENERIC_AUTH_FAILURE_MESSAGE = "로그인에 실패했습니다";

/**
 * 서버 에러 → 화면 필드 에러 매핑(AC-A1).
 *   409 DUPLICATE_LOGIN_ID → loginId 필드
 *   401 BAD_CREDENTIALS    → 폼 전역(어느 쪽이 틀렸는지 알려주지 않는다 — 계정 열거 방지)
 * 그 외는 폼 전역 일반 메시지. 서버 원문 message 는 신뢰하지 않고 고정 문구를 쓴다
 * (서버가 비밀번호 등 입력값을 에코해도 화면에 노출되지 않게 — AC-A2).
 */
export function localAuthErrorToFields(err: unknown): LocalAuthFieldErrors {
  if (!(err instanceof ApiError)) return { form: GENERIC_AUTH_FAILURE_MESSAGE };

  // 1) code 우선 — 서버가 의미를 붙였으면 그게 SoT다.
  if (err.code === AUTH_DUPLICATE_ID_CODE) return { loginId: DUPLICATE_LOGIN_ID_MESSAGE };
  if (err.code === AUTH_BAD_CREDENTIALS_CODE) return { form: BAD_CREDENTIALS_MESSAGE };

  // 2) status 폴백 — 서버가 code 를 세분화하지 않아 라벨이 없을 때만.
  //    (code 가 INVALID_STATE 같은 **다른 의미**면 폴백하지 않는다 — 임의의 409 를
  //     "이미 사용 중인 아이디"로 오표기하던 버그. 라벨 있는 에러는 일반 문구로 간다.)
  if (isUnlabeledCode(err.code)) {
    if (err.status === 409) return { loginId: DUPLICATE_LOGIN_ID_MESSAGE };
    if (err.status === 401) return { form: BAD_CREDENTIALS_MESSAGE };
  }
  return { form: GENERIC_AUTH_FAILURE_MESSAGE };
}

/** 서버가 의미를 안 붙인 에러 봉투 — parseErrorBody 가 파싱 실패 시 채우는 자리표시자 포함. */
function isUnlabeledCode(code: string): boolean {
  return code === "INTERNAL_ERROR" || code === "";
}
