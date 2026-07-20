/**
 * admin 순수 로직 계약 (PRD-v4 §C, AC-C1/AC-C2).
 * 가드 분기와 지급 폼 검증을 여기 박제한다 — AdminPage/RequireAdmin 은 이 결과만 그린다.
 */
import { describe, expect, it } from "vitest";
import {
  LARGE_DELTA_THRESHOLD,
  MAX_REASON_LEN,
  adminGuardDecision,
  formatRecord,
  formatSignedDelta,
  formatStamp,
  isAdminUser,
  needsLargeConfirm,
  parseDelta,
  validateGrant,
} from "./admin-logic";

describe("isAdminUser — 필드 부재 = 비admin (additive optional)", () => {
  it("isAdmin === true 만 admin", () => {
    expect(isAdminUser({ isAdmin: true })).toBe(true);
  });

  it("false / 필드 없음 / user 없음 은 전부 비admin", () => {
    expect(isAdminUser({ isAdmin: false })).toBe(false);
    expect(isAdminUser({})).toBe(false); // Phase3 additive 미배포 서버
    expect(isAdminUser(null)).toBe(false);
    expect(isAdminUser(undefined)).toBe(false);
  });

  it("truthy 문자열 같은 값에 속지 않는다(엄격 비교)", () => {
    expect(isAdminUser({ isAdmin: "yes" as unknown as boolean })).toBe(false);
  });
});

describe("adminGuardDecision — /admin 라우트 분기", () => {
  const base = { hasToken: true, meLoading: false, meErrored: false, user: { isAdmin: true } };

  it("미로그인 → /login (me 상태와 무관)", () => {
    expect(adminGuardDecision({ ...base, hasToken: false })).toBe("login");
    expect(adminGuardDecision({ ...base, hasToken: false, meLoading: true })).toBe("login");
  });

  it("me 대기 중에는 admin 화면을 그리지 않는다(loading)", () => {
    expect(adminGuardDecision({ ...base, meLoading: true })).toBe("loading");
    // 비admin 이 확정되기 전에도 마찬가지 — 플래시 노출 0
    expect(adminGuardDecision({ ...base, meLoading: true, user: undefined })).toBe("loading");
  });

  it("로그인했지만 비admin → /lobby (화면 노출 0)", () => {
    expect(adminGuardDecision({ ...base, user: { isAdmin: false } })).toBe("lobby");
    expect(adminGuardDecision({ ...base, user: {} })).toBe("lobby"); // 필드 부재
    expect(adminGuardDecision({ ...base, user: null })).toBe("lobby");
  });

  it("me 조회 실패도 /lobby (판정 불가 = 거부)", () => {
    expect(adminGuardDecision({ ...base, meErrored: true })).toBe("lobby");
  });

  it("admin 이면 allow", () => {
    expect(adminGuardDecision(base)).toBe("allow");
  });
});

describe("parseDelta — 부호 포함 정수", () => {
  it("양수/음수/명시적 +, 공백 허용", () => {
    expect(parseDelta("500")).toBe(500);
    expect(parseDelta("+500")).toBe(500);
    expect(parseDelta("-300")).toBe(-300);
    expect(parseDelta("  -300  ")).toBe(-300);
  });

  it("빈값·0·소수·문자·기호는 null", () => {
    for (const bad of ["", "   ", "0", "+0", "-0", "1.5", "abc", "1e3", "--5", "5-", "٣"]) {
      expect(parseDelta(bad), bad).toBeNull();
    }
  });

  it("안전 정수 범위 밖은 null", () => {
    expect(parseDelta("9".repeat(20))).toBeNull();
  });
});

describe("validateGrant — 사유 필수(감사 로그, AC-C1)", () => {
  it("delta + 사유 둘 다 있어야 유효", () => {
    const v = validateGrant("500", "충전 요청 수동 처리");
    expect(v.valid).toBe(true);
    expect(v.delta).toBe(500);
    expect(v.reason).toBe("충전 요청 수동 처리");
    expect(v.errors).toEqual({});
  });

  it("사유가 비면(공백만 포함) 제출 불가", () => {
    expect(validateGrant("500", "").valid).toBe(false);
    expect(validateGrant("500", "   ").valid).toBe(false);
    expect(validateGrant("500", "   ").errors.reason).toBeTruthy();
  });

  it("delta 가 비거나 잘못되면 제출 불가 — 메시지가 구분된다", () => {
    expect(validateGrant("", "사유").errors.delta).toContain("입력");
    expect(validateGrant("abc", "사유").errors.delta).toContain("정수");
    expect(validateGrant("0", "사유").valid).toBe(false);
  });

  it("사유 길이 상한", () => {
    expect(validateGrant("1", "a".repeat(MAX_REASON_LEN)).valid).toBe(true);
    expect(validateGrant("1", "a".repeat(MAX_REASON_LEN + 1)).valid).toBe(false);
  });

  it("차감(음수)도 동일하게 유효", () => {
    const v = validateGrant("-1000", "환불");
    expect(v.valid).toBe(true);
    expect(v.delta).toBe(-1000);
  });
});

describe("needsLargeConfirm — |delta| > 100000 확인 모달", () => {
  it("경계값 자체는 확인 없이 통과", () => {
    expect(needsLargeConfirm(LARGE_DELTA_THRESHOLD)).toBe(false);
    expect(needsLargeConfirm(-LARGE_DELTA_THRESHOLD)).toBe(false);
  });

  it("초과는 부호 무관 확인", () => {
    expect(needsLargeConfirm(LARGE_DELTA_THRESHOLD + 1)).toBe(true);
    expect(needsLargeConfirm(-(LARGE_DELTA_THRESHOLD + 1))).toBe(true);
  });

  it("소액은 확인 없음", () => {
    expect(needsLargeConfirm(500)).toBe(false);
  });
});

describe("표시 포맷", () => {
  it("formatSignedDelta 는 부호를 항상 표시", () => {
    expect(formatSignedDelta(500)).toBe("+500");
    expect(formatSignedDelta(-300)).toBe("−300");
    expect(formatSignedDelta(1234567)).toBe("+1,234,567");
  });

  it("formatRecord", () => {
    expect(formatRecord(3, 1, 2)).toBe("3승 1무 2패");
  });

  it("formatStamp 는 파싱 실패 시 원문 유지(깨짐 0)", () => {
    expect(formatStamp("not-a-date")).toBe("not-a-date");
    expect(formatStamp("2026-07-20T10:30:00Z")).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });
});
