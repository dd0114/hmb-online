import { describe, expect, it } from "vitest";
import {
  deriveTeamStats,
  eventDisplay,
  formatClock,
  genWaitCopy,
  keyEvents,
  panelForState,
  revealInterval,
  fallbackScore,
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

describe("genWaitCopy — 생성 대기 문구는 실측 대기시간과 맞아야 한다 (#193)", () => {
  it("GEN1: 전반 제목 + 킥오프 대기 감각(10초 안팎, 대변경 시 1~2분)", () => {
    const copy = genWaitCopy("GEN1");
    expect(copy.title).toContain("전반");
    expect(copy.note).toContain("10초");
    expect(copy.note).toContain("1~2분");
  });

  it("GEN2: 후반 제목 + 하프타임 문구 — 실측 0.3초라 시간을 말하지 않는다", () => {
    const copy = genWaitCopy("GEN2");
    expect(copy.title).toContain("후반");
    expect(copy.note).toContain("하프타임");
    expect(copy.note).not.toMatch(/초|분/);
  });

  it("낡은 실측(팀당 70초 × 양팀)은 어느 단계에서도 남아 있지 않다", () => {
    for (const s of ["GEN1", "GEN2"] as const) {
      const { title, note } = genWaitCopy(s);
      expect(`${title} ${note}`).not.toContain("70초");
      expect(`${title} ${note}`).not.toContain("양팀");
    }
  });

  it("이모지를 쓰지 않는다(패널 톤 유지)", () => {
    for (const s of ["GEN1", "GEN2"] as const) {
      const { title, note } = genWaitCopy(s);
      expect(`${title} ${note}`).not.toMatch(/\p{Extended_Pictographic}/u);
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

  /** #233 — 후반 로그는 후반 골만 갖는다. 베이스라인 없이 세면 폴백도 `0 : 0` 부터 다시 센다. */
  it("stacks on the finished half's settled score when a baseline is given", () => {
    const h1 = { home: 1, away: 4 };
    expect(runningScore(events, 0, h1)).toEqual({ home: 1, away: 4 });
    expect(runningScore(events, 3, h1)).toEqual({ home: 2, away: 5 });
    expect(runningScore(events, 4, h1)).toEqual({ home: 3, away: 5 });
    // 생략/null 은 기존 동작 그대로(무회귀).
    expect(runningScore(events, 4, null)).toEqual({ home: 2, away: 1 });
  });
});

/**
 * #233 독립검증 minor-1 — 이 규칙이 `MatchViewer` 안에 인라인이던 동안에는 **베이스라인을 통째로
 * 지워도 전 게이트가 green** 이었다(검증자 변이체 C). 순수함수로 빼고 여기서 박제한다.
 */
describe("fallbackScore (텍스트 폴백 스코어보드)", () => {
  const events = [
    ev("goal", { team: "away" }),
    ev("goal", { team: "away" }),
  ];
  const h1 = { home: 1, away: 4 };

  it("다 보기 전에는 공개된 이벤트 누적 + 베이스라인", () => {
    expect(fallbackScore(null, events, 1, false, h1)).toEqual({ home: 1, away: 5 });
  });

  it("다 본 뒤 finalScore 도 베이스라인 위에 얹는다 — 그건 그 하프만의 최종값이다", () => {
    // 후반 로그의 finalScore 는 후반만의 1:4 다. 그대로 쓰면 화면이 경기 최종 2:8 대신 1:4 를 말한다.
    expect(fallbackScore({ home: 1, away: 4 }, events, 2, true, h1)).toEqual({ home: 2, away: 8 });
  });

  it("finalScore 가 없으면 누적으로 같은 답을 낸다", () => {
    expect(fallbackScore(null, events, 2, true, h1)).toEqual({ home: 1, away: 6 });
  });

  it("베이스라인 없으면 하프 로컬 그대로(전반 재생·확정값 미상 — 무회귀)", () => {
    expect(fallbackScore({ home: 1, away: 4 }, events, 2, true, null)).toEqual({ home: 1, away: 4 });
    expect(fallbackScore(null, events, 2, false)).toEqual({ home: 0, away: 2 });
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

  it("결과 마커(saved/off_target)를 시도로 중복 집계하지 않는다 (엔진 stats 정의와 동일)", () => {
    const events = [
      ev("shot", { team: "home" }), // 시도
      ev("shot", { team: "home", detail: "saved" }), // 그 시도의 결과 — 새 시도가 아님
      ev("shot", { team: "away", detail: "off_target" }),
      ev("shot", { team: "away", detail: "one_on_one" }), // 시도(상황 표기)
    ];
    const stats = deriveTeamStats(events);
    expect(stats.home.shots).toBe(1);
    expect(stats.away.shots).toBe(1);
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

  /**
   * 카탈로그(`/api/players`)가 아직 안 온 동안엔 positionOf 가 전부 undefined 라 "GK 가 없다"로
   * 보인다 — 헛경고가 뜨고 [후반 시작]이 잠긴다. **모른다와 위반은 다르다**: 포지션을 모르는
   * 선수가 하나라도 있으면 그가 GK 일 수 있으므로 위반이라고 말할 수 없다.
   */
  it("포지션을 모르는 선수가 있으면 GK 검사를 보류한다(로딩 ≠ 위반)", () => {
    const unknown = () => undefined;
    expect(validateSubs([], starters, bench, unknown)).toEqual([]);
    expect(validateSubs([{ out: "GK1", in: "B1" }], starters, bench, unknown)).toEqual([]);

    // 카탈로그가 도착하면(전원 알려짐) 그때 판정한다.
    expect(validateSubs([{ out: "GK1", in: "B1" }], starters, bench, pos).map((i) => i.rule))
      .toContain("GK_REQUIRED");
    // 일부만 알려진 상태도 보류 — 모르는 그 선수가 GK 일 수 있다.
    const partial = (id: string) => (id === "S1" ? "MF" : undefined);
    expect(validateSubs([{ out: "GK1", in: "B1" }], starters, bench, partial)).toEqual([]);
  });
});
