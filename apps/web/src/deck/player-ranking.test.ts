import { describe, expect, it } from "vitest";
import { rankPlayers, recommendScore, type RankablePlayer } from "./player-ranking";
import { positionWeight } from "./auto-lineup";
import type { Position } from "./deck-logic";

type Attrs = RankablePlayer["attributes"];

/** All 9 attrs = overall so playerOverall(mean) === overall exactly. */
function attrs(overall: number): Attrs {
  return {
    technical: overall,
    mental: overall,
    physical: overall,
    passing: overall,
    shooting: overall,
    tackling: overall,
    pace: overall,
    stamina: overall,
    positioning: overall,
  };
}

function mk(id: string, position: Position, overall: number): RankablePlayer {
  return { id, position, attributes: attrs(overall) };
}

const ids = (list: RankablePlayer[]) => list.map((p) => p.id);

describe("recommendScore", () => {
  it("ALL 필터 = playerOverall (스탯 총량 대용)", () => {
    expect(recommendScore(mk("a", "MF", 70), "ALL")).toBe(70);
    expect(recommendScore(mk("b", "GK", 55), "ALL")).toBe(55);
  });

  it("특정 포지션 필터 = positionWeight × overall (fit)", () => {
    const df = mk("d", "DF", 80);
    expect(recommendScore(df, "DF")).toBeCloseTo(positionWeight("DF", "DF") * 80, 9);
    expect(recommendScore(df, "MF")).toBeCloseTo(positionWeight("DF", "MF") * 80, 9);
    // exact-position fit strictly beats an equal-overall off-position fit.
    expect(recommendScore(df, "DF")).toBeGreaterThan(recommendScore(df, "MF"));
  });
});

describe("rankPlayers", () => {
  it("ALL: overall 내림차순", () => {
    const pool = [mk("lo", "MF", 40), mk("hi", "FW", 90), mk("mid", "DF", 65)];
    expect(ids(rankPlayers(pool, "ALL"))).toEqual(["hi", "mid", "lo"]);
  });

  it("특정 포지션: fit(내림차순) — 정포지션 고over 우선, 교차 포지션은 감점되어 뒤로", () => {
    // A pure GK with mid overall should rank ABOVE a high-overall outfielder for the GK filter,
    // because GK↔field crossing weight (0.2) crushes the outfielder's fit.
    const pool = [
      mk("fwStar", "FW", 95), // fit(GK) = 0.2 * 95 = 19
      mk("gkOk", "GK", 60), //  fit(GK) = 1.0 * 60 = 60
      mk("dfGood", "DF", 80), // fit(GK) = 0.2 * 80 = 16
    ];
    expect(ids(rankPlayers(pool, "GK"))).toEqual(["gkOk", "fwStar", "dfGood"]);
  });

  it("tie-break: 추천 점수 동점이면 playerId 사전순", () => {
    const pool = [mk("charlie", "MF", 70), mk("alpha", "MF", 70), mk("bravo", "MF", 70)];
    expect(ids(rankPlayers(pool, "ALL"))).toEqual(["alpha", "bravo", "charlie"]);
    expect(ids(rankPlayers(pool, "MF"))).toEqual(["alpha", "bravo", "charlie"]);
  });

  it("결정론: 입력 순서가 달라도 동일 출력", () => {
    const a = mk("a", "DF", 70);
    const b = mk("b", "DF", 82);
    const c = mk("c", "DF", 70);
    const forward = ids(rankPlayers([a, b, c], "DF"));
    const reversed = ids(rankPlayers([c, b, a], "DF"));
    const shuffled = ids(rankPlayers([b, c, a], "DF"));
    expect(forward).toEqual(reversed);
    expect(forward).toEqual(shuffled);
    // b (82) first; a & c tie on fit → playerId asc.
    expect(forward).toEqual(["b", "a", "c"]);
  });

  it("입력 배열을 변형하지 않는다(순수)", () => {
    const pool = [mk("z", "MF", 40), mk("a", "MF", 90)];
    const snapshot = ids(pool);
    rankPlayers(pool, "ALL");
    expect(ids(pool)).toEqual(snapshot);
  });
});
