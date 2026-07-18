import { describe, expect, it } from "vitest";
import type { MatchLogItem } from "../api/v2";
import {
  DEFAULT_MATCH_LOG_FILTER,
  formatMyScore,
  formatWinRate,
  matchLogQuery,
  orientScore,
  roundLabel,
  setFilterMode,
  setFilterSeason,
} from "./logs-logic";

const item = (over: Partial<MatchLogItem>): MatchLogItem => ({
  id: "m1",
  mode: "league",
  opponentName: "봇FC",
  result: "WIN",
  scoreHome: 2,
  scoreAway: 1,
  userWasHome: true,
  hasHalves: true,
  createdAt: "2026-07-19T10:00:00Z",
  ...over,
});

describe("orientScore — 유저 관점 오리엔트 (관점 계약 핵심)", () => {
  it("userWasHome=true → my=scoreHome, opp=scoreAway (연습·유저홈)", () => {
    expect(orientScore(item({ userWasHome: true, scoreHome: 3, scoreAway: 1 }))).toEqual({
      my: 3,
      opp: 1,
    });
  });

  it("userWasHome=false → my=scoreAway, opp=scoreHome (어웨이 리그 — flip)", () => {
    // 픽스처 관점 원값은 홈3:어웨이1 이지만, 유저가 어웨이면 유저 스코어는 1, 상대 3.
    expect(orientScore(item({ userWasHome: false, scoreHome: 3, scoreAway: 1 }))).toEqual({
      my: 1,
      opp: 3,
    });
  });

  it("어웨이 승리 케이스: 유저가 어웨이로 2:0 이기면 my=2 opp=0 (원값 홈0:어웨이2)", () => {
    const oriented = orientScore(item({ userWasHome: false, scoreHome: 0, scoreAway: 2 }));
    expect(oriented).toEqual({ my: 2, opp: 0 });
  });

  it("null 스코어(미확정)는 null 로 오리엔트", () => {
    expect(orientScore(item({ userWasHome: false, scoreHome: null, scoreAway: null }))).toEqual({
      my: null,
      opp: null,
    });
  });

  it("userWasHome 미지정(undefined)이면 홈(true)으로 기본 처리 — 연습·구로그 관점 안뒤집힘", () => {
    // 서버가 userWasHome 을 생략해도(연습·구 로그) 홈 관점으로 my=scoreHome 이어야 한다.
    const { userWasHome: _omit, ...rest } = item({ scoreHome: 3, scoreAway: 1 });
    expect(orientScore(rest)).toEqual({ my: 3, opp: 1 });
    expect(formatMyScore(rest)).toBe("3 : 1");
  });
});

describe("formatMyScore — '내 득점 : 상대 득점'", () => {
  it("홈 유저: 원값 그대로 표시 순서", () => {
    expect(formatMyScore(item({ userWasHome: true, scoreHome: 2, scoreAway: 1 }))).toBe("2 : 1");
  });
  it("어웨이 유저: flip 되어 내 스코어 먼저 (원값 직표시 금지 확인)", () => {
    expect(formatMyScore(item({ userWasHome: false, scoreHome: 2, scoreAway: 1 }))).toBe("1 : 2");
  });
  it("미확정은 '- : -'", () => {
    expect(formatMyScore(item({ scoreHome: null, scoreAway: null }))).toBe("- : -");
  });
});

describe("roundLabel", () => {
  it("리그 경기: S{seasonNo} R{round}", () => {
    expect(roundLabel(item({ mode: "league", seasonNo: 2, round: 5 }))).toBe("S2 R5");
  });
  it("시즌 없으면 R{round}", () => {
    expect(roundLabel(item({ mode: "league", seasonNo: null, round: 3 }))).toBe("R3");
  });
  it("연습 경기는 null", () => {
    expect(roundLabel(item({ mode: "practice", round: null }))).toBeNull();
  });
});

describe("matchLogQuery — 필터 직렬화", () => {
  it("기본(all) 은 빈 쿼리", () => {
    expect(matchLogQuery(DEFAULT_MATCH_LOG_FILTER)).toBe("");
  });
  it("연습 필터", () => {
    expect(matchLogQuery({ mode: "practice", season: null })).toBe("?mode=practice");
  });
  it("리그 + 시즌", () => {
    expect(matchLogQuery({ mode: "league", season: 3 })).toBe("?mode=league&season=3");
  });
  it("season 은 mode=league 일 때만 붙는다", () => {
    expect(matchLogQuery({ mode: "practice", season: 3 })).toBe("?mode=practice");
    expect(matchLogQuery({ mode: "all", season: 3 })).toBe("");
  });
});

describe("필터 상태 전이", () => {
  it("league→다른 모드로 바꾸면 season 을 해제(무의미 조합 방지)", () => {
    const f = setFilterSeason({ mode: "league", season: 2 }, 2);
    expect(setFilterMode(f, "practice")).toEqual({ mode: "practice", season: null });
    expect(setFilterMode(f, "all")).toEqual({ mode: "all", season: null });
  });
  it("league 유지 시 season 보존", () => {
    expect(setFilterMode({ mode: "league", season: 4 }, "league")).toEqual({
      mode: "league",
      season: 4,
    });
  });
  it("setFilterSeason 은 season 만 바꾼다", () => {
    expect(setFilterSeason({ mode: "league", season: null }, 7)).toEqual({
      mode: "league",
      season: 7,
    });
  });
});

describe("formatWinRate", () => {
  it("0..1 을 퍼센트로", () => {
    expect(formatWinRate(0.625)).toBe("62.5%");
    expect(formatWinRate(1)).toBe("100%");
    expect(formatWinRate(0)).toBe("0%");
  });
  it("null/undefined → '-'", () => {
    expect(formatWinRate(null)).toBe("-");
    expect(formatWinRate(undefined)).toBe("-");
  });
});
