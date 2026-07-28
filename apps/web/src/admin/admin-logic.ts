/**
 * admin 페이지 순수 로직 (PRD-v4 §C, AC-C1/AC-C2).
 *
 * 렌더/네트워크와 분리된 결정 함수들 — 라우트 가드 분기와 포인트 지급 폼 검증.
 * UI 는 이 함수들의 결과만 그린다(테스트가 이 파일을 직접 박제).
 */

/** admin 플래그 판정. `isAdmin` 필드 부재 = 비admin (p3.ts MeResponseP3 는 additive optional). */
export function isAdminUser(user: { isAdmin?: boolean } | null | undefined): boolean {
  return user?.isAdmin === true;
}

/** /admin 라우트 가드의 결정 결과. */
export type AdminGuardDecision =
  | "login" // 미로그인 → /login
  | "loading" // /api/me 대기 — 아직 아무것도 노출하지 않는다
  | "lobby" // 로그인했으나 비admin(또는 me 조회 실패) → /lobby (화면 노출 0)
  | "allow";

export interface AdminGuardInput {
  hasToken: boolean;
  meLoading: boolean;
  meErrored: boolean;
  user: { isAdmin?: boolean } | null | undefined;
}

/**
 * 가드 분기. 순서가 계약이다:
 * 토큰 없음 → login / me 미도착 → loading / (에러 or 비admin) → lobby / admin → allow.
 * 판정 불가 구간에서 admin 화면을 절대 먼저 그리지 않는다(플래시 노출 0).
 */
export function adminGuardDecision(input: AdminGuardInput): AdminGuardDecision {
  if (!input.hasToken) return "login";
  if (input.meLoading) return "loading";
  if (input.meErrored) return "lobby";
  return isAdminUser(input.user) ? "allow" : "lobby";
}

/** |delta| 가 이 값을 넘으면 확인 모달을 거친다(오타로 인한 대량 지급 방지). */
export const LARGE_DELTA_THRESHOLD = 100_000;
/** 사유 최대 길이 — 원장에 남는 감사 문자열. */
export const MAX_REASON_LEN = 200;

/**
 * 부호 포함 정수 파싱. "+500" "-300" "500" 허용, 공백 무시.
 * 빈값·소수·0·비정수·범위밖은 null(= 제출 불가).
 */
export function parseDelta(raw: string): number | null {
  const s = raw.trim();
  if (!/^[+-]?\d+$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n === 0) return null;
  return n;
}

export interface GrantFormErrors {
  delta?: string;
  reason?: string;
}

export interface GrantValidation {
  valid: boolean;
  delta: number | null;
  reason: string;
  errors: GrantFormErrors;
}

/** 지급/차감 폼 검증 — 사유는 **필수**(감사 로그가 비면 안 됨, AC-C1). */
export function validateGrant(deltaRaw: string, reasonRaw: string): GrantValidation {
  const delta = parseDelta(deltaRaw);
  const reason = reasonRaw.trim();
  const errors: GrantFormErrors = {};

  if (deltaRaw.trim() === "") errors.delta = "증감값을 입력하세요";
  else if (delta === null) errors.delta = "0이 아닌 정수를 입력하세요 (예: 500, -300)";

  if (reason === "") errors.reason = "사유는 필수입니다";
  else if (reason.length > MAX_REASON_LEN) errors.reason = `사유는 ${MAX_REASON_LEN}자 이내로 입력하세요`;

  return { valid: Object.keys(errors).length === 0, delta, reason, errors };
}

/** 큰 값은 확인 모달을 거친다. */
export function needsLargeConfirm(delta: number): boolean {
  return Math.abs(delta) > LARGE_DELTA_THRESHOLD;
}

/** 원장/미리보기 표시용 부호 고정 포맷. */
export function formatSignedDelta(n: number): string {
  return `${n > 0 ? "+" : "−"}${Math.abs(n).toLocaleString("en-US")}`;
}

/** 전적 요약 문자열(표 셀). */
export function formatRecord(wins: number, draws: number, losses: number): string {
  return `${wins}승 ${draws}무 ${losses}패`;
}

/** ISO 문자열 → 표 표시용 짧은 형식. 파싱 실패 시 원문 그대로(깨짐 0). */
export function formatStamp(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
