/**
 * economy 운영 패널의 **순수 로직** (#209 B안) — 입력 파싱·검증·표시 문구.
 *
 * 서버가 최종 권위(카탈로그 실재·기본팩 겹침까지 본다)지만, 클라도 같은 모양의 실수는 먼저 막는다.
 * 왕복 한 번을 아끼려는 게 아니라, **운영자가 무엇이 잘못됐는지 그 자리에서 알게** 하기 위해서다.
 */

/** 입력창(콤마·공백·줄바꿈 섞여 들어온다) → playerId 목록. 순서 보존, 빈 토큰 제거. */
export function parsePool(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export function formatPool(pool: readonly string[]): string {
  return pool.join(", ");
}

export interface StarterTopValidation {
  valid: boolean;
  pool: string[];
  count: number;
  /** 표시할 첫 번째 문제(없으면 null). */
  error: string | null;
}

/**
 * 교체 요청 검증 — 서버 검증(AdminEconomyService)의 클라 미러.
 * 서버만 아는 것(카탈로그 실재·기본팩 겹침)은 여기서 판정하지 않는다 — 흉내 내면 데이터가
 * 바뀔 때마다 두 곳이 어긋난다. 여기서는 **형태**만 본다.
 */
export function validateStarterTop(rawPool: string, rawCount: string, reason: string): StarterTopValidation {
  const pool = parsePool(rawPool);
  const count = Number(rawCount);
  const base = { pool, count: Number.isFinite(count) ? count : NaN };

  if (pool.length === 0) {
    return { ...base, valid: false, error: "후보를 최소 1명 입력하세요" };
  }
  if (new Set(pool).size !== pool.length) {
    return { ...base, valid: false, error: "중복된 playerId 가 있습니다" };
  }
  if (!Number.isInteger(count) || count < 1) {
    return { ...base, valid: false, error: "지급 장수는 1 이상의 정수여야 합니다" };
  }
  if (count > pool.length) {
    return { ...base, valid: false, error: `지급 장수는 후보 수(${pool.length}) 이하여야 합니다` };
  }
  if (!reason.trim()) {
    return { ...base, valid: false, error: "사유는 필수입니다(운영 이력에 남습니다)" };
  }
  return { ...base, valid: true, error: null };
}

/** 출처 뱃지 문구 — 운영자가 "지금 뭐가 먹고 있나"를 한눈에 본다. */
export function sourceLabel(source: string): string {
  switch (source) {
    case "OVERRIDE":
      return "운영 override 적용 중";
    case "BAKED":
      return "배포 발행물";
    default:
      return "설정 없음";
  }
}

/** 이력 한 줄의 사람 읽는 문구. */
export function actionLabel(action: string): string {
  switch (action) {
    case "economy_starter_top":
      return "최상위 후보 교체";
    case "economy_reload":
      return "리로드";
    case "economy_override_clear":
      return "발행물로 롤백";
    default:
      return action;
  }
}

/**
 * 교체가 위험한 변경인지 — 확인 한 단계를 더 요구할지 판단한다.
 * 후보를 **전부 갈아치우는** 변경은 되돌리기 전까지 모든 신규 가입에 즉시 영향을 준다.
 */
export function isFullReplacement(before: readonly string[], after: readonly string[]): boolean {
  if (before.length === 0) return false;
  return after.every((id) => !before.includes(id));
}

/**
 * 서버 응답을 화면이 쓸 수 있는 모양으로 **정규화**한다. 모양이 아니면 null.
 *
 * 왜 필요한가: 이 패널은 admin 페이지 안에 있어서, 여기서 던지면 <b>페이지 전체가 흰 화면</b>이
 * 된다(부분 실패·목킹·구버전 서버에서 `{}` 가 오는 경우가 실제로 있다 — 기존 admin 스펙이 그걸로
 * 깨졌다). 운영 화면은 값을 못 읽는 것보다 **아예 안 뜨는 것**이 훨씬 나쁘다.
 */
export function normalizeEconomyView(raw: unknown): NormalizedEconomyView | null {
  if (!raw || typeof raw !== "object") return null;
  const v = raw as Record<string, unknown>;
  const top = (v.starterTop ?? {}) as Record<string, unknown>;
  const pool = Array.isArray(top.pool) ? top.pool.filter((x): x is string => typeof x === "string") : null;
  if (pool === null) return null;   // starterTop 이 없는 응답 = 이 패널이 다룰 대상이 아니다
  return {
    source: typeof v.source === "string" ? v.source : "NONE",
    overrideApplied: v.overrideApplied === true,
    loadedAt: typeof v.loadedAt === "string" ? v.loadedAt : "",
    starterPackSize: typeof v.starterPackSize === "number" ? v.starterPackSize : 0,
    pool,
    count: typeof top.count === "number" && top.count > 0 ? top.count : 1,
  };
}

export interface NormalizedEconomyView {
  source: string;
  overrideApplied: boolean;
  loadedAt: string;
  starterPackSize: number;
  pool: string[];
  count: number;
}
