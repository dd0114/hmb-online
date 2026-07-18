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

/** 서버 LoginRequest.provider 열거(openapi.yaml SoT = 생성 타입)와 정합. guest 포함. */
export type AuthProviderId = NonNullable<components["schemas"]["LoginRequest"]["provider"]>;

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

/** 동의 모달을 거치는 OAuth 목 provider (게스트 제외). 로그인 화면 버튼 순서. */
export const OAUTH_PROVIDERS: readonly OAuthProviderMeta[] = [GOOGLE, APPLE];

const PROVIDER_BY_ID: Record<AuthProviderId, OAuthProviderMeta> = {
  "mock:google": GOOGLE,
  "mock:apple": APPLE,
  guest: GUEST,
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
export type LoginRequestBody = components["schemas"]["LoginRequest"] & { provider: AuthProviderId };

/**
 * POST /api/auth/login 요청 body 를 만든다(클라 요청 shape SoT).
 * provider 는 항상 포함 — 서버 SUPPORTED_PROVIDERS 가 guest 를 명시 지원한다.
 */
export function buildLoginBody(provider: AuthProviderId, nickname: string): LoginRequestBody {
  return { nickname, provider };
}
