import { describe, expect, it } from "vitest";
import { POSITIONS, positionKo } from "./position-label";

/**
 * #406 W6 m7 — 카드 부제가 포지션 enum 원문(`MF`)을 그대로 노출하던 것. 한글 이름 옆에 영문이
 * 서 있었다(요구 6 "모든 곳" 의 같은 화면).
 */
describe("positionKo", () => {
  it("시드가 쓰는 전 포지션이 **빠짐없이** 한글이다", () => {
    for (const p of POSITIONS) {
      const ko = positionKo(p)!;
      expect(ko, `${p} 가 원문 그대로 새 나온다`).not.toBe(p);
      expect(ko, `${p} 에 라틴 문자가 남았다`).not.toMatch(/[A-Za-z]/);
    }
    // 표본 전제 — 목록이 비면 위 루프가 공허하다.
    expect(POSITIONS.length).toBeGreaterThanOrEqual(4);
  });

  it("대소문자를 가리지 않는다(API 가 소문자로 내려도 한글)", () => {
    expect(positionKo("mf")).toBe(positionKo("MF"));
  });

  it("값이 없으면 null — 호출부가 그 자리를 통째로 생략한다", () => {
    expect(positionKo(null)).toBeNull();
    expect(positionKo(undefined)).toBeNull();
    expect(positionKo("   ")).toBeNull();
  });

  it("모르는 값은 **원문 그대로** — 빈칸으로 삼키지 않는다", () => {
    expect(positionKo("ST")).toBe("ST");
  });
});
