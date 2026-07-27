/**
 * 어드민 유닛 카탈로그 순수 로직 계약 (#207 웨이브2-C).
 *
 * 여기서 박제하는 것 = openapi(admin units) 가 요구하는 클라 측 규약:
 *  · 사유 필수 · PATCH 는 diff 만(attributes 키 단위 병합) · 변경 0건은 제출 불가
 *  · 409 두 종류(등급하향 고지 / 멱등키 충돌) 구분 · 멱등키는 항상 헤더로.
 */
import { describe, expect, it } from "vitest";
import { ApiError } from "../api/client";
import {
  ADMIN_UNITS_PATH,
  newIdempotencyKey,
  unitMutationInit,
} from "../api/admin-unit-hooks";
import {
  ATTRIBUTE_KEYS,
  auditChangeSummary,
  buildCreateRequest,
  buildPatchRequest,
  describeGradeImpact,
  emptyUnitForm,
  formatOvrDelta,
  isGradeDowngrade,
  parseAttribute,
  parseGradeImpact,
  unitFormFromUnit,
  unitListQuery,
  validateUnitCreate,
  validateUnitPatch,
} from "./admin-units-logic";
import type { AdminUnit, AdminUnitAuditEntry, AdminUnitGradeImpact } from "./admin-units-logic";

const UNIT: AdminUnit = {
  id: "P005",
  name: "유라도나",
  position: "MF",
  grade: "LEGEND",
  attributes: {
    technical: 93,
    mental: 95,
    physical: 92,
    passing: 93,
    shooting: 95,
    tackling: 86,
    pace: 93,
    stamina: 95,
    positioning: 89,
  },
  personality: "FIERY",
  active: true,
  adminLocked: false,
  dataVersion: "v2.1",
};

function editable() {
  const form = unitFormFromUnit(UNIT);
  form.reason = "밸런스 조정";
  return form;
}

describe("unitListQuery", () => {
  it("빈 필터는 키 자체를 보내지 않는다", () => {
    expect(unitListQuery({ q: "   ", grade: "", position: "", active: null })).toBe("");
  });

  it("active=false 는 유효한 필터라 살아남는다(falsy 함정)", () => {
    expect(unitListQuery({ active: false })).toBe("?active=false");
    expect(unitListQuery({ active: true })).toBe("?active=true");
  });

  it("검색어·등급·포지션·페이징을 인코딩해 붙인다", () => {
    const qs = unitListQuery({ q: "유라 도나", grade: "LEGEND", position: "MF", limit: 25, offset: 50 });
    expect(qs).toContain("q=%EC%9C%A0%EB%9D%BC+%EB%8F%84%EB%82%98");
    expect(qs).toContain("grade=LEGEND");
    expect(qs).toContain("position=MF");
    expect(qs).toContain("limit=25");
    expect(qs).toContain("offset=50");
  });

  it("offset 0 은 생략한다(기본 페이지)", () => {
    expect(unitListQuery({ offset: 0 })).toBe("");
  });
});

describe("등급 하향 판정", () => {
  it("GRADE_ORDER 기준 아래로 가면 하향", () => {
    expect(isGradeDowngrade("LEGEND", "DIA")).toBe(true);
    expect(isGradeDowngrade("DIA", "LEGEND")).toBe(false);
    expect(isGradeDowngrade("GOLD", "GOLD")).toBe(false);
  });
});

describe("parseGradeImpact — 409 두 종류 구분", () => {
  const impact: AdminUnitGradeImpact = {
    fromGrade: "LEGEND",
    toGrade: "DIA",
    capLowered: true,
    affectedUsers: 12,
    avgOvrDelta: -3.24,
    worstOvrDelta: -7.33,
    computed: true,
  };

  it("등급하향 409(detail=AdminUnitGradeImpact)는 영향으로 파싱된다", () => {
    const err = new ApiError(409, { code: "CONFLICT", message: "confirm required", detail: impact });
    expect(parseGradeImpact(err)).toEqual(impact);
  });

  it("멱등키 충돌 409(detail 없음)는 영향이 아니다 — 확인 다이얼로그를 띄우면 안 된다", () => {
    const err = new ApiError(409, { code: "CONFLICT", message: "idem key reused" });
    expect(parseGradeImpact(err)).toBeNull();
  });

  it("detail 이 있어도 모양이 다르면 영향이 아니다", () => {
    const err = new ApiError(409, {
      code: "CONFLICT",
      message: "x",
      detail: { idemKey: "k1" },
    });
    expect(parseGradeImpact(err)).toBeNull();
  });

  it("409 가 아닌 오류는 영향이 아니다", () => {
    expect(parseGradeImpact(new ApiError(400, { code: "VALIDATION_ERROR", message: "x", detail: impact }))).toBeNull();
    expect(parseGradeImpact(new Error("boom"))).toBeNull();
  });

  it("computed=false 는 숫자를 단정하지 않는 문구로 고지한다", () => {
    const text = describeGradeImpact({ ...impact, computed: false, avgOvrDelta: 0, worstOvrDelta: 0 });
    expect(text).toContain("계산하지 못했습니다");
    expect(text).not.toContain("평균 0.0 OVR");
  });

  it("computed=true 는 N명·평균·최악을 문장으로 보여준다", () => {
    expect(describeGradeImpact(impact)).toBe(
      "이 변경으로 12명의 카드가 평균 −3.2 OVR (최악 −7.3 OVR)",
    );
  });
});

describe("formatOvrDelta", () => {
  it("부호 고정 + 소수 1자리", () => {
    expect(formatOvrDelta(-3.24)).toBe("−3.2");
    expect(formatOvrDelta(1.25)).toBe("+1.3");
    expect(formatOvrDelta(0)).toBe("0.0");
  });
});

describe("parseAttribute", () => {
  it("0~100 정수만 통과", () => {
    expect(parseAttribute("0")).toBe(0);
    expect(parseAttribute(" 93 ")).toBe(93);
    expect(parseAttribute("100")).toBe(100);
    expect(parseAttribute("101")).toBeNull();
    expect(parseAttribute("")).toBeNull();
    expect(parseAttribute("9.5")).toBeNull();
    expect(parseAttribute("-3")).toBeNull();
  });
});

describe("validateUnitCreate", () => {
  it("사유가 비면 무효", () => {
    const form = emptyUnitForm();
    form.name = "권씨";
    for (const k of ATTRIBUTE_KEYS) form.attributes[k] = "80";
    expect(validateUnitCreate(form).valid).toBe(false);
    form.reason = "신규 유닛 투입";
    expect(validateUnitCreate(form).valid).toBe(true);
  });

  it("능력치 9종 중 하나라도 비면 무효(openapi: 누락 400)", () => {
    const form = emptyUnitForm();
    form.name = "권씨";
    form.reason = "신규";
    for (const k of ATTRIBUTE_KEYS) form.attributes[k] = "80";
    form.attributes.pace = "";
    const v = validateUnitCreate(form);
    expect(v.valid).toBe(false);
    expect(v.errors.attributes?.pace).toBeTruthy();
  });

  it("바디는 9종 전부 + 사유를 담는다", () => {
    const form = emptyUnitForm();
    form.name = " 권씨 ";
    form.position = "FW";
    form.grade = "LEGEND";
    form.personality = "AMBITIOUS";
    form.reason = " 신규 유닛 투입 ";
    for (const k of ATTRIBUTE_KEYS) form.attributes[k] = "80";
    const body = buildCreateRequest(form);
    expect(body.name).toBe("권씨");
    expect(body.reason).toBe("신규 유닛 투입");
    expect(body.position).toBe("FW");
    expect(body.grade).toBe("LEGEND");
    expect(Object.keys(body.attributes).sort()).toEqual([...ATTRIBUTE_KEYS].sort());
  });
});

describe("validateUnitPatch / buildPatchRequest", () => {
  it("아무것도 안 바꾸면 제출 불가", () => {
    const v = validateUnitPatch(editable(), UNIT);
    expect(v.valid).toBe(false);
    expect(v.errors.form).toBe("변경된 필드가 없습니다");
  });

  it("사유가 비면 제출 불가(변경이 있어도)", () => {
    const form = unitFormFromUnit(UNIT);
    form.attributes.pace = "90";
    const v = validateUnitPatch(form, UNIT);
    expect(v.valid).toBe(false);
    expect(v.errors.reason).toBe("사유는 필수입니다");
  });

  it("바뀐 능력치 키만 담는다(키 단위 병합 — 나머지 8종을 다시 보내지 않는다)", () => {
    const form = editable();
    form.attributes.pace = "90";
    const v = validateUnitPatch(form, UNIT);
    expect(v.valid).toBe(true);
    expect(v.changedFields).toEqual(["attributes"]);
    const body = buildPatchRequest(form, UNIT);
    expect(body.attributes).toEqual({ pace: 90 });
    expect(body.reason).toBe("밸런스 조정");
    expect(body.name).toBeUndefined();
    expect(body.grade).toBeUndefined();
  });

  it("이름·포지션·등급·성격·활성 변경이 각각 diff 로 잡힌다", () => {
    const form = editable();
    form.name = "유라도나2";
    form.position = "FW";
    form.grade = "DIA";
    form.personality = "CALM";
    form.active = false;
    const v = validateUnitPatch(form, UNIT);
    expect(v.changedFields).toEqual(["name", "position", "grade", "personality", "active"]);
    const body = buildPatchRequest(form, UNIT);
    expect(body).toEqual({
      reason: "밸런스 조정",
      name: "유라도나2",
      position: "FW",
      grade: "DIA",
      personality: "CALM",
      active: false,
    });
  });

  it("등급 하향은 downgrade 로 표시된다(사전 경고용)", () => {
    const form = editable();
    form.grade = "DIA";
    expect(validateUnitPatch(form, UNIT).downgrade).toEqual({ from: "LEGEND", to: "DIA" });
  });

  it("confirmImpact 는 확인한 뒤에만 붙는다", () => {
    const form = editable();
    form.grade = "DIA";
    expect(buildPatchRequest(form, UNIT).confirmImpact).toBeUndefined();
    expect(buildPatchRequest(form, UNIT, { confirmImpact: true }).confirmImpact).toBe(true);
  });

  it("능력치 입력이 깨지면 무효", () => {
    const form = editable();
    form.attributes.pace = "999";
    const v = validateUnitPatch(form, UNIT);
    expect(v.valid).toBe(false);
    expect(v.errors.attributes?.pace).toBeTruthy();
  });
});

describe("멱등키 (운영 UI 재전송 보호)", () => {
  it("변경 요청 init 에는 항상 Idempotency-Key 헤더가 실린다", () => {
    const init = unitMutationInit("PATCH", "k1", { reason: "r" });
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k1");
    expect(init.method).toBe("PATCH");
    expect(init.body).toEqual({ reason: "r" });
  });

  it("바디 없는 동사도 헤더는 실린다", () => {
    const init = unitMutationInit("DELETE", "k2");
    expect((init.headers as Record<string, string>)["Idempotency-Key"]).toBe("k2");
    expect(init.body).toBeUndefined();
  });

  it("채번 키는 매번 다르다(재요청이 같은 키로 나가지 않도록)", () => {
    const keys = new Set(Array.from({ length: 8 }, () => newIdempotencyKey()));
    expect(keys.size).toBe(8);
  });

  it("경로 상수는 계약 그대로", () => {
    expect(ADMIN_UNITS_PATH).toBe("/api/admin/units");
  });
});

describe("auditChangeSummary", () => {
  const base: AdminUnitAuditEntry = {
    id: "A1",
    actorUserId: "admin1",
    playerId: "P005",
    action: "unit_update",
    changedFields: ["grade"],
    reason: "밸런스",
    createdAt: "2026-07-27T01:00:00Z",
    before: { grade: "LEGEND" },
    after: { grade: "DIA" },
  };

  it("이전값 → 새값 으로 읽힌다", () => {
    expect(auditChangeSummary(base)).toBe("grade: LEGEND → DIA");
  });

  it("attributes 는 달라진 하위 키만 편다(9종 나열 금지)", () => {
    const e: AdminUnitAuditEntry = {
      ...base,
      changedFields: ["attributes"],
      before: { attributes: { pace: 93, shooting: 95 } },
      after: { attributes: { pace: 90, shooting: 95 } },
    };
    expect(auditChangeSummary(e)).toBe("attributes: pace 93 → 90");
  });

  it("생성(before 없음)도 깨지지 않는다", () => {
    const e: AdminUnitAuditEntry = {
      ...base,
      action: "unit_create",
      changedFields: ["name"],
      before: {},
      after: { name: "권씨" },
    };
    expect(auditChangeSummary(e)).toBe("name: — → 권씨");
  });

  it("changedFields 가 비면 대시", () => {
    expect(auditChangeSummary({ ...base, changedFields: [] })).toBe("—");
  });
});
