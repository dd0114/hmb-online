/**
 * #421 W2 — 스킵 버튼의 **노출·비활성·실패 해석** 계약.
 *
 * 규칙이 화면(`SkipButton`)이 아니라 순수 모듈에 있는 이유: 같은 판정을 컴포넌트 안에 인라인으로
 * 두면 다음 사람이 조용히 조건을 늘리고, 그때 "왜 감독시간에도 스킵 버튼이 뜨지"를 잡을 계약이
 * 없다(#233 독립검증 minor-1 이 정확히 그 형태였다).
 */
import { describe, expect, it } from "vitest";
import {
  halfLabelOf,
  isAlreadyAdvanced,
  reportHalfOf,
  skipButtonView,
  skipPhaseOf,
} from "./skip-mode";

describe("skipPhaseOf — 라이브 하프에서만 스킵할 수 있다", () => {
  it("전·후반은 자기 phase 를 돌려준다(서버 CAS 키)", () => {
    expect(skipPhaseOf("FIRST_HALF")).toBe("FIRST_HALF");
    expect(skipPhaseOf("SECOND_HALF")).toBe("SECOND_HALF");
  });

  it.each(["BRIEFING", "GEN1", "GEN2", "HALFTIME", "H1_BREAK", "FINISHED", "FAILED", "ABANDONED"])(
    "%s 는 스킵 대상이 아니다(서버도 409)",
    (state) => {
      expect(skipPhaseOf(state)).toBeNull();
    },
  );

  it("상태를 모르면 null — 모른다를 '가능'으로 읽지 않는다", () => {
    expect(skipPhaseOf(undefined)).toBeNull();
    expect(skipPhaseOf("")).toBeNull();
  });
});

describe("reportHalfOf — 스킵한 하프가 곧 리포트의 하프다", () => {
  it("전반 스킵 → 전반 리포트 / 후반 스킵 → 후반 리포트", () => {
    expect(reportHalfOf("FIRST_HALF")).toBe(1);
    expect(reportHalfOf("SECOND_HALF")).toBe(2);
  });
});

describe("skipButtonView", () => {
  it("전반 재생 중에는 보이고 눌린다", () => {
    const v = skipButtonView({ state: "FIRST_HALF" });
    expect(v.visible).toBe(true);
    expect(v.disabled).toBe(false);
    expect(v.phase).toBe("FIRST_HALF");
    expect(v.label).toContain("스킵");
    expect(v.hint).toContain("전반");
  });

  it("요청 중이면 **사라지지 않고 눌리지 않는다**(중복 클릭 = 409 유발)", () => {
    const v = skipButtonView({ state: "SECOND_HALF", pending: true });
    expect(v.visible).toBe(true);
    expect(v.disabled).toBe(true);
    // 상태를 말해 주지 않으면 유저는 눌리지 않는 버튼을 고장으로 읽는다.
    expect(v.label).not.toBe(skipButtonView({ state: "SECOND_HALF" }).label);
  });

  it("감독시간에는 아예 없다 — 회색 버튼을 남기지 않는다", () => {
    const v = skipButtonView({ state: "HALFTIME" });
    expect(v.visible).toBe(false);
    expect(v.phase).toBeNull();
  });

  it("돌려보는 화면(review)에서는 라이브 하프여도 없다", () => {
    // 감독시간 `경기장면` 탭·다시보기 — 그 하프는 이미 끝나 건너뛸 재생이 없다.
    expect(skipButtonView({ state: "FIRST_HALF", review: true }).visible).toBe(false);
    expect(skipButtonView({ state: "SECOND_HALF", review: true }).visible).toBe(false);
  });

  it("후반 hint 는 후반을 말한다 — 두 단계가 같은 문장을 쓰면 유저가 뭘 건너뛰는지 모른다", () => {
    expect(skipButtonView({ state: "SECOND_HALF" }).hint).toContain("후반");
    expect(skipButtonView({ state: "FIRST_HALF" }).hint).not.toContain("후반을");
  });
});

describe("isAlreadyAdvanced — 409 는 실패가 아니라 사실의 통지", () => {
  it("409 만 참", () => {
    expect(isAlreadyAdvanced({ status: 409 })).toBe(true);
    expect(isAlreadyAdvanced({ status: 400 })).toBe(false);
    expect(isAlreadyAdvanced({ status: 404 })).toBe(false);
    expect(isAlreadyAdvanced({ status: 500 })).toBe(false);
  });

  it("상태코드가 없는 실패(네트워크 등)는 참이 아니다 — 그건 진짜 에러다", () => {
    expect(isAlreadyAdvanced(new Error("Failed to fetch"))).toBe(false);
    expect(isAlreadyAdvanced(null)).toBe(false);
    expect(isAlreadyAdvanced(undefined)).toBe(false);
  });
});

describe("halfLabelOf", () => {
  it("하프 이름은 한 곳에서 나온다(버튼 hint·리포트 제목이 같은 말을 쓰게)", () => {
    expect(halfLabelOf(1)).toBe("전반");
    expect(halfLabelOf(2)).toBe("후반");
  });
});
