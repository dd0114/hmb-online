import { describe, expect, it } from "vitest";
import { eventTier, isLogged, logLines, scoreAt, type LogEvent } from "./log-lines";

/** 실제 match-log 형태의 최소 시계열(엔진 MatchEvent 부분집합). */
const events: LogEvent[] = [
  { tick: 0, minute: 0, type: "kickoff", team: "home" },
  { tick: 12, minute: 1, type: "pass", team: "home", playerId: "H7" },
  { tick: 30, minute: 2, type: "shot", team: "home", playerId: "H9", xg: 0.1234, detail: "off_target" },
  { tick: 40, minute: 3, type: "kickoff", team: "away", detail: "goal_kick" },
  { tick: 55, minute: 4, type: "shot", team: "away", playerId: "A11", xg: 0.4, detail: "saved" },
  { tick: 60, minute: 5, type: "save", team: "home", playerId: "H1" },
  { tick: 90, minute: 7, type: "goal", team: "away", playerId: "A10", xg: 0.55 },
  { tick: 120, minute: 9, type: "kickoff", team: "home" },
  { tick: 150, minute: 11, type: "card", team: "home", playerId: "H4", detail: "yellow" },
  { tick: 200, minute: 15, type: "goal", team: "home", playerId: "H9" },
  { tick: 260, minute: 20, type: "half_whistle" },
];

describe("logLines", () => {
  it("소음 이벤트를 걸러낸다 — pass 는 티커에 없고, 경기중 무-detail 킥오프도 숨긴다", () => {
    const lines = logLines(events);
    expect(lines.some((l) => l.type === "pass")).toBe(false);
    // tick 0 킥오프(minute 0)는 남고, tick 120 의 경기중 무-detail 킥오프는 숨는다.
    const kickoffs = lines.filter((l) => l.type === "kickoff");
    expect(kickoffs.map((l) => l.tick)).toEqual([0, 40]);
  });

  it("uptoTick 이후는 잘라낸다(재생 진행에 맞춘 라이브 로그)", () => {
    const lines = logLines(events, 100);
    expect(lines.at(-1)?.type).toBe("goal");
    expect(lines.every((l) => l.tick <= 100)).toBe(true);
    expect(logLines(events, -1)).toEqual([]);
  });

  it("골 라인에 그 시점 스코어를 붙인다(진행 중 스코어)", () => {
    const all = logLines(events);
    const goals = all.filter((l) => l.type === "goal");
    expect(goals.map((g) => g.score)).toEqual(["0-1", "1-1"]);
    // 첫 골까지만 재생했다면 그 시점 스코어만 보인다.
    expect(logLines(events, 90).filter((l) => l.type === "goal").map((g) => g.score)).toEqual(["0-1"]);
  });

  it("라벨·등번호·xG 표기가 뷰어 정의와 일치한다", () => {
    const lines = logLines(events);
    const shotOff = lines.find((l) => l.tick === 30)!;
    expect(shotOff).toMatchObject({ label: "Shot · off target", number: "9", team: "home", xg: "0.12" });
    expect(lines.find((l) => l.tick === 55)!.label).toBe("Shot · saved 🧤");
    expect(lines.find((l) => l.tick === 40)!.label).toBe("Goal kick");
    expect(lines.find((l) => l.tick === 150)!.label).toBe("🟨 Yellow card");
    expect(lines.find((l) => l.tick === 90)!.label).toBe("⚽ GOAL");
    // xG 는 슛 계열에만 붙는다(골 라인에는 안 붙임 — 뷰어 renderTicker 규칙).
    expect(lines.find((l) => l.tick === 90)!.xg).toBeUndefined();
  });

  it("중요도 3단계(major/normal/minor)", () => {
    expect(eventTier({ tick: 0, minute: 0, type: "goal" })).toBe("major");
    expect(eventTier({ tick: 0, minute: 0, type: "card" })).toBe("major");
    expect(eventTier({ tick: 0, minute: 0, type: "tackle" })).toBe("minor");
    expect(eventTier({ tick: 0, minute: 0, type: "kickoff", detail: "corner" })).toBe("minor");
    expect(eventTier({ tick: 0, minute: 0, type: "shot", detail: "off_target" })).toBe("minor");
    expect(eventTier({ tick: 0, minute: 0, type: "shot", detail: "saved" })).toBe("normal");
    expect(eventTier({ tick: 0, minute: 0, type: "foul" })).toBe("normal");
  });

  it("isLogged: 경기중 무-detail 킥오프만 숨기고 detail 있는 재시작은 남긴다", () => {
    expect(isLogged({ tick: 1, minute: 5, type: "kickoff" })).toBe(false);
    expect(isLogged({ tick: 1, minute: 5, type: "kickoff", detail: "corner" })).toBe(true);
    expect(isLogged({ tick: 1, minute: 0, type: "kickoff" })).toBe(true);
    expect(isLogged({ tick: 1, minute: 5, type: "pass" })).toBe(false);
  });

  it("이벤트 순서에 의존하지 않는다(정렬 가정 없음)", () => {
    const shuffled = [...events].reverse();
    const a = logLines(events, 200).map((l) => l.tick).sort((x, y) => x - y);
    const b = logLines(shuffled, 200).map((l) => l.tick).sort((x, y) => x - y);
    expect(b).toEqual(a);
  });
});

describe("scoreAt", () => {
  it("틱까지의 골만 센다", () => {
    expect(scoreAt(events, 0)).toEqual({ home: 0, away: 0 });
    expect(scoreAt(events, 90)).toEqual({ home: 0, away: 1 });
    expect(scoreAt(events, 999)).toEqual({ home: 1, away: 1 });
  });

  /**
   * #233 — 하프 로그는 **그 하프의 골만** 갖는다. 후반 로그를 그대로 세면 전반 스코어가 사라진다
   * (배포본 후반 헤더가 `0 : 0` 이었던 이유). 이미 끝난 하프의 확정 스코어를 베이스라인으로 받는다.
   */
  it("베이스라인을 주면 그 위에 쌓는다(후반 = 전반 확정 + 후반 골)", () => {
    const h1 = { home: 1, away: 4 };
    expect(scoreAt(events, 0, h1)).toEqual({ home: 1, away: 4 });
    expect(scoreAt(events, 90, h1)).toEqual({ home: 1, away: 5 });
    expect(scoreAt(events, 999, h1)).toEqual({ home: 2, away: 5 });
  });

  it("베이스라인 생략·null 은 지금 동작 그대로(무회귀 — dev-viewer 는 하프 단위로 본다)", () => {
    expect(scoreAt(events, 999, null)).toEqual({ home: 1, away: 1 });
    expect(scoreAt(events, 999, undefined)).toEqual({ home: 1, away: 1 });
  });
});

describe("logLines 베이스라인 (#233)", () => {
  it("골 라인 스코어도 베이스라인 위에 쌓인다", () => {
    const lines = logLines(events, 999, { home: 1, away: 4 });
    expect(lines.filter((l) => l.type === "goal").map((l) => l.score)).toEqual(["1-5", "2-5"]);
  });

  it("베이스라인 없으면 하프 로컬 그대로(무회귀)", () => {
    const lines = logLines(events, 999);
    expect(lines.filter((l) => l.type === "goal").map((l) => l.score)).toEqual(["0-1", "1-1"]);
  });
});
