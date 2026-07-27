/**
 * economy 운영 패널 순수 로직 (#209 B안).
 *
 * 여기서 지키는 선: **형태 검증은 클라가, 데이터 검증은 서버가.** 카탈로그 실재·기본팩 겹침을
 * 클라가 흉내 내면 데이터가 바뀔 때마다 두 곳이 어긋난다(그때 조용히 틀리는 쪽은 항상 클라다).
 */
import { describe, expect, it } from "vitest";
import {
  actionLabel,
  normalizeEconomyView,
  formatPool,
  isFullReplacement,
  parsePool,
  sourceLabel,
  validateStarterTop,
} from "./economy-logic";

describe("parsePool", () => {
  it("콤마·공백·줄바꿈이 섞여도 id 만 순서대로 뽑는다", () => {
    expect(parsePool("P001, P003\nP005  P009,")).toEqual(["P001", "P003", "P005", "P009"]);
  });

  it("빈 입력은 빈 목록", () => {
    expect(parsePool("   \n , ")).toEqual([]);
  });

  it("formatPool 은 parsePool 의 역방향(왕복 보존)", () => {
    const pool = ["P001", "P025"];
    expect(parsePool(formatPool(pool))).toEqual(pool);
  });
});

describe("validateStarterTop", () => {
  it("정상 입력", () => {
    const v = validateStarterTop("P001, P003", "1", "레전드 개편");
    expect(v.valid).toBe(true);
    expect(v.pool).toEqual(["P001", "P003"]);
    expect(v.count).toBe(1);
    expect(v.error).toBeNull();
  });

  it("빈 후보 · 중복 · 사유 누락은 거절", () => {
    expect(validateStarterTop("", "1", "r").error).toMatch(/최소 1명/);
    expect(validateStarterTop("P001 P001", "1", "r").error).toMatch(/중복/);
    expect(validateStarterTop("P001", "1", "  ").error).toMatch(/사유/);
  });

  it("장수는 1 이상의 정수이고 후보 수를 넘지 못한다", () => {
    expect(validateStarterTop("P001 P003", "0", "r").error).toMatch(/1 이상/);
    expect(validateStarterTop("P001 P003", "1.5", "r").error).toMatch(/1 이상/);
    expect(validateStarterTop("P001 P003", "", "r").error).toMatch(/1 이상/);
    expect(validateStarterTop("P001 P003", "3", "r").error).toMatch(/후보 수\(2\)/);
    expect(validateStarterTop("P001 P003", "2", "r").valid).toBe(true);
  });
});

describe("표시 문구", () => {
  it("출처를 사람 말로 — OVERRIDE 는 '적용 중'임이 드러나야 한다", () => {
    expect(sourceLabel("OVERRIDE")).toContain("override");
    expect(sourceLabel("BAKED")).toContain("발행물");
    expect(sourceLabel("NONE")).toContain("없음");
  });

  it("액션 라벨", () => {
    expect(actionLabel("economy_starter_top")).toBe("최상위 후보 교체");
    expect(actionLabel("economy_override_clear")).toBe("발행물로 롤백");
    expect(actionLabel("낯선값")).toBe("낯선값"); // 모르는 액션도 삼키지 않고 그대로 보여준다
  });
});

describe("isFullReplacement", () => {
  it("겹치는 후보가 하나도 없으면 전면 교체", () => {
    expect(isFullReplacement(["P001", "P003"], ["P016", "P017"])).toBe(true);
  });

  it("하나라도 겹치면 부분 변경", () => {
    expect(isFullReplacement(["P001", "P003"], ["P001", "P017"])).toBe(false);
  });

  it("기존이 비어 있으면(설정 없음) 경고 대상이 아니다", () => {
    expect(isFullReplacement([], ["P016"])).toBe(false);
  });
});

describe("normalizeEconomyView — 패널이 admin 페이지를 죽이지 않게", () => {
  it("정상 응답은 그대로 정규화", () => {
    const v = normalizeEconomyView({
      source: "OVERRIDE",
      overrideApplied: true,
      loadedAt: "2026-07-27T10:00:00Z",
      starterPackSize: 14,
      starterTop: { pool: ["P016"], count: 1 },
    });
    expect(v).toEqual({
      source: "OVERRIDE",
      overrideApplied: true,
      overrideFilePresent: true,
      loadedAt: "2026-07-27T10:00:00Z",
      starterPackSize: 14,
      pool: ["P016"],
      count: 1,
    });
  });

  it("빈 객체·null·문자열 등 모양이 아니면 null (던지지 않는다)", () => {
    // 기존 admin 스펙이 이걸로 깨졌다 — catch-all 목이 {} 를 주자 패널이 터져 페이지가 흰 화면이 됐다.
    expect(normalizeEconomyView({})).toBeNull();
    expect(normalizeEconomyView(null)).toBeNull();
    expect(normalizeEconomyView("nope")).toBeNull();
    expect(normalizeEconomyView({ starterTop: {} })).toBeNull();
  });

  it("적용 여부와 파일 존재가 **갈리는** 상태를 그대로 보존한다(거절된 override 잔존)", () => {
    // 서버가 손상/거절된 파일을 디스크에 남긴 채 발행물로 서비스하는 상태. 여기서 둘을 뭉치면
    // 화면이 "override 적용 중"이라 거짓말을 하거나(반대로) 롤백 버튼이 사라져 파일을 못 지운다.
    const v = normalizeEconomyView({
      source: "BAKED",
      overrideApplied: false,
      overrideFilePresent: true,
      starterTop: { pool: ["P001"], count: 1 },
    })!;
    expect(v.overrideApplied).toBe(false);
    expect(v.overrideFilePresent).toBe(true);
  });

  it("구버전 응답(overrideFilePresent 없음)은 적용 여부로 폴백 — 롤백 버튼이 사라지지 않게", () => {
    const v = normalizeEconomyView({
      source: "OVERRIDE",
      overrideApplied: true,
      starterTop: { pool: ["P001"], count: 1 },
    })!;
    expect(v.overrideFilePresent).toBe(true);
  });

  it("부분적으로 빠진 필드는 안전한 기본값으로 채운다", () => {
    const v = normalizeEconomyView({ starterTop: { pool: ["P001", 7] } })!;
    expect(v.pool).toEqual(["P001"]);   // 문자열 아닌 원소는 버린다
    expect(v.count).toBe(1);
    expect(v.source).toBe("NONE");
    expect(v.overrideApplied).toBe(false);
    expect(v.overrideFilePresent).toBe(false);
  });
});
