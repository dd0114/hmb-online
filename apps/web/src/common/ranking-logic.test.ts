import { describe, expect, it } from "vitest";
import { myRankLine, rankMetric, rankingView } from "./ranking-logic";

/**
 * #286 W5 — 랭킹보드 **유닛 계약**.
 *
 * 서버 API 가 아직 없어서(#319) **부재·이상 응답이 기본 상태**다. 그 경로가 화면을 죽이지
 * 않는다는 것이 여기 절반이다(#245·#251 에서 두 번 당했다).
 */

describe("rankingView — 없는 것을 그리지 않는다", () => {
  it("응답이 없으면 usable=false", () => {
    expect(rankingView(undefined).usable).toBe(false);
    expect(rankingView(null).usable).toBe(false);
  });

  it("200 {} 도 usable=false — 빈 껍데기를 그리면 고장으로 보인다", () => {
    expect(rankingView({} as never).usable).toBe(false);
  });

  it("entries 가 배열이 아니면 무시한다", () => {
    expect(rankingView({ entries: { a: 1 } } as never).entries).toEqual([]);
  });

  it("rank 가 숫자가 아닌 행은 버린다", () => {
    const v = rankingView({ entries: [{ rank: "1" }, { rank: 2 }] } as never);
    expect(v.entries).toHaveLength(1);
  });

  it("목록이 비어도 내 순위만 있으면 그린다 — 집계 전 상태", () => {
    expect(rankingView({ entries: [], me: { rank: 12 } } as never).usable).toBe(true);
  });
});

describe("rankMetric — 두 랭킹이 다른 지표를 쓴다", () => {
  it("원정은 레이팅, 연승이 있으면 함께", () => {
    expect(rankMetric({ rating: 1620, streak: 9 }, "away")).toBe("1620 · 9연승");
    expect(rankMetric({ rating: 1620, streak: 0 }, "away")).toBe("1620");
  });

  it("리그는 승점·경기수", () => {
    expect(rankMetric({ points: 52, played: 18 }, "league")).toBe("52점 · 18경기");
  });

  it("값이 없으면 지어내지 않는다", () => {
    expect(rankMetric({}, "away")).toBe("—");
    expect(rankMetric({}, "league")).toBe("—");
  });
});

describe("myRankLine — 순위를 날조하지 않는다", () => {
  it("순위를 모르면 그 사실을 말한다", () => {
    expect(myRankLine({ total: 143 }, "away")).toContain("아직 순위에");
  });

  it("총원을 모르면 등수만 말한다", () => {
    expect(myRankLine({ rank: 12, rating: 1180 }, "away")).toBe("12위 · 1180");
  });

  it("me 가 없으면 줄 자체가 없다", () => {
    expect(myRankLine(null, "league")).toBeNull();
  });
});
