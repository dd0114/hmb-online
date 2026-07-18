import { describe, expect, it } from "vitest";
import type { LeagueFixture, LeagueStanding, LeagueTeam } from "../api/v2";
import {
  fixtureScore,
  groupByRound,
  isSeasonFinished,
  sortByRank,
  standingsComparator,
  teamNameMap,
  userRank,
} from "./league-logic";

const st = (over: Partial<LeagueStanding>): LeagueStanding => ({
  teamId: "t1",
  name: "팀1",
  played: 0,
  won: 0,
  drawn: 0,
  lost: 0,
  goalsFor: 0,
  goalsAgainst: 0,
  goalDiff: 0,
  points: 0,
  rank: 1,
  isUser: false,
  ...over,
});

const fx = (over: Partial<LeagueFixture>): LeagueFixture => ({
  id: "f1",
  round: 1,
  homeTeam: "t1",
  awayTeam: "t2",
  isUser: false,
  state: "SCHEDULED",
  scoreHome: null,
  scoreAway: null,
  matchId: null,
  ...over,
});

describe("sortByRank — 서버 rank(authoritative) 오름차순 안정정렬", () => {
  it("셔플된 순위표를 rank 순으로 렌더 정렬", () => {
    const shuffled = [
      st({ teamId: "c", rank: 3 }),
      st({ teamId: "a", rank: 1 }),
      st({ teamId: "b", rank: 2 }),
    ];
    expect(sortByRank(shuffled).map((s) => s.teamId)).toEqual(["a", "b", "c"]);
  });
  it("입력 배열을 변형하지 않는다(복사본 반환)", () => {
    const input = [st({ teamId: "b", rank: 2 }), st({ teamId: "a", rank: 1 })];
    sortByRank(input);
    expect(input.map((s) => s.teamId)).toEqual(["b", "a"]);
  });
  it("동일 rank 는 teamId 안정 정렬", () => {
    const same = [st({ teamId: "z", rank: 1 }), st({ teamId: "a", rank: 1 })];
    expect(sortByRank(same).map((s) => s.teamId)).toEqual(["a", "z"]);
  });
});

describe("standingsComparator — 방어적 타이브레이크(승점→골득실→다득점)", () => {
  it("승점 우선(내림차순)", () => {
    const rows = [st({ teamId: "a", points: 3 }), st({ teamId: "b", points: 9 })];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["b", "a"]);
  });
  it("승점 동률이면 골득실", () => {
    const rows = [
      st({ teamId: "a", points: 6, goalDiff: 1 }),
      st({ teamId: "b", points: 6, goalDiff: 5 }),
    ];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["b", "a"]);
  });
  it("승점·골득실 동률이면 다득점", () => {
    const rows = [
      st({ teamId: "a", points: 6, goalDiff: 2, goalsFor: 4 }),
      st({ teamId: "b", points: 6, goalDiff: 2, goalsFor: 9 }),
    ];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["b", "a"]);
  });
  it("완전 동률은 teamId 안정 결정론", () => {
    const rows = [
      st({ teamId: "y", points: 6, goalDiff: 2, goalsFor: 4 }),
      st({ teamId: "x", points: 6, goalDiff: 2, goalsFor: 4 }),
    ];
    expect([...rows].sort(standingsComparator).map((r) => r.teamId)).toEqual(["x", "y"]);
  });
});

describe("groupByRound — 일정 라운드 묶기", () => {
  it("라운드 오름차순으로 묶고 내부 순서 유지", () => {
    const fixtures = [
      fx({ id: "r2a", round: 2 }),
      fx({ id: "r1a", round: 1 }),
      fx({ id: "r1b", round: 1 }),
      fx({ id: "r2b", round: 2 }),
    ];
    const groups = groupByRound(fixtures);
    expect(groups.map((g) => g.round)).toEqual([1, 2]);
    expect(groups[0]!.fixtures.map((f) => f.id)).toEqual(["r1a", "r1b"]);
    expect(groups[1]!.fixtures.map((f) => f.id)).toEqual(["r2a", "r2b"]);
  });
});

describe("fixtureScore — 픽스처 관점 스코어(오리엔트 안 함)", () => {
  it("PLAYED 는 홈-어웨이 원값 표시", () => {
    expect(fixtureScore(fx({ state: "PLAYED", scoreHome: 2, scoreAway: 1 }))).toBe("2 - 1");
  });
  it("SCHEDULED 는 null", () => {
    expect(fixtureScore(fx({ state: "SCHEDULED" }))).toBeNull();
  });
});

describe("teamNameMap / userRank / isSeasonFinished", () => {
  it("teamId→이름 매핑", () => {
    const teams: LeagueTeam[] = [
      { teamId: "t1", name: "내팀", isUser: true, persona: null, power: null },
      { teamId: "t2", name: "봇A", isUser: false, persona: "공격", power: 900 },
    ];
    const m = teamNameMap(teams);
    expect(m.get("t2")).toBe("봇A");
  });
  it("userRank = isUser 행의 rank", () => {
    expect(userRank([st({ teamId: "a", rank: 1 }), st({ teamId: "u", rank: 4, isUser: true })])).toBe(4);
    expect(userRank([st({ isUser: false })])).toBeNull();
  });
  it("isSeasonFinished", () => {
    expect(isSeasonFinished({ state: "FINISHED" } as never)).toBe(true);
    expect(isSeasonFinished({ state: "ACTIVE" } as never)).toBe(false);
    expect(isSeasonFinished(null)).toBe(false);
  });
});
