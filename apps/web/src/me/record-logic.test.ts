import { describe, expect, it } from "vitest";
import { donutDash, formMark, recordView } from "./record-logic";

/**
 * #286 W5 — 내 전적 **유닛 계약**.
 *
 * ⚠️ 핵심은 하나다: **승률을 클라가 계산하지 않는다.** 무승부를 0.5승으로 치는지 빼는지가
 * 서버 규칙이라, 여기서 나누면 화면이 서버와 다른 승률을 말한다(#262 BL-1 과 같은 부류).
 */
const REC = {
  overall: { played: 23, wins: 12, draws: 3, losses: 8, winRate: 0.52 },
  byMode: {
    practice: { played: 5, wins: 3, draws: 0, losses: 2 },
    league: { played: 12, wins: 7, draws: 2, losses: 3 },
    away: { played: 6, wins: 2, draws: 1, losses: 3 },
  },
  recentForm: ["WIN", "DRAW", "LOSS"] as Array<"WIN" | "DRAW" | "LOSS">,
  streak: { current: 2, best: 4 },
};

describe("recordView", () => {
  it("서버가 준 승률을 그대로 쓴다", () => {
    expect(recordView(REC).winRate).toBe(0.52);
  });

  it("승률이 없으면 **null** — 절대 계산하지 않는다", () => {
    const v = recordView({ ...REC, overall: { ...REC.overall, winRate: undefined } });
    expect(v.winRate).toBeNull();
    // 그래도 나머지는 살아 있다 — 도넛 하나가 없다고 패널이 사라지면 안 된다.
    expect(v.usable).toBe(true);
    expect(v.modes).toHaveLength(3);
  });

  it("모드 순서는 리그·원정·연습 — 연습이 마지막(hero Q1 과 같은 뜻)", () => {
    expect(recordView(REC).modes.map((m) => m.key)).toEqual(["league", "away", "practice"]);
  });

  it("한 판도 안 한 모드는 줄을 만들지 않는다 — 0승0무0패는 정보가 아니다", () => {
    const v = recordView({ ...REC, byMode: { league: REC.byMode.league, away: { played: 0, wins: 0, draws: 0, losses: 0 } } });
    expect(v.modes.map((m) => m.key)).toEqual(["league"]);
  });

  it("200 {} 는 usable=false", () => {
    expect(recordView({} as never).usable).toBe(false);
    expect(recordView(undefined).usable).toBe(false);
  });

  it("recentForm 에 이상한 값이 섞이면 걸러낸다", () => {
    const v = recordView({ ...REC, recentForm: ["WIN", "BOOM", null] as never });
    expect(v.form).toEqual(["WIN"]);
  });
});

describe("donutDash — 호가 비율을 반영한다", () => {
  it("절반이면 절반", () => {
    expect(donutDash(0.5, 100)).toBe("50 50");
  });

  it("범위를 벗어난 값은 잘라낸다 — 호가 원을 넘지 않는다", () => {
    expect(donutDash(1.4, 100)).toBe("100 0");
    expect(donutDash(-1, 100)).toBe("0 100");
  });
});

describe("formMark — 색 하나로 구분하지 않는다", () => {
  it("글자로도 읽힌다(적록색약)", () => {
    expect([formMark("WIN"), formMark("DRAW"), formMark("LOSS")]).toEqual(["승", "무", "패"]);
  });
});
