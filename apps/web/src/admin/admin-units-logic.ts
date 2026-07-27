/**
 * 어드민 유닛 카탈로그 순수 로직 (에픽 #207 파트 A / 웨이브2-C).
 *
 * 계약 SoT = `docs/plan-v2/api/openapi.yaml` 의 admin units 섹션(생성 타입 `../api/schema`).
 * 여기 있는 함수들은 렌더·네트워크와 무관한 결정 함수다 — UI 는 결과만 그리고,
 * 테스트는 이 파일을 직접 박제한다(AdminPage 의 `admin-logic.ts` 관례 그대로).
 *
 * 이 모듈이 지키는 계약 3개:
 *  1) **사유 필수** — reason 이 비면 어떤 변경도 제출할 수 없다(감사 원장이 비면 안 된다).
 *  2) **PATCH 는 바뀐 필드만** — attributes 는 키 단위 병합이라 손대지 않은 스탯을 다시 보내지 않는다.
 *  3) **등급 하향 = 확인 경유** — 서버 409(detail=AdminUnitGradeImpact)는 에러가 아니라
 *     "운영자에게 물어봐야 하는 상태"다. `parseGradeImpact` 가 그 409 만 골라낸다.
 */
import type { components } from "../api/schema";
import { ApiError } from "../api/client";
import { GRADE_ORDER } from "../common/grades";
import type { Grade } from "../common/grades";

export type AdminUnit = components["schemas"]["AdminUnit"];
export type AdminUnitPage = components["schemas"]["AdminUnitPage"];
export type AdminUnitDetail = components["schemas"]["AdminUnitDetail"];
export type AdminUnitAuditEntry = components["schemas"]["AdminUnitAuditEntry"];
export type AdminUnitGradeImpact = components["schemas"]["AdminUnitGradeImpact"];
export type AdminUnitMutationResult = components["schemas"]["AdminUnitMutationResult"];
export type AdminUnitCreateRequest = components["schemas"]["AdminUnitCreateRequest"];
export type AdminUnitPatchRequest = components["schemas"]["AdminUnitPatchRequest"];
export type PlayerAttributes = components["schemas"]["PlayerAttributes"];
export type Position = components["schemas"]["Position"];
export type Personality = AdminUnit["personality"];

/** openapi PlayerAttributes 의 9종 — 순서까지 계약(폼 입력 순서 = 서버 스키마 순서). */
export const ATTRIBUTE_KEYS = [
  "technical",
  "mental",
  "physical",
  "passing",
  "shooting",
  "tackling",
  "pace",
  "stamina",
  "positioning",
] as const;
export type AttributeKey = (typeof ATTRIBUTE_KEYS)[number];

export const ATTRIBUTE_LABELS: Record<AttributeKey, string> = {
  technical: "테크닉",
  mental: "멘탈",
  physical: "피지컬",
  passing: "패스",
  shooting: "슈팅",
  tackling: "태클",
  pace: "스피드",
  stamina: "체력",
  positioning: "위치선정",
};

export const POSITIONS: Position[] = ["GK", "DF", "MF", "FW"];
export const PERSONALITIES: Personality[] = ["FIERY", "CALM", "GLASS", "AMBITIOUS"];
export const PERSONALITY_LABELS: Record<Personality, string> = {
  FIERY: "열혈",
  CALM: "침착",
  GLASS: "유리",
  AMBITIOUS: "야심",
};

/** openapi `AdminReasonRequest.reason.maxLength` / `AdminUnitCreateRequest.name.maxLength`. */
export const MAX_UNIT_REASON_LEN = 500;
export const MAX_UNIT_NAME_LEN = 60;
/** 목록 페이지 크기(GET /api/admin/units?limit=). */
export const UNIT_PAGE_SIZE = 25;

/* ───────────────────────────── 목록 질의 ───────────────────────────── */

export interface UnitListParams {
  q?: string;
  grade?: Grade | "";
  position?: Position | "";
  /** null = 전체(필터 없음). true/false = 활성/비활성만. */
  active?: boolean | null;
  limit?: number;
  offset?: number;
}

/**
 * GET /api/admin/units 의 쿼리스트링. 빈 필터는 **키 자체를 보내지 않는다** —
 * `active=` 같은 빈 값을 보내면 서버가 400(VALIDATION_ERROR)을 낼 수 있다.
 * `active=false` 는 빈 값이 아니라 **유효한 필터**라 반드시 살아남아야 한다(falsy 함정).
 */
export function unitListQuery(params: UnitListParams): string {
  const sp = new URLSearchParams();
  const q = params.q?.trim();
  if (q) sp.set("q", q);
  if (params.grade) sp.set("grade", params.grade);
  if (params.position) sp.set("position", params.position);
  if (params.active === true || params.active === false) sp.set("active", String(params.active));
  if (params.limit !== undefined) sp.set("limit", String(params.limit));
  if (params.offset) sp.set("offset", String(params.offset));
  const s = sp.toString();
  return s ? `?${s}` : "";
}

/* ───────────────────────────── 등급 하향 판정 ───────────────────────────── */

/** GRADE_ORDER 인덱스 비교. 알 수 없는 등급은 하향으로 보지 않는다(서버 판정이 최종). */
export function isGradeDowngrade(from: Grade, to: Grade): boolean {
  const a = GRADE_ORDER.indexOf(from);
  const b = GRADE_ORDER.indexOf(to);
  if (a < 0 || b < 0) return false;
  return b < a;
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * 409 응답에서 **등급 하향 영향 고지**만 골라낸다.
 *
 * 409 는 두 가지다 — ① 등급 하향인데 confirmImpact 가 없다(detail = AdminUnitGradeImpact)
 * ② 멱등키 충돌. ②를 확인 다이얼로그로 띄우면 운영자가 "확인"을 눌러 같은 충돌을 반복한다.
 * 그래서 상태코드가 아니라 **detail 모양**으로 구분한다.
 */
export function parseGradeImpact(err: unknown): AdminUnitGradeImpact | null {
  if (!(err instanceof ApiError) || err.status !== 409) return null;
  const d = err.detail;
  if (!d || typeof d !== "object") return null;
  const o = d as Record<string, unknown>;
  if (typeof o.fromGrade !== "string" || typeof o.toGrade !== "string") return null;
  if (!isFiniteNumber(o.affectedUsers)) return null;
  if (!isFiniteNumber(o.avgOvrDelta) || !isFiniteNumber(o.worstOvrDelta)) return null;
  return {
    fromGrade: o.fromGrade as Grade,
    toGrade: o.toGrade as Grade,
    capLowered: o.capLowered === true,
    affectedUsers: o.affectedUsers,
    avgOvrDelta: o.avgOvrDelta,
    worstOvrDelta: o.worstOvrDelta,
    computed: o.computed !== false,
  };
}

/** OVR 델타 표기 — 부호 고정 + 소수 1자리("−3.2"). 0 도 부호 없이 "0.0". */
export function formatOvrDelta(n: number): string {
  if (!Number.isFinite(n)) return "—";
  const abs = Math.abs(n).toFixed(1);
  if (Number(abs) === 0) return "0.0";
  return `${n > 0 ? "+" : "−"}${abs}`;
}

/**
 * 확인 다이얼로그 본문 한 줄. `computed=false` 는 "영향 0"이 아니라 **미계산**이므로
 * 숫자를 자신 있게 보여주면 안 된다(운영자가 0 을 안전 신호로 읽는다).
 */
export function describeGradeImpact(impact: AdminUnitGradeImpact): string {
  if (!impact.computed) {
    return `보유 유저 ${impact.affectedUsers}명 — 영향 규모를 계산하지 못했습니다(0 = 영향 없음 아님)`;
  }
  return `이 변경으로 ${impact.affectedUsers}명의 카드가 평균 ${formatOvrDelta(impact.avgOvrDelta)} OVR (최악 ${formatOvrDelta(impact.worstOvrDelta)} OVR)`;
}

/* ───────────────────────────── 폼 상태 ───────────────────────────── */

export interface UnitFormState {
  name: string;
  position: Position;
  grade: Grade;
  personality: Personality;
  active: boolean;
  /** 원문 입력값(문자열) — 파싱/검증은 `validateUnitForm` 이 한다. */
  attributes: Record<AttributeKey, string>;
  reason: string;
}

function blankAttributes(fill: (k: AttributeKey) => string): Record<AttributeKey, string> {
  const out = {} as Record<AttributeKey, string>;
  for (const k of ATTRIBUTE_KEYS) out[k] = fill(k);
  return out;
}

export function emptyUnitForm(): UnitFormState {
  return {
    name: "",
    position: "MF",
    grade: "BRONZE",
    personality: "CALM",
    active: true,
    attributes: blankAttributes(() => ""),
    reason: "",
  };
}

/** 상세에서 편집 폼으로 — 서버 현재값이 초기값이다(수정 = 이 값에서의 diff). */
export function unitFormFromUnit(u: AdminUnit): UnitFormState {
  return {
    name: u.name,
    position: u.position,
    grade: u.grade,
    personality: u.personality,
    active: u.active,
    attributes: blankAttributes((k) => String(u.attributes[k])),
    reason: "",
  };
}

/** 0~100 정수만 통과. 빈값·소수·범위밖은 null. */
export function parseAttribute(raw: string): number | null {
  const s = raw.trim();
  if (!/^\d{1,3}$/.test(s)) return null;
  const n = Number(s);
  return n >= 0 && n <= 100 ? n : null;
}

export interface UnitFormErrors {
  name?: string;
  reason?: string;
  attributes?: Partial<Record<AttributeKey, string>>;
  /** 폼 전체 수준(변경 없음 등). */
  form?: string;
}

export interface UnitFormValidation {
  valid: boolean;
  errors: UnitFormErrors;
  /** PATCH 에서 실제로 달라진 필드 이름(표시·확인용). create 는 항상 빈 배열. */
  changedFields: string[];
  /** 등급 하향이면 (from, to). 아니면 null — 미리 경고를 띄우는 데 쓴다. */
  downgrade: { from: Grade; to: Grade } | null;
}

function validateCommon(form: UnitFormState, errors: UnitFormErrors): void {
  const reason = form.reason.trim();
  if (reason === "") errors.reason = "사유는 필수입니다";
  else if (reason.length > MAX_UNIT_REASON_LEN)
    errors.reason = `사유는 ${MAX_UNIT_REASON_LEN}자 이내로 입력하세요`;
}

/** 신규 생성 폼 검증 — 9종 능력치가 **전부** 있어야 한다(openapi: 누락 시 400). */
export function validateUnitCreate(form: UnitFormState): UnitFormValidation {
  const errors: UnitFormErrors = {};
  const name = form.name.trim();
  if (name === "") errors.name = "이름은 필수입니다";
  else if (name.length > MAX_UNIT_NAME_LEN)
    errors.name = `이름은 ${MAX_UNIT_NAME_LEN}자 이내로 입력하세요`;

  const attrErrors: Partial<Record<AttributeKey, string>> = {};
  for (const k of ATTRIBUTE_KEYS) {
    if (parseAttribute(form.attributes[k]) === null) attrErrors[k] = "0~100 정수";
  }
  if (Object.keys(attrErrors).length > 0) errors.attributes = attrErrors;

  validateCommon(form, errors);
  return {
    valid: Object.keys(errors).length === 0,
    errors,
    changedFields: [],
    downgrade: null,
  };
}

export function buildCreateRequest(form: UnitFormState): AdminUnitCreateRequest {
  const attributes = {} as PlayerAttributes;
  for (const k of ATTRIBUTE_KEYS) attributes[k] = parseAttribute(form.attributes[k]) ?? 0;
  return {
    name: form.name.trim(),
    position: form.position,
    grade: form.grade,
    attributes,
    personality: form.personality,
    active: form.active,
    reason: form.reason.trim(),
  };
}

/**
 * 수정 폼 검증 — **바뀐 필드가 0개면 무효**(openapi: 400). 능력치는 값이 달라진 키만 본다.
 */
export function validateUnitPatch(form: UnitFormState, base: AdminUnit): UnitFormValidation {
  const errors: UnitFormErrors = {};
  const name = form.name.trim();
  if (name === "") errors.name = "이름은 필수입니다";
  else if (name.length > MAX_UNIT_NAME_LEN)
    errors.name = `이름은 ${MAX_UNIT_NAME_LEN}자 이내로 입력하세요`;

  const attrErrors: Partial<Record<AttributeKey, string>> = {};
  const changedAttrs: AttributeKey[] = [];
  for (const k of ATTRIBUTE_KEYS) {
    const parsed = parseAttribute(form.attributes[k]);
    if (parsed === null) {
      attrErrors[k] = "0~100 정수";
      continue;
    }
    if (parsed !== base.attributes[k]) changedAttrs.push(k);
  }
  if (Object.keys(attrErrors).length > 0) errors.attributes = attrErrors;

  const changedFields: string[] = [];
  if (name !== base.name && name !== "") changedFields.push("name");
  if (form.position !== base.position) changedFields.push("position");
  if (form.grade !== base.grade) changedFields.push("grade");
  if (form.personality !== base.personality) changedFields.push("personality");
  if (form.active !== base.active) changedFields.push("active");
  if (changedAttrs.length > 0) changedFields.push("attributes");

  validateCommon(form, errors);
  if (changedFields.length === 0 && !errors.attributes) errors.form = "변경된 필드가 없습니다";

  return {
    valid: Object.keys(errors).length === 0,
    errors,
    changedFields,
    downgrade: isGradeDowngrade(base.grade, form.grade)
      ? { from: base.grade, to: form.grade }
      : null,
  };
}

/**
 * PATCH 바디 — **지정한 필드만** 담는다(키 단위 병합 계약).
 * `confirmImpact` 는 등급 하향 409 를 운영자가 확인한 **뒤에만** 붙는다.
 */
export function buildPatchRequest(
  form: UnitFormState,
  base: AdminUnit,
  opts: { confirmImpact?: boolean } = {},
): AdminUnitPatchRequest {
  const body: AdminUnitPatchRequest = { reason: form.reason.trim() };
  const name = form.name.trim();
  if (name !== base.name) body.name = name;
  if (form.position !== base.position) body.position = form.position;
  if (form.grade !== base.grade) body.grade = form.grade;
  if (form.personality !== base.personality) body.personality = form.personality;
  if (form.active !== base.active) body.active = form.active;

  const attributes: Record<string, number> = {};
  for (const k of ATTRIBUTE_KEYS) {
    const parsed = parseAttribute(form.attributes[k]);
    if (parsed !== null && parsed !== base.attributes[k]) attributes[k] = parsed;
  }
  if (Object.keys(attributes).length > 0) body.attributes = attributes;

  if (opts.confirmImpact) body.confirmImpact = true;
  return body;
}

/* ───────────────────────────── 표시 헬퍼 ───────────────────────────── */

export const AUDIT_ACTION_LABELS: Record<AdminUnitAuditEntry["action"], string> = {
  unit_create: "생성",
  unit_update: "수정",
  unit_deactivate: "비활성",
  unit_activate: "활성",
  unit_override_reset: "시드복원",
};

/**
 * 감사 한 줄의 "무엇이 · 이전값 → 새값". before/after 는 전체 스냅샷이라
 * `changedFields` 로 좁혀 읽는다(스냅샷 전체를 늘어놓으면 사람이 못 읽는다).
 */
export function auditChangeSummary(entry: AdminUnitAuditEntry): string {
  const fields = entry.changedFields ?? [];
  if (fields.length === 0) return "—";
  const before = (entry.before ?? {}) as Record<string, unknown>;
  const after = (entry.after ?? {}) as Record<string, unknown>;
  return fields
    .map((f) => {
      if (isPlainObject(before[f]) || isPlainObject(after[f])) return nestedDiff(f, before[f], after[f]);
      const b = snapshotValue(before[f]);
      const a = snapshotValue(after[f]);
      if (b === null && a === null) return f;
      return `${f}: ${b ?? "—"} → ${a ?? "—"}`;
    })
    .join(" · ");
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * attributes 처럼 중첩된 필드는 **달라진 하위 키만** 편다.
 * 전체 스냅샷을 그대로 늘어놓으면 9종이 다 찍혀 "무엇이 바뀌었나"가 묻힌다.
 */
function nestedDiff(field: string, b: unknown, a: unknown): string {
  const bo = isPlainObject(b) ? b : {};
  const ao = isPlainObject(a) ? a : {};
  const keys = Array.from(new Set([...Object.keys(bo), ...Object.keys(ao)]));
  const parts = keys
    .filter((k) => String(bo[k]) !== String(ao[k]))
    .map((k) => `${k} ${snapshotValue(bo[k]) ?? "—"} → ${snapshotValue(ao[k]) ?? "—"}`);
  return parts.length === 0 ? field : `${field}: ${parts.join(", ")}`;
}

function snapshotValue(v: unknown): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>);
    if (entries.length === 0) return null;
    return entries.map(([k, val]) => `${k}=${String(val)}`).join(",");
  }
  return String(v);
}
