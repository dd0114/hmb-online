import { describe, expect, it } from "vitest";
import { formatRate, rateRows, tenPullNote, GACHA_PROMO } from "./gacha-promo";

/**
 * 홍보 구역 계약 (#457 C1).
 *
 * 핵심은 문장이 예쁜지가 아니라 **화면이 서버가 하지 않는 약속을 하지 않는가**다.
 * (문구 톤은 hero 컨펌 대상이고, 여기서는 "숫자를 지어내지 않는다"만 지킨다.)
 */

describe("gacha-promo", () => {
  it("확률표는 서버가 rates 를 줄 때만 생긴다 — 없으면 null", () => {
    expect(rateRows(null)).toBeNull();
    expect(rateRows({})).toBeNull();
    expect(rateRows({ rates: null })).toBeNull();
    expect(rateRows({ rates: {} })).toBeNull();
  });

  it("확률표는 높은 등급부터 세운다 (홍보는 노리는 것부터 보여준다)", () => {
    const rows = rateRows({
      rates: { BRONZE: 0.45, SILVER: 0.3, GOLD: 0.15, DIA: 0.08, LEGEND: 0.02 },
    })!;
    expect(rows.map((r) => r.grade)).toEqual(["LEGEND", "DIA", "GOLD", "SILVER", "BRONZE"]);
    expect(rows.map((r) => r.text)).toEqual(["2%", "8%", "15%", "30%", "45%"]);
  });

  it("모르는 등급 키는 버린다 — 등급 축의 SoT 는 grades.ts 다", () => {
    const rows = rateRows({ rates: { LEGEND: 0.02, MYTHIC: 0.5 } })!;
    expect(rows.map((r) => r.grade)).toEqual(["LEGEND"]);
  });

  it("소수 확률도 0% 로 접히지 않는다", () => {
    expect(formatRate(0.0005)).toBe("0.05%");
    expect(formatRate(0.155)).toBe("15.5%");
    expect(formatRate(0.02)).toBe("2%");
  });

  /**
   * ⚠️ 이 두 건이 #213 재발 방지선이다 — 예전 화면은 `"선수 11명 · 골드 이상 1명 보장"` 을
   * 손으로 적어 두었다. 개수도 보장 등급도 economy 값이라 무배포 override 로 바뀐다.
   */
  it("10연 안내는 서버 개수를 쓴다 — 개수를 모르면 아예 말하지 않는다", () => {
    expect(tenPullNote({ tenCount: 11 })).toBe("선수 11명");
    expect(tenPullNote({ tenCount: 15 })).toBe("선수 15명");
    expect(tenPullNote({})).toBeNull();
    expect(tenPullNote(null)).toBeNull();
  });

  it("보장 등급은 서버가 줄 때만 붙는다 (#458 이 오면 켜진다)", () => {
    expect(tenPullNote({ tenCount: 11, tenPityMinGrade: "GOLD" })).toBe("선수 11명 · 골드 이상 1명 보장");
    // 모르는 등급 문자열이면 보장 문구를 만들지 않는다(지어낸 라벨이 뜨지 않게).
    expect(tenPullNote({ tenCount: 11, tenPityMinGrade: "PLATINUM" })).toBe("선수 11명");
  });

  it("문구 SoT 가 비어 있지 않다 — 화면이 문장을 직접 들고 있지 않다는 전제", () => {
    expect(GACHA_PROMO.title.length).toBeGreaterThan(0);
    expect(GACHA_PROMO.points.length).toBeGreaterThan(0);
  });
});
