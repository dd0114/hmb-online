/**
 * Client-side pre-check mirroring the server pattern
 * (openapi.yaml components.schemas.LoginRequest.properties.nickname.pattern).
 * The server remains the source of truth for validation — this only avoids a
 * round-trip for obviously-invalid input.
 */
const NICKNAME_PATTERN = /^[\p{L}\p{N}_-]{2,16}$/u;

export function isValidNickname(nickname: string): boolean {
  return NICKNAME_PATTERN.test(nickname);
}

/* ───────────────── 자체 로그인(local) 자격 검증 — PRD-v4 §A, P3-D2 ─────────────────
 * ⚠️ 목업 수준 규칙이다. 비밀번호는 **평문 목업**(P3-D2)이라 강도 규칙을 세우지 않는다.
 * 실 인증 도입 시 교체 지점: 서버 해시 전환 + 여기 정책 강화(길이/문자군/유출목록).
 * AC-A2: 이 모듈은 비밀번호를 **저장·로깅하지 않는다** — 순수 판정만 하고 값을 흘리지 않는다
 * (반환 메시지에 입력값을 절대 넣지 말 것).
 */

/** 아이디: 4~20자 영문/숫자/_/-. 서버가 최종 SoT — 왕복 전 명백한 오입력만 거른다. */
const LOGIN_ID_PATTERN = /^[A-Za-z0-9_-]{4,20}$/;

/** 목업 최소 길이. 실 서비스 전환 시 상향 예정(백로그). */
export const MIN_PASSWORD_LENGTH = 4;

export const LOGIN_ID_RULE_MESSAGE = "아이디는 4~20자의 영문/숫자/_/- 만 사용할 수 있습니다";
export const PASSWORD_RULE_MESSAGE = `비밀번호는 ${MIN_PASSWORD_LENGTH}자 이상이어야 합니다`;
export const NICKNAME_RULE_MESSAGE = "닉네임은 2~16자의 문자/숫자/_/- 만 사용할 수 있습니다";

export function isValidLoginId(loginId: string): boolean {
  return LOGIN_ID_PATTERN.test(loginId);
}

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH;
}

/** 필드별 에러 메시지 맵. 비어 있으면 통과. */
export interface LocalAuthFieldErrors {
  loginId?: string;
  password?: string;
  nickname?: string;
  /** 필드에 못 붙는 폼 전역 에러(예: 자격 불일치 401). */
  form?: string;
}

export function hasFieldErrors(errors: LocalAuthFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/** 로그인 폼(아이디/비번) 사전 검증. */
export function validateLocalLogin(input: { loginId: string; password: string }): LocalAuthFieldErrors {
  const errors: LocalAuthFieldErrors = {};
  if (!isValidLoginId(input.loginId)) errors.loginId = LOGIN_ID_RULE_MESSAGE;
  if (!isValidPassword(input.password)) errors.password = PASSWORD_RULE_MESSAGE;
  return errors;
}

/** 회원가입 폼(아이디/비번/닉네임) 사전 검증 — 닉네임 규칙은 기존 isValidNickname 재사용. */
export function validateLocalRegister(input: {
  loginId: string;
  password: string;
  nickname: string;
}): LocalAuthFieldErrors {
  const errors = validateLocalLogin(input);
  if (!isValidNickname(input.nickname)) errors.nickname = NICKNAME_RULE_MESSAGE;
  return errors;
}
