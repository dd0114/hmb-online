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
 * 규칙 SoT = **서버**(server-java):
 *   - 식별자 = `users.nickname`(UNIQUE). **별도 로그인 id 컬럼이 없다** —
 *     `Nicknames.PATTERN` = /^[\p{L}\p{N}_-]{2,16}$/ 하나로 로그인 id 와 표시 닉네임을 겸한다
 *     (RegisterRequest = {nickname, password}, LoginRequest = {nickname, provider, password}).
 *   - 비번 길이 = `LocalAuthProvider` 의 `hmb.auth.local.password-{min,max}-length`(기본 4~64).
 * 여기 검증은 왕복 전 명백한 오입력만 거르는 **미러**다 — 최종 판정은 서버.
 *
 * ⚠️ 비밀번호는 **평문 목업**(P3-D2)이라 강도 규칙을 세우지 않는다(길이만).
 * 실 인증 도입 시 교체 지점: 서버 해시 전환 + 여기 정책 강화(문자군/유출목록).
 * AC-A2: 이 모듈은 비밀번호를 **저장·로깅하지 않는다** — 순수 판정만 하고 값을 흘리지 않는다
 * (반환 메시지에 입력값을 절대 넣지 말 것).
 */

/** 서버 `hmb.auth.local.password-min-length` 기본값. */
export const MIN_PASSWORD_LENGTH = 4;
/** 서버 `hmb.auth.local.password-max-length` 기본값. */
export const MAX_PASSWORD_LENGTH = 64;

/**
 * 식별자 필드 문구. 화면 라벨은 "아이디"지만 실체는 nickname 이라(서버가 하나로 쓴다)
 * 양쪽을 함께 표기해 이중 입력 오해를 없앤다.
 */
export const NICKNAME_RULE_MESSAGE = "아이디(닉네임)는 2~16자의 문자/숫자/_/- 만 사용할 수 있습니다";
/** 서버 LocalAuthProvider.register 의 validation 메시지와 동일 문구. */
export const PASSWORD_RULE_MESSAGE = `비밀번호는 ${MIN_PASSWORD_LENGTH}~${MAX_PASSWORD_LENGTH}자여야 합니다`;

export function isValidPassword(password: string): boolean {
  return password.length >= MIN_PASSWORD_LENGTH && password.length <= MAX_PASSWORD_LENGTH;
}

/** 필드별 에러 메시지 맵. 비어 있으면 통과. */
export interface LocalAuthFieldErrors {
  /** 로그인 id 겸 표시 닉네임(서버 `nickname`). */
  nickname?: string;
  password?: string;
  /** 필드에 못 붙는 폼 전역 에러(예: 자격 불일치 401). */
  form?: string;
}

export function hasFieldErrors(errors: LocalAuthFieldErrors): boolean {
  return Object.keys(errors).length > 0;
}

/**
 * 자체 로그인/회원가입 공통 사전 검증.
 * 로그인과 가입이 **같은 두 필드**(nickname/password)를 쓰므로 검증도 하나다 —
 * 서버가 식별자를 하나만 두기 때문(별도 validateLocalRegister 가 없는 이유).
 */
export function validateLocalCredentials(input: {
  nickname: string;
  password: string;
}): LocalAuthFieldErrors {
  const errors: LocalAuthFieldErrors = {};
  if (!isValidNickname(input.nickname)) errors.nickname = NICKNAME_RULE_MESSAGE;
  if (!isValidPassword(input.password)) errors.password = PASSWORD_RULE_MESSAGE;
  return errors;
}
