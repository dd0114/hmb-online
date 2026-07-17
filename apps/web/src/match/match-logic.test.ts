import { describe, expect, it } from "vitest";
import {
  deriveTeamStats,
  eventDisplay,
  formatClock,
  keyEvents,
  panelForState,
  revealInterval,
  runningScore,
  shouldPoll,
  validateSubs,
  type MatchEventLike,
} from "./match-logic";

const ev = (type: string, over: Partial<MatchEventLike> = {}): MatchEventLike => ({
  tick: 0,
  minute: 0,
  type,
  ...over,
});

describe("panelForState (state router)", () => {
  it.each([
    ["BRIEFING", "briefing"],
    ["GEN1", "genwait"],
    ["GEN2", "genwait"],
    ["H1_BREAK", "halftime"],
    ["FINISHED", "result"],
    ["FAILED", "failed"],
  ] as const)("%s → %s", (state, panel) => {
    expect(panelForState(state)).toBe(panel);
  });

  it("unknown/undefined states fall back to 'unknown'", () => {
    expect(panelForState("SOMETHING_NEW")).toBe("unknown");
    expect(panelForState(undefined)).toBe("unknown");
  });
});

describe("shouldPoll (poll gating)", () => {
  it("polls only during GEN1/GEN2", () => {
    expect(shouldPoll("GEN1")).toBe(true);
    expect(shouldPoll("GEN2")).toBe(true);
    for (const s of ["BRIEFING", "H1_BREAK", "FINISHED", "FAILED", undefined]) {
      expect(shouldPoll(s)).toBe(false);
    }
  });
});

describe("eventDisplay (MatchEventType → label/icon)", () => {
  it("maps goal/shot/save/foul/offside", () => {
    expect(eventDisplay(ev("goal")).label).toBe("골!");
    expect(eventDisplay(ev("shot")).label).toBe("슛");
    expect(eventDisplay(ev("shot", { detail: "penalty" })).label).toBe("페널티킥 슛");
    expect(eventDisplay(ev("save")).label).toBe("선방");
    expect(eventDisplay(ev("foul")).label).toBe("파울");
    expect(eventDisplay(ev("offside")).label).toBe("오프사이드");
  });

  it("distinguishes card colors by detail", () => {
    expect(eventDisplay(ev("card", { detail: "yellow" })).label).toBe("옐로카드");
    expect(eventDisplay(ev("card", { detail: "red" })).label).toBe("레드카드");
  });

  it("decodes kickoff detail variants (engine restart encoding)", () => {
    expect(eventDisplay(ev("kickoff")).label).toBe("킥오프");
    expect(eventDisplay(ev("kickoff", { detail: "corner" })).label).toBe("코너킥");
    expect(eventDisplay(ev("kickoff", { detail: "goal_kick" })).key).toBe(false);
    expect(eventDisplay(ev("kickoff", { detail: "throw_in" })).key).toBe(false);
  });

  it("unknown event types fall back to the raw type, still visible", () => {
    const d = eventDisplay(ev("mystery_event"));
    expect(d.label).toBe("mystery_event");
    expect(d.key).toBe(true);
  });

  it("keyEvents filters per-tick noise (pass/interception/tackle)", () => {
    const filtered = keyEvents([ev("pass"), ev("goal"), ev("tackle"), ev("interception"), ev("card")]);
    expect(filtered.map((e) => e.type)).toEqual(["goal", "card"]);
  });
});

describe("formatClock", () => {
  it("renders tick as 분:초", () => {
    expect(formatClock(0)).toBe("0:00");
    expect(formatClock(65)).toBe("1:05");
    expect(formatClock(2699)).toBe("44:59");
  });

  it("half 2 adds the 45-minute offset", () => {
    expect(formatClock(0, 2)).toBe("45:00");
    expect(formatClock(60, 2)).toBe("46:00");
  });
});

describe("runningScore", () => {
  const events = [
    ev("goal", { team: "home" }),
    ev("shot", { team: "away" }),
    ev("goal", { team: "away" }),
    ev("goal", { team: "home" }),
  ];

  it("counts only revealed goal events", () => {
    expect(runningScore(events, 0)).toEqual({ home: 0, away: 0 });
    expect(runningScore(events, 1)).toEqual({ home: 1, away: 0 });
    expect(runningScore(events, 3)).toEqual({ home: 1, away: 1 });
    expect(runningScore(events, 4)).toEqual({ home: 2, away: 1 });
  });
});

describe("deriveTeamStats (both halves' events, events only)", () => {
  it("aggregates shots/goals/corners/fouls/cards/offsides per team", () => {
    const events = [
      ev("shot", { team: "home" }),
      ev("shot", { team: "home" }),
      ev("goal", { team: "home" }),
      ev("kickoff", { team: "home", detail: "corner" }),
      ev("kickoff", { team: "away" }), // plain kickoff — not a corner
      ev("kickoff", { team: "away", detail: "goal_kick" }), // not a corner
      ev("foul", { team: "away" }),
      ev("card", { team: "away", detail: "yellow" }),
      ev("offside", { team: "away" }),
      ev("pass", { team: "home" }), // ignored
    ];
    const stats = deriveTeamStats(events);
    expect(stats.home).toEqual({ shots: 2, goals: 1, corners: 1, fouls: 0, cards: 0, offsides: 0 });
    expect(stats.away).toEqual({ shots: 0, goals: 0, corners: 0, fouls: 1, cards: 1, offsides: 1 });
  });

  it("ignores events without a team side", () => {
    const stats = deriveTeamStats([ev("shot"), ev("goal")]);
    expect(stats.home.shots).toBe(0);
    expect(stats.away.goals).toBe(0);
  });
});

describe("revealInterval", () => {
  it("compresses to the target duration within clamps", () => {
    expect(revealInterval(30, 30_000)).toBe(1000);
    expect(revealInterval(1000, 30_000)).toBe(120); // floor clamp
    expect(revealInterval(5, 30_000)).toBe(2000); // ceiling clamp
    expect(revealInterval(0)).toBe(30_000); // no events — irrelevant but safe
  });
});

describe("validateSubs (client pre-check — server AC-M4 is SoT)", () => {
  const starters = ["GK1", "S1", "S2", "S3"];
  const bench = ["B1", "B2", "B3", "BGK"];
  const pos = (id: string) => (id === "GK1" || id === "BGK" ? "GK" : "MF");

  it("accepts a valid single sub", () => {
    expect(validateSubs([{ out: "S1", in: "B1" }], starters, bench, pos)).toEqual([]);
  });

  it("accepts up to 3 subs, rejects 4", () => {
    const four = [
      { out: "S1", in: "B1" },
      { out: "S2", in: "B2" },
      { out: "S3", in: "B3" },
      { out: "GK1", in: "BGK" },
    ];
    expect(validateSubs(four.slice(0, 3), starters, bench, pos)).toEqual([]);
    expect(validateSubs(four, starters, bench, pos).map((i) => i.rule)).toContain("SUBS_MAX");
  });

  it("rejects out-player not in starters and in-player not on bench", () => {
    const rules = validateSubs([{ out: "B1", in: "S1" }], starters, bench, pos).map((i) => i.rule);
    expect(rules).toContain("OUT_NOT_STARTER");
    expect(rules).toContain("IN_NOT_BENCH");
  });

  it("rejects duplicate out / duplicate in", () => {
    const rules = validateSubs(
      [
        { out: "S1", in: "B1" },
        { out: "S1", in: "B2" },
      ],
      starters,
      bench,
      pos,
    ).map((i) => i.rule);
    expect(rules).toContain("DUPLICATE_OUT");

    const rules2 = validateSubs(
      [
        { out: "S1", in: "B1" },
        { out: "S2", in: "B1" },
      ],
      starters,
      bench,
      pos,
    ).map((i) => i.rule);
    expect(rules2).toContain("DUPLICATE_IN");
  });

  it("flags GK removal without a GK replacement; allows GK-for-GK swap", () => {
    const noGk = validateSubs([{ out: "GK1", in: "B1" }], starters, bench, pos).map((i) => i.rule);
    expect(noGk).toContain("GK_REQUIRED");

    const gkSwap = validateSubs([{ out: "GK1", in: "BGK" }], starters, bench, pos);
    expect(gkSwap).toEqual([]);
  });
});
