import { describe, it, expect } from "vitest";
import { liveEventStats, computeCumulativePossession, possessionPct, momentum } from "./stats.impl.mjs";

describe("stats.mjs — 실시간 통계 증분 계산", () => {
  const events = [
    { tick: 10, type: "shot", team: "home", xg: 0.2 },
    { tick: 11, type: "shot", team: "home", detail: "saved", xg: 0.2 }, // 유효(선방)
    { tick: 12, type: "save", team: "away" }, // away GK 선방
    { tick: 20, type: "shot", team: "away", detail: "off_target", xg: 0.1 },
    { tick: 30, type: "shot", team: "home", xg: 0.5 },
    { tick: 31, type: "goal", team: "home" },
    { tick: 40, type: "pass", team: "home" },
    { tick: 41, type: "pass", team: "home" },
    { tick: 42, type: "interception", team: "away" }, // home 패스 실패 → home attempts++
    { tick: 50, type: "kickoff", team: "home", detail: "corner" },
    { tick: 60, type: "foul", team: "away" },
    { tick: 61, type: "card", team: "away", detail: "yellow" },
    { tick: 62, type: "offside", team: "home" },
  ];

  it("uptoTick 로 누적 컷 — 이후 이벤트 미포함", () => {
    const s = liveEventStats(events, 12);
    expect(s.home.shots).toBe(1); // tick10 시도
    expect(s.home.onTarget).toBe(1); // tick11 saved
    expect(s.home.xg).toBeCloseTo(0.2, 5);
    expect(s.away.saves).toBe(1);
    expect(s.home.goals).toBe(0); // 골은 tick31 → 아직
  });

  it("전체 누적 — 슛/유효/골/xG/패스%/코너/파울/카드/오프사이드", () => {
    const s = liveEventStats(events, 1000);
    // home: 시도 tick10, tick30 = 2. onTarget = saved(11) + goal(31) = 2.
    expect(s.home.shots).toBe(2);
    expect(s.home.onTarget).toBe(2);
    expect(s.home.goals).toBe(1);
    expect(s.home.xg).toBeCloseTo(0.7, 5); // 0.2 + 0.5 (saved 결과마커·off_target 제외)
    // home passes: 완성 2, attempts = 완성2 + away인터셉트1 = 3 → 67%
    expect(s.home.passCompleted).toBe(2);
    expect(s.home.passAttempts).toBe(3);
    expect(s.home.passPct).toBe(67);
    expect(s.home.corners).toBe(1);
    expect(s.home.offsides).toBe(1);
    // away: off_target 1, foul 1, yellow 1.
    expect(s.away.offTarget).toBe(1);
    expect(s.away.fouls).toBe(1);
    expect(s.away.yellow).toBe(1);
  });

  // ⚠️ 픽스처가 `players` 를 싣는다 (#324). 예전엔 `{ ballOwner: "H1" }` 만 넣었는데, 그건
  // "팀은 id 첫 글자로 안다"는 **틀린 가정을 계약으로 박은 것**이었다 — 실경기 id 는 `P077` 이라
  // 그 규칙이 전부 away 로 읽혀 라이브 점유율이 home 0% 로 떴다. MatchLog 스키마상 스냅샷엔
  // 항상 players 가 있으므로, 이쪽이 실제 입력에 가깝다.
  const own = (id: string | null, team?: string) => ({
    ballOwner: id,
    ball: { x: 50, y: 34 },
    players: id ? [{ playerId: id, team, pos: { x: 50, y: 34 } }] : [],
  });

  it("점유율 누적 + %", () => {
    const snaps = [
      own("H1", "home"), own("H2", "home"), own(null),
      own("A1", "away"), own("H3", "home"),
    ];
    const { cumHome, cumAway } = computeCumulativePossession(snaps);
    expect(cumHome[cumHome.length - 1]).toBe(3);
    expect(cumAway[cumAway.length - 1]).toBe(1);
    expect(possessionPct(cumHome, cumAway, 4)).toBe(75); // 3/(3+1)
    expect(possessionPct(cumHome, cumAway, 2)).toBe(100); // 처음 둘 다 home
  });

  it("모멘텀 −1..1 (홈 양수), 최근 창 기반", () => {
    const snaps = [];
    for (let i = 0; i < 40; i++) snaps.push(i < 20 ? own("A1", "away") : own("H1", "home"));
    const { cumHome, cumAway } = computeCumulativePossession(snaps);
    // 최근 10틱 전부 home → 모멘텀 +1.
    expect(momentum(cumHome, cumAway, 39, 10)).toBeCloseTo(1, 5);
    // 초반(전부 away) → 음수.
    expect(momentum(cumHome, cumAway, 15, 10)).toBeLessThan(0);
  });
});
