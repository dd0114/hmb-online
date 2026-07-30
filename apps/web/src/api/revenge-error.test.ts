import { describe, expect, it } from "vitest";
import { ApiError } from "./client";
import { revengeError } from "./hooks-p286";

/**
 * #286 W5 — 복수 실패 문구 **유닛 계약**.
 *
 * ⚠️ 처음엔 e2e 가 네 코드 중 **하나만** 태우고 있었고, 넷을 한 문구로 뭉개는 변이가 그대로
 * 살아남았다(독립검증 MAJ-3). 코드마다 **다른 다음 행동**이 필요해서 문구가 갈려야 한다 —
 * "2회 소진"은 상대를 바꾸라는 뜻이고 "일일 한도"는 내일 오라는 뜻이다.
 */
const err = (code: string, message = "server said so") => new ApiError(400, { code, message });

describe("revengeError — 코드마다 다른 말을 한다", () => {
  const cases: Array<[string, string]> = [
    ["REVENGE_NOT_OWNED", "나를 상대로 한 원정이 아닙니다"],
    ["REVENGE_AVENGED", "이미 복수한 상대입니다"],
    ["REVENGE_EXHAUSTED", "2회 소진"],
    ["AWAY_DAILY_LIMIT", "내일 다시"],
  ];

  for (const [code, fragment] of cases) {
    it(`${code} 는 그 상황을 말한다`, () => {
      expect(revengeError(err(code))).toContain(fragment);
    });
  }

  it("네 문구가 서로 다르다 — 뭉개면 유저가 다음 행동을 고를 수 없다", () => {
    const msgs = cases.map(([code]) => revengeError(err(code)));
    expect(new Set(msgs).size).toBe(cases.length);
  });

  it("모르는 코드는 서버 문구를 그대로 보여준다 — 클라가 삼키지 않는다", () => {
    expect(revengeError(err("SOMETHING_NEW", "새 규칙 위반"))).toBe("새 규칙 위반");
  });

  it("네트워크 실패도 문장이 된다", () => {
    expect(revengeError(new Error("boom"))).toBe("boom");
    expect(revengeError(null)).toContain("시작하지 못했습니다");
  });
});
