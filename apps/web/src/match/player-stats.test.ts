/**
 * player-stats 계약 (#403 W1).
 *
 * ⚠️ 이 스위트는 `apps/web/CLAUDE.md` 의 "계약이 **초록으로 거짓말하는** 방식" 목록을 지나갔다:
 *  - 실경기 로그(`match-log.json`)는 **gitignore 생성물**이라 `skipIf` 로 걸린다 → 그것만 두면
 *    로그가 없는 트리에서 교차검증이 통째로 **조용히 사라진다**. 그래서 같은 성질을 **손으로 만든
 *    픽스처**로 항상 돌린다(아래 `buildFixture`). 실로그는 "현실에서도 성립하나"의 보강일 뿐이다.
 *  - 기대값은 **리터럴**로 박는다(구현 상수를 import 해서 비교하면 임계 변이가 통과한다).
 *  - **규칙 하나당 표본 하나** — 중복 id·2옐로·스포일러 컷은 각각 자기 픽스처를 쓴다.
 */
import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { liveEventStats } from "@hmb/viewer-core";
import {
  RATING_WEIGHTS,
  combinePlayerStats,
  computePlayerStats,
  computeRating,
  findPlayerStat,
  passPct,
  playerKey,
  playerKeySet,
  passAttributionCoverage,
  ratingWithWeights,
  type RatingWeights,
  type PlayerStatLine,
  type PlayerStatsResult,
  type StatEvent,
  type StatPlayerSnapshot,
  type StatMatchLog,
  type StatSnapshot,
  type TeamSide,
} from "./player-stats";

// ── 픽스처 ────────────────────────────────────────────────────────────────

const HOME_IDS = ["H1", "H2", "H3", "H4"] as const;
const AWAY_IDS = ["A1", "A2", "A3"] as const;
const GK_KEYS = playerKeySet([["home", "H1"], ["away", "A1"]]);

const BASE_POS: Record<string, [number, number]> = {
  H1: [5, 34],
  H2: [30, 20],
  H3: [50, 40],
  H4: [40, 10],
  A1: [100, 34],
  A2: [70, 30],
  A3: [80, 50],
};

/** 소유자 계획(index = tick). null = 무소유(비행/루즈볼). */
const OWNER_PLAN: (string | null)[] = [
  /* 0*/ "H2", "H2", null, "H3", "H3", null,
  /* 6*/ "A2", "A2", null,
  /* 9*/ "A3", "A3", null, null, null,
  /*14*/ "H1", "H1", null, null, null,
  /*19*/ "A2", "A2", "A2",
  /*22*/ "H4", "H4", "H4",
  /*25*/ "H2", null, null, null, null,
  /*30*/ "H3", null, null, null, null,
  /*35*/ "H3", null, null,
  /*38*/ "A2", "A2",
  /*40*/ "H3", "H3", "H3", "H3", "H3", "H3", "H3", "H3",
];

const LAST_TICK = OWNER_PLAN.length - 1; // 47

/** A2 는 t39 에 경고누적 퇴장 → t40 부터 스냅샷에서 사라진다. */
const A2_OFF_FROM = 40;

const FIXTURE_EVENTS: StatEvent[] = [
  { tick: 0, type: "kickoff", team: "home" },
  { tick: 3, type: "pass", team: "home", playerId: "H3" }, // 패서 = H2 (직전 소유자)
  { tick: 6, type: "interception", team: "away", playerId: "A2" }, // H3 의 패스 실패
  { tick: 9, type: "pass", team: "away", playerId: "A3", detail: "long" }, // 패서 = A2, 롱
  { tick: 11, type: "shot", team: "away", playerId: "A3", xg: 0.25 }, // 키패스 = A2
  { tick: 13, type: "shot", team: "away", xg: 0.25, detail: "saved" }, // 결과 마커(playerId 없음)
  { tick: 13, type: "save", team: "home", playerId: "H1" },
  { tick: 16, type: "clearance", team: "home", playerId: "H1" },
  { tick: 18, type: "kickoff", team: "away", detail: "throw_in" }, // 걷어내기가 나간 것 = 실패 패스 아님
  { tick: 22, type: "tackle", team: "home", playerId: "H4" }, // A2 볼 뺏김
  { tick: 25, type: "pass", team: "home", playerId: "H2" }, // 패서 = H4
  { tick: 26, type: "shot", team: "home", playerId: "H2", xg: 0.4 }, // 키패스 = H4
  { tick: 28, type: "goal", team: "home", playerId: "H2", xg: 0.4 }, // 어시스트 = H4, A1 실점
  { tick: 30, type: "card", team: "away", playerId: "A2", detail: "yellow" },
  { tick: 31, type: "shot", team: "home", playerId: "H3", xg: 0.1 }, // 키패스 없음
  { tick: 33, type: "shot", team: "home", xg: 0.1, detail: "off_target" },
  { tick: 37, type: "kickoff", team: "away", detail: "throw_in" }, // H3 의 패스가 아웃 = 실패 패스
  { tick: 38, type: "foul", team: "away", playerId: "A2" },
  { tick: 39, type: "card", team: "away", playerId: "A2", detail: "yellow" },
  { tick: 39, type: "card", team: "away", playerId: "A2", detail: "red" }, // 같은 틱 = 경고누적
  { tick: 46, type: "offside", team: "home", playerId: "H3" },
];

function fixturePlayers(tick: number): StatPlayerSnapshot[] {
  const out: StatPlayerSnapshot[] = [];
  for (const id of HOME_IDS) {
    const b = BASE_POS[id]!;
    // H2 만 매 틱 +1m — 주행거리 계약이 "합계 0" 으로 조용히 통과하지 않게.
    out.push({ playerId: id, team: "home", pos: { x: id === "H2" ? b[0] + tick : b[0], y: b[1] } });
  }
  for (const id of AWAY_IDS) {
    if (id === "A2" && tick >= A2_OFF_FROM) continue;
    const b = BASE_POS[id]!;
    out.push({ playerId: id, team: "away", pos: { x: b[0], y: b[1] } });
  }
  return out;
}

/**
 * 손으로 만든 하프 로그. `minute` 은 **로그가 구운 축**이고 일부러 `floor(tick/60)` 과 다르다
 * (#388) — 표시 분이 그 축을 따라오는지 계약이 볼 수 있게.
 */
function buildFixture(): StatMatchLog {
  const tickSnapshots: StatSnapshot[] = [];
  for (let t = 0; t <= LAST_TICK; t++) {
    tickSnapshots.push({
      tick: t,
      minute: Math.floor(t / 10),
      ball: { x: 10 + 2 * t, y: 34 }, // 매 틱 2m — 3틱 이상 소유 구간만 캐리가 된다.
      ballOwner: OWNER_PLAN[t] ?? null,
      players: fixturePlayers(t),
    });
  }
  return { tickSnapshots, events: FIXTURE_EVENTS };
}

const FIXTURE = buildFixture();

function stat(res: PlayerStatsResult, team: TeamSide, id: string): PlayerStatLine {
  const l = findPlayerStat(res, team, id);
  expect(l, `${team}:${id} 가 집계에 없다`).toBeDefined();
  return l!;
}

function sumOf(res: PlayerStatsResult, team: TeamSide, f: (p: PlayerStatLine) => number): number {
  return res.players.filter((p) => p.team === team).reduce((a, p) => a + f(p), 0);
}

// ── 1. 선수 합 = 팀 합 (교차검증) ─────────────────────────────────────────

describe("선수 합 = 팀 합 — viewer-core liveEventStats 와 어긋나면 그 자리에서 신뢰를 잃는다", () => {
  const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });
  const team = liveEventStats(FIXTURE.events as never[], Number.MAX_SAFE_INTEGER);

  const cases: Array<[string, (p: PlayerStatLine) => number, (t: typeof team.home) => number]> = [
    ["goals", (p) => p.goals, (t) => t.goals],
    ["shots", (p) => p.shots, (t) => t.shots],
    ["onTarget", (p) => p.shotsOnTarget, (t) => t.onTarget],
    ["offTarget", (p) => p.shotsOffTarget, (t) => t.offTarget],
    ["saves", (p) => p.saves, (t) => t.saves],
    ["fouls", (p) => p.fouls, (t) => t.fouls],
    ["yellow", (p) => p.yellowCards, (t) => t.yellow],
    ["red", (p) => p.redCards, (t) => t.red],
    ["offsides", (p) => p.offsides, (t) => t.offsides],
  ];

  for (const [label, pf, tf] of cases) {
    it(`${label}: 선수 합이 팀 합과 정확히 같다`, () => {
      expect(sumOf(res, "home", pf)).toBe(tf(team.home));
      expect(sumOf(res, "away", pf)).toBe(tf(team.away));
    });
  }

  it("xG: 선수 합이 팀 합과 같다(부동소수 허용오차)", () => {
    expect(sumOf(res, "home", (p) => p.xg)).toBeCloseTo(team.home.xg, 9);
    expect(sumOf(res, "away", (p) => p.xg)).toBeCloseTo(team.away.xg, 9);
  });

  it("패스: 선수 합 + 잔차 = 팀 합 (완성·시도 둘 다)", () => {
    const u = res.unattributed;
    expect(sumOf(res, "home", (p) => p.passesCompleted) + sumOf(res, "away", (p) => p.passesCompleted) + u.passesCompleted)
      .toBe(team.home.passCompleted + team.away.passCompleted);
    expect(sumOf(res, "home", (p) => p.passesAttempted) + sumOf(res, "away", (p) => p.passesAttempted) + u.passesAttempted)
      .toBe(team.home.passAttempts + team.away.passAttempts);
  });

  // ⚠️ 위 등식만 두면 "전부 잔차로 밀어 넣는" 구현도 통과한다. 잔차의 정체를 **리터럴로** 박는다:
  // 이 픽스처에서 잔차는 t18 스로인 1건뿐이고 그건 H1 의 **걷어내기**가 나간 것이라 실패 패스가 아니다.
  it("잔차는 '걷어내기가 라인 밖으로 나간 스로인' 1건뿐이다", () => {
    expect(res.unattributed).toEqual({ passesCompleted: 0, passesAttempted: 1, events: {} });
    expect(sumOf(res, "home", (p) => p.passesCompleted)).toBe(2);
    expect(sumOf(res, "away", (p) => p.passesCompleted)).toBe(1);
    expect(sumOf(res, "home", (p) => p.passesAttempted)).toBe(4);
    expect(sumOf(res, "away", (p) => p.passesAttempted)).toBe(1);
  });

  it("팀 합계 자체가 기대한 숫자다(양쪽이 같은 방향으로 틀리는 것을 막는 리터럴 앵커)", () => {
    expect([team.home.goals, team.away.goals]).toEqual([1, 0]);
    expect([team.home.shots, team.away.shots]).toEqual([2, 1]);
    expect([team.home.onTarget, team.away.onTarget]).toEqual([1, 1]);
    expect([team.home.saves, team.away.saves]).toEqual([1, 0]);
    expect([team.home.yellow, team.away.yellow]).toEqual([0, 2]);
  });
});

// ── 2. 패스는 리시버가 아니라 패서에게 붙는다 ────────────────────────────

describe("소유 체인 재구성 — `pass.playerId` 는 리시버다", () => {
  const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });

  it("t3 의 패스는 리시버 H3 가 아니라 직전 소유자 H2 에게 붙는다", () => {
    expect(stat(res, "home", "H2").passesCompleted).toBe(1);
    expect(stat(res, "home", "H3").passesCompleted).toBe(0);
  });

  it("가로챔은 인터셉터에게 +1, 끊긴 패서에게 실패 패스 +1", () => {
    expect(stat(res, "away", "A2").interceptions).toBe(1);
    const h3 = stat(res, "home", "H3");
    expect(h3.passesAttempted).toBe(2); // t6 가로챔 + t37 아웃
    expect(h3.passesCompleted).toBe(0);
    expect(passPct(h3)).toBe(0);
  });

  it("롱패스는 detail 로 분리된다(A2 → A3)", () => {
    const a2 = stat(res, "away", "A2");
    expect(a2.longPasses).toBe(1);
    expect(a2.longPassesCompleted).toBe(1);
    expect(stat(res, "home", "H2").longPasses).toBe(0);
  });

  it("태클은 태클러에게 +1, 직전 소유자에게 '볼 뺏김' +1 (가로챔과 다른 축이다)", () => {
    expect(stat(res, "home", "H4").tackles).toBe(1);
    expect(stat(res, "away", "A2").dispossessed).toBe(1);
    // 가로챔 피해자는 '볼 뺏김'이 아니라 실패 패스다.
    expect(stat(res, "home", "H3").dispossessed).toBe(0);
  });

  it("걷어내기를 센다 — 종전 집계기는 어느 것도 세지 않았다(#314)", () => {
    expect(stat(res, "home", "H1").clearances).toBe(1);
    // 걷어내기는 패스가 아니다 — 성공률 캘리브레이션을 오염시키면 안 된다.
    expect(stat(res, "home", "H1").passesAttempted).toBe(0);
  });

  it("키패스·어시스트는 소유 체인으로 나온다", () => {
    expect(stat(res, "away", "A2").keyPasses).toBe(1); // A3 의 슛
    expect(stat(res, "home", "H4").keyPasses).toBe(1);
    expect(stat(res, "home", "H4").assists).toBe(1); // t28 골
    expect(stat(res, "away", "A2").assists).toBe(0); // 선방으로 끝났다
    expect(stat(res, "home", "H3").keyPasses).toBe(0);
    // 어시스트 합 ≤ 골 수.
    expect(res.players.reduce((a, p) => a + p.assists, 0)).toBeLessThanOrEqual(1);
  });

  it("터치·캐리·전진거리 (home 은 +x, away 는 −x 로 공격한다)", () => {
    expect(stat(res, "home", "H2").touches).toBe(2);
    expect(stat(res, "away", "A2").touches).toBe(3);
    // 3틱 소유 구간(공 2m/틱) 만 캐리 — 2틱 구간은 4m 미만이라 아니다.
    expect(stat(res, "home", "H4").carries).toBe(1);
    expect(stat(res, "home", "H4").carryProgressM).toBeCloseTo(4, 6);
    expect(stat(res, "away", "A2").carries).toBe(1);
    // away 는 −x 로 공격하므로 +x 이동은 전진이 아니다.
    expect(stat(res, "away", "A2").carryProgressM).toBe(0);
  });
});

describe("키패스는 '리시버가 **그 소유 구간에서**' 슛했을 때만 붙는다", () => {
  /**
   * 엔진에는 **이벤트가 없는 소유 이전**이 있다(세트피스 크로스·헤딩 세컨볼 회수 —
   * `contest.resolveArrival` 의 "계획이 없던 공"). 그래서 "직전 완성 패스의 리시버 == 슈터" 만
   * 보면, 그 사이에 소유가 상대에게 넘어갔다 돌아와도 키패스가 붙는다.
   *
   * ⚠️ 규칙 하나당 표본 하나 — 그 끊김만 있는 픽스처를 따로 만든다.
   */
  const mk = (interrupted: boolean): StatMatchLog => ({
    tickSnapshots: [0, 1, 2, 3, 4, 5, 6].map((t) => ({
      tick: t,
      minute: 0,
      ball: { x: 50, y: 34 },
      ballOwner:
        t === 1 || t === 6 ? null : t === 0 ? "H2" : t === 4 && interrupted ? "A2" : "H3",
      players: [
        { playerId: "H2", team: "home" as const, pos: { x: 40, y: 34 } },
        { playerId: "H3", team: "home" as const, pos: { x: 50, y: 34 } },
        { playerId: "A2", team: "away" as const, pos: { x: 51, y: 34 } },
      ],
    })),
    events: [
      { tick: 2, type: "pass", team: "home", playerId: "H3" }, // 패서 H2 → 리시버 H3
      { tick: 6, type: "shot", team: "home", playerId: "H3", xg: 0.2 },
    ],
  });

  it("소유가 안 끊기면 키패스가 붙는다(양성 대조 — 공허한 0 이 아니다)", () => {
    const r = computePlayerStats(mk(false));
    expect(stat(r, "home", "H2").keyPasses).toBe(1);
    expect(stat(r, "home", "H3").shots).toBe(1);
  });

  it("중간에 상대가 공을 가졌다 돌아오면(이벤트 없는 소유 이전) 키패스가 아니다", () => {
    const r = computePlayerStats(mk(true));
    expect(stat(r, "home", "H3").shots).toBe(1); // 슛은 그대로 있다
    expect(stat(r, "home", "H2").keyPasses).toBe(0);
    expect(stat(r, "home", "H2").assists).toBe(0);
  });
});

// ── 3. 슛 이중발행 ────────────────────────────────────────────────────────

describe("`shot` 은 발사 + 결과 마커 2회 발생한다", () => {
  const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });

  it("시도와 xG 가 두 배가 되지 않는다", () => {
    const h2 = stat(res, "home", "H2");
    expect(h2.shots).toBe(1); // t26 발사 1회 — t28 골 이벤트를 또 세면 2가 된다
    expect(h2.xg).toBeCloseTo(0.4, 9); // 골 이벤트도 xg 0.4 를 재발행한다
    const a3 = stat(res, "away", "A3");
    expect(a3.shots).toBe(1);
    expect(a3.xg).toBeCloseTo(0.25, 9); // saved 마커도 xg 0.25 를 재발행한다
  });

  it("결과 마커(playerId 없음)가 직전 발사에 페어링돼 유효슛이 선수에게 붙는다", () => {
    expect(stat(res, "away", "A3").shotsOnTarget).toBe(1); // saved
    expect(stat(res, "home", "H2").shotsOnTarget).toBe(1); // goal
    expect(stat(res, "home", "H3").shotsOffTarget).toBe(1);
    expect(stat(res, "home", "H3").shotsOnTarget).toBe(0);
    expect(res.unattributed.events["shot_result_unpaired"]).toBeUndefined();
  });
});

// ── 4. 2옐로 = 옐로 1 + 레드 1, 카드 2장이 아니다 ────────────────────────

describe("경고 누적 퇴장 — 엔진이 같은 틱에 yellow 와 red 를 둘 다 쏜다", () => {
  const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });
  const a2 = stat(res, "away", "A2");

  it("옐로 2 · 레드 1 로 세고 '경고누적'으로 표시한다", () => {
    expect(a2.yellowCards).toBe(2);
    expect(a2.redCards).toBe(1);
    expect(a2.secondYellow).toBe(true);
    expect(a2.sentOff).toBe(true);
  });

  it("평점 감점은 '옐로 1 + 레드 1' 만큼 — 두 번째 옐로를 따로 또 깎지 않는다", () => {
    // 경고누적(옐로2+레드1)은 **직접 퇴장(옐로1+레드1)과 같은 감점**이어야 한다.
    const secondYellowCase = computeRating({ ...a2, yellowCards: 2, redCards: 1, sentOff: true, secondYellow: true });
    const straightRedCase = computeRating({ ...a2, yellowCards: 1, redCards: 1, sentOff: true, secondYellow: false });
    expect(secondYellowCase).toBe(straightRedCase);
    // 그리고 옐로 2장을 따로 깎는 것보다는 확실히 높다(플래그를 무시하는 변이를 죽인다).
    const bothYellows = computeRating({ ...a2, yellowCards: 2, redCards: 1, sentOff: true, secondYellow: false });
    expect(secondYellowCase).toBeGreaterThan(bothYellows);
  });

  it("퇴장 선수는 이후 스냅샷에서 사라진다 → 출전시간이 짧다", () => {
    expect(a2.ticksPlayed).toBe(40); // t0..t39
    expect(stat(res, "home", "H2").ticksPlayed).toBe(48);
  });
});

// ── 5. 출전 분은 로그가 구운 minute 축이다 (#388) ────────────────────────

describe("표시 분 · 뛴 거리", () => {
  const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });

  it("minute 축을 쓴다 — floor(tick/60) 이면 전원 1분이 된다", () => {
    // 픽스처의 minute = floor(tick/10) → 0..4 = 5분.
    expect(stat(res, "home", "H2").minutesPlayed).toBe(5);
    expect(stat(res, "away", "A2").minutesPlayed).toBe(4); // t39 퇴장 → minute 0..3
  });

  it("뛴 거리는 스냅샷 좌표 차의 합이다", () => {
    expect(stat(res, "home", "H2").distanceM).toBeCloseTo(47, 6); // 매 틱 1m × 47스텝
    expect(stat(res, "home", "H3").distanceM).toBe(0);
  });

  it("히트맵 빈의 합 = 그 선수의 출전 틱 수", () => {
    for (const p of res.players) {
      expect(p.heat.reduce((a, b) => a + b, 0)).toBe(p.ticksPlayed);
      expect(p.heat).toHaveLength(96); // 12 × 8
    }
  });
});

// ── 6. GK 선방·실점 ──────────────────────────────────────────────────────

describe("GK", () => {
  const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });

  it("선방은 GK 에게, 실점은 그 틱에 피치 위에 있던 상대 GK 에게 붙는다", () => {
    expect(stat(res, "home", "H1").saves).toBe(1);
    expect(stat(res, "away", "A1").goalsConceded).toBe(1);
    expect(stat(res, "home", "H1").goalsConceded).toBe(0);
  });

  it("gkKeys 를 안 주면 실점 귀속이 없다(선방은 이벤트라 그대로)", () => {
    const noGk = computePlayerStats(FIXTURE);
    expect(stat(noGk, "home", "H1").saves).toBe(1);
    expect(stat(noGk, "away", "A1").goalsConceded).toBe(0);
  });
});

// ── 7. uptoTick — 단조성 · 스포일러 컷 ───────────────────────────────────

describe("uptoTick 은 liveEventStats 와 같은 축(tick <= upto)이다", () => {
  const COUNTERS: Array<(p: PlayerStatLine) => number> = [
    (p) => p.goals,
    (p) => p.shots,
    (p) => p.shotsOnTarget,
    (p) => p.passesCompleted,
    (p) => p.passesAttempted,
    (p) => p.tackles,
    (p) => p.interceptions,
    (p) => p.clearances,
    (p) => p.fouls,
    (p) => p.yellowCards,
    (p) => p.touches,
    (p) => p.ticksPlayed,
    (p) => p.distanceM,
    (p) => p.saves,
  ];

  it("upto 를 늘리면 어떤 카운터도 줄지 않는다", () => {
    let prev = COUNTERS.map(() => 0);
    for (let upto = 0; upto <= LAST_TICK; upto++) {
      const r = computePlayerStats(FIXTURE, { uptoTick: upto, gkKeys: GK_KEYS });
      const cur = COUNTERS.map((f) => r.players.reduce((a, p) => a + f(p), 0));
      for (let i = 0; i < cur.length; i++) {
        expect(cur[i]!, `upto=${upto} 카운터#${i} 가 줄었다`).toBeGreaterThanOrEqual(prev[i]!);
      }
      prev = cur;
    }
  });

  it("upto = 마지막 틱이면 전량 집계와 완전히 같다", () => {
    const all = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });
    const cut = computePlayerStats(FIXTURE, { uptoTick: LAST_TICK, gkKeys: GK_KEYS });
    expect(cut.players).toEqual(all.players);
    expect(cut.unattributed).toEqual(all.unattributed);
  });

  /**
   * ⚠️ BL-1 — **스냅샷 쪽 컷**에도 계약이 있어야 한다. 단조성·`upto=LAST==전량` 만으로는
   * 구조적으로 못 잡는다: 스냅샷 컷이 사라지면 값이 **하프 최종치로 상수**가 되므로
   * "줄지 않는다"를 오히려 만족하고 마지막 틱 비교도 참이 된다.
   * 그래서 **"작은 upto 에서 값이 실제로 작다"** 를 리터럴로 박는다.
   * 이 축이 뚫리면 킥오프 직후에 하프 최종 뛴거리·터치·출전시간·히트맵이 보인다(#233/#238).
   */
  it("스포일러: upto=5 에서 스냅샷 파생 지표가 하프 최종치가 아니라 그 시점 값이다", () => {
    const early = computePlayerStats(FIXTURE, { uptoTick: 5, gkKeys: GK_KEYS });
    const h2 = stat(early, "home", "H2");
    expect(h2.ticksPlayed).toBe(6); // t0..t5 — 컷이 없으면 48
    expect(h2.distanceM).toBeCloseTo(5, 6); // 1m/틱 × 5스텝 — 컷이 없으면 47
    expect(h2.touches).toBe(1); // t0-1 구간 하나 — 컷이 없으면 2
    expect(h2.minutesPlayed).toBe(1); // minute 0 만 — 컷이 없으면 5
    expect(h2.heat.reduce((a, b) => a + b, 0)).toBe(6); // 컷이 없으면 48
    expect(early.ticks).toBe(6);
  });

  it("스포일러: 스냅샷 파생 지표가 upto 에 따라 **엄격히** 자란다(상수면 컷이 없는 것)", () => {
    const at = (upto: number): number[] => {
      const r = computePlayerStats(FIXTURE, { uptoTick: upto, gkKeys: GK_KEYS });
      const p = stat(r, "home", "H2");
      return [p.ticksPlayed, Math.round(p.distanceM), p.heat.reduce((a, b) => a + b, 0), r.ticks];
    };
    const a = at(5);
    const b = at(20);
    const c = at(LAST_TICK);
    for (let i = 0; i < a.length; i++) {
      expect(a[i]!, `#${i} 5<20`).toBeLessThan(b[i]!);
      expect(b[i]!, `#${i} 20<끝`).toBeLessThan(c[i]!);
    }
  });

  it("스포일러: 스냅샷 컷 축이 이벤트 컷 축과 같다(둘 다 tick <= upto)", () => {
    // 이벤트가 보이기 시작하는 틱과 스냅샷이 포함되는 틱이 어긋나면 한쪽이 먼저/늦게 열린다.
    const at28 = computePlayerStats(FIXTURE, { uptoTick: 28, gkKeys: GK_KEYS });
    expect(stat(at28, "home", "H2").goals).toBe(1); // 이벤트 tick=28 포함
    expect(at28.ticks).toBe(29); // 스냅샷 tick 0..28 포함 = 29개
  });

  it("스포일러: upto 이후의 골은 집계에 들어가지 않는다", () => {
    const before = computePlayerStats(FIXTURE, { uptoTick: 27, gkKeys: GK_KEYS });
    expect(before.players.reduce((a, p) => a + p.goals, 0)).toBe(0);
    expect(stat(before, "home", "H2").goals).toBe(0);
    expect(stat(before, "away", "A1").goalsConceded).toBe(0);
    // 앵커: 골 자체는 이 로그에 **있다**(공허한 0 이 아니다).
    const at = computePlayerStats(FIXTURE, { uptoTick: 28, gkKeys: GK_KEYS });
    expect(stat(at, "home", "H2").goals).toBe(1);
    expect(at.players.reduce((a, p) => a + p.goals, 0)).toBe(1);
  });

  it("컷 축이 팀 축과 같다 — 모든 upto 에서 골·슛·파울이 liveEventStats 와 일치", () => {
    for (let upto = 0; upto <= LAST_TICK; upto++) {
      const r = computePlayerStats(FIXTURE, { uptoTick: upto, gkKeys: GK_KEYS });
      const t = liveEventStats(FIXTURE.events as never[], upto);
      for (const side of ["home", "away"] as const) {
        const tt = t[side];
        expect(sumOf(r, side, (p) => p.goals), `upto=${upto} goals ${side}`).toBe(tt.goals);
        expect(sumOf(r, side, (p) => p.shots), `upto=${upto} shots ${side}`).toBe(tt.shots);
        expect(sumOf(r, side, (p) => p.fouls), `upto=${upto} fouls ${side}`).toBe(tt.fouls);
      }
    }
  });
});

// ── 8. 중복 playerId (양팀에 같은 선수) ──────────────────────────────────

describe("양 팀에 같은 playerId 가 있어도 기록이 섞이지 않는다 (#231 — 라이브에서 흔하다)", () => {
  /**
   * `P7` 이 양 팀에 있다. `ballOwner` 는 맨 id 라 팀을 모른다 → viewer-core `ownerSideOf` 가
   * **공에 더 가까운 쪽**을 소유자로 본다. 홈 P7 을 공 옆에, 어웨이 P7 을 멀리 둔다.
   */
  const dup: StatMatchLog = {
    tickSnapshots: [0, 1, 2, 3, 4].map((t) => ({
      tick: t,
      minute: 0,
      ball: { x: 20 + t, y: 34 },
      ballOwner: t === 2 ? null : "P7",
      players: [
        { playerId: "P7", team: "home", pos: { x: 20 + t, y: 34 } }, // 공 옆
        { playerId: "P9", team: "home", pos: { x: 60, y: 20 } },
        { playerId: "P7", team: "away", pos: { x: 95, y: 60 } }, // 멀리
        { playerId: "P8", team: "away", pos: { x: 90, y: 10 } },
      ],
    })),
    events: [
      { tick: 3, type: "pass", team: "home", playerId: "P9" }, // 패서 = home:P7
      { tick: 4, type: "foul", team: "away", playerId: "P7" }, // 어웨이 P7 의 파울
      { tick: 4, type: "tackle", team: "away", playerId: "P8" },
    ],
  };

  const res = computePlayerStats(dup);

  it("두 인스턴스가 별개 항목으로 잡힌다(정렬 = home 먼저, 그다음 playerId)", () => {
    expect(res.players.map((p) => p.key)).toEqual(["home:P7", "home:P9", "away:P7", "away:P8"]);
    expect(playerKey("home", "P7")).not.toBe(playerKey("away", "P7"));
  });

  it("소유·패스는 공에 가까운 홈 P7 에게만 붙는다", () => {
    expect(stat(res, "home", "P7").passesCompleted).toBe(1);
    expect(stat(res, "home", "P7").touches).toBe(2); // t0-1, t3-4
    expect(stat(res, "away", "P7").passesCompleted).toBe(0);
    expect(stat(res, "away", "P7").touches).toBe(0);
  });

  it("파울은 이벤트의 team 대로 어웨이 P7 에게만 붙는다", () => {
    expect(stat(res, "away", "P7").fouls).toBe(1);
    expect(stat(res, "home", "P7").fouls).toBe(0);
  });

  it("주행거리가 두 사람 사이를 오가지 않는다(홈만 움직인다)", () => {
    expect(stat(res, "home", "P7").distanceM).toBeCloseTo(4, 6);
    expect(stat(res, "away", "P7").distanceM).toBe(0);
  });

  it("태클 피해자는 반대 팀의 소유자다 — 같은 팀 동명 선수로 새지 않는다", () => {
    expect(stat(res, "home", "P7").dispossessed).toBe(1);
    expect(stat(res, "away", "P7").dispossessed).toBe(0);
  });
});

// ── 9. 하프 합산 ─────────────────────────────────────────────────────────

describe("하프 둘을 합친다 — 비율은 평균이 아니라 시도/성공 합에서 다시 계산", () => {
  /** 하프는 **공이 죽은 자리**에서 갈린다(하프 휘슬). t29 는 무소유 구간이라 그 성질을 만족한다. */
  const cut = 29;
  const sliceAt = (lo: number, hi: number): StatMatchLog => ({
    tickSnapshots: (FIXTURE.tickSnapshots ?? []).filter((s) => s.tick >= lo && s.tick <= hi),
    events: (FIXTURE.events ?? []).filter((e) => e.tick >= lo && e.tick <= hi),
  });
  const whole = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });
  const combined = combinePlayerStats([
    computePlayerStats(sliceAt(0, cut), { gkKeys: GK_KEYS }),
    computePlayerStats(sliceAt(cut + 1, LAST_TICK), { gkKeys: GK_KEYS }),
  ]);

  const part1 = computePlayerStats(sliceAt(0, cut), { gkKeys: GK_KEYS });
  const part2 = computePlayerStats(sliceAt(cut + 1, LAST_TICK), { gkKeys: GK_KEYS });

  /**
   * ⚠️ BL-2 — **열거 목록을 손으로 유지하지 않는다.** 예전엔 21개만 적어 두어 `xg` ·
   * `carries` · `carryDistanceM` · `carryProgressM` · `dispossessed` · `longPassesCompleted` ·
   * `heat` 의 합산을 지운 변이가 **전부 통과했다**(실경기는 항상 두 하프라 화면이 보는 건 합산값이다 —
   * `xg` 하나만 빠져도 전 선수 xG 가 0 인데 게이트는 초록).
   *
   * 그래서 ① 필드 집합을 **전수 대조**해 필드가 늘면 여기서 먼저 red 가 되게 하고
   * ② 타입별로 **런타임 전수 순회**한다. 비교 대상은 `whole` 이 아니라 **두 조각의 합**이다 —
   * 그게 `combinePlayerStats` 가 실제로 약속하는 것이고, 하프 경계 손실(아래 계약)과도 안 다툰다.
   */
  const LINE_FIELDS = [
    "key", "team", "playerId",
    "goals", "shots", "shotsOnTarget", "shotsOffTarget", "xg",
    "tackles", "interceptions", "clearances", "fouls",
    "yellowCards", "redCards", "secondYellow", "sentOff", "offsides", "saves", "goalsConceded",
    "passesAttempted", "passesCompleted", "longPasses", "longPassesCompleted",
    "keyPasses", "assists", "touches", "carries", "carryDistanceM", "carryProgressM",
    "dispossessed", "distanceM", "ticksPlayed", "minutesPlayed", "heat", "rating",
  ] as const;
  /** 합산이 아니라 **재산출**되는 필드(아래에 각각 자기 계약이 있다). */
  const RECOMPUTED = new Set<string>(["rating"]);

  it("PlayerStatLine 의 필드 집합이 계약이 아는 것과 정확히 같다(필드가 늘면 여기서 먼저 깨진다)", () => {
    const sample = combined.players[0];
    expect(sample).toBeDefined();
    expect([...Object.keys(sample!)].sort()).toEqual([...LINE_FIELDS].sort());
  });

  it("모든 수치·배열·불리언 필드가 두 하프의 합이다 — 전수 순회(열거 누락 불가)", () => {
    const pick = (r: PlayerStatsResult, key: string): PlayerStatLine | undefined =>
      r.players.find((p) => p.key === key);
    let checkedNumbers = 0;
    let checkedArrays = 0;
    for (const line of combined.players) {
      const a = pick(part1, line.key);
      const b = pick(part2, line.key);
      for (const field of LINE_FIELDS) {
        if (RECOMPUTED.has(field)) continue;
        const v = line[field];
        if (typeof v === "number") {
          const av = (a?.[field] as number | undefined) ?? 0;
          const bv = (b?.[field] as number | undefined) ?? 0;
          expect(v, `${line.key}.${field}`).toBeCloseTo(av + bv, 9);
          checkedNumbers++;
        } else if (Array.isArray(v)) {
          const av = (a?.[field] as number[] | undefined) ?? [];
          const bv = (b?.[field] as number[] | undefined) ?? [];
          for (let i = 0; i < v.length; i++) {
            expect(v[i], `${line.key}.${field}[${i}]`).toBe((av[i] ?? 0) + (bv[i] ?? 0));
          }
          checkedArrays++;
        } else if (typeof v === "boolean") {
          expect(v, `${line.key}.${field}`).toBe(Boolean(a?.[field]) || Boolean(b?.[field]));
        } else {
          expect(v, `${line.key}.${field}`).toBe((a?.[field] ?? b?.[field]) as unknown);
        }
      }
    }
    // 순회가 실제로 일어났다(공허한 0회 통과 방지).
    expect(combined.players.length).toBe(7);
    expect(checkedNumbers).toBeGreaterThanOrEqual(7 * 25);
    expect(checkedArrays).toBe(7);
  });

  it("합산이 실제로 값을 옮긴다 — 두 하프 모두 0 인 필드만으로 통과하지 않는다", () => {
    // 위 전수 순회가 "전부 0 = 0+0" 으로 공허해지지 않게, 양쪽에 값이 있는 필드를 앵커로 박는다.
    const anchors: Array<[string, (p: PlayerStatLine) => number]> = [
      ["xg", (p) => p.xg],
      ["carries", (p) => p.carries],
      ["carryDistanceM", (p) => p.carryDistanceM],
      ["carryProgressM", (p) => p.carryProgressM],
      ["dispossessed", (p) => p.dispossessed],
      ["longPassesCompleted", (p) => p.longPassesCompleted],
      ["touches", (p) => p.touches],
    ];
    for (const [label, f] of anchors) {
      const total = combined.players.reduce((s, p) => s + f(p), 0);
      expect(total, `${label} 이 0 이면 이 필드의 합산 계약은 공허하다`).toBeGreaterThan(0);
    }
    // 히트맵도 두 조각 모두에 값이 있어야 원소별 합산이 의미를 갖는다.
    expect(part1.players.reduce((s, p) => s + p.heat.reduce((x, y) => x + y, 0), 0)).toBeGreaterThan(0);
    expect(part2.players.reduce((s, p) => s + p.heat.reduce((x, y) => x + y, 0), 0)).toBeGreaterThan(0);
  });

  it("평점은 합산이 아니라 **재산출**이다", () => {
    for (const line of combined.players) {
      const a = part1.players.find((p) => p.key === line.key);
      const b = part2.players.find((p) => p.key === line.key);
      expect(line.rating).toBe(computeRating(line));
      // 두 하프 평점을 더한 값(≈12)이 그대로 나오면 안 된다.
      expect(line.rating).not.toBe((a?.rating ?? 0) + (b?.rating ?? 0));
    }
  });

  it("카운터·출전시간이 통짜와 같다", () => {
    const keys = [
      "goals", "shots", "shotsOnTarget", "shotsOffTarget", "xg", "tackles", "interceptions",
      "clearances", "fouls", "yellowCards", "redCards", "offsides", "saves", "goalsConceded",
      "passesCompleted", "passesAttempted", "longPasses", "longPassesCompleted",
      "keyPasses", "assists", "touches", "carries", "carryDistanceM", "carryProgressM",
      "dispossessed", "ticksPlayed", "minutesPlayed",
    ] as const;
    for (const k of keys) {
      const a = whole.players.reduce((s, p) => s + (p[k] as number), 0);
      const b = combined.players.reduce((s, p) => s + (p[k] as number), 0);
      expect(b, `${k} 가 하프 합산에서 달라졌다`).toBeCloseTo(a, 9);
    }
    // 히트맵도 통짜와 같다(빈별).
    const heatOf = (r: PlayerStatsResult): number[] => {
      const out = new Array<number>(96).fill(0);
      for (const p of r.players) for (let i = 0; i < 96; i++) out[i] = out[i]! + (p.heat[i] ?? 0);
      return out;
    };
    expect(heatOf(combined)).toEqual(heatOf(whole));
    expect(combined.ticks).toBe(whole.ticks);
  });

  it("⚠️ 뛴 거리는 하프 경계의 한 스텝을 잃는다 — 알고 남긴 성질이다", () => {
    // 하프마다 좌표가 새로 시작하므로 경계를 가로지르는 스텝은 어느 하프에도 속하지 않는다.
    // (실경기에서도 하프 사이엔 포메이션 리셋이 있어 그 스텝의 '주행'은 의미가 없다.)
    // 픽스처에서 움직이는 선수는 H2 하나(1m/틱)라 손실이 정확히 1m 로 드러난다.
    expect(whole.players.reduce((s, p) => s + p.distanceM, 0)).toBeCloseTo(47, 6);
    expect(combined.players.reduce((s, p) => s + p.distanceM, 0)).toBeCloseTo(46, 6);
  });

  it("공이 살아 있는 자리에서 잘라도 `선수합 + 잔차 = 팀합` 은 깨지지 않는다", () => {
    // t24 는 H4 가 공을 쥔 채라, 그 킥의 도착(t25 pass)이 다음 조각으로 넘어간다 → 패서 미상.
    // 숫자를 조용히 잃지 않고 **잔차로 드러나는지**가 계약이다.
    const bad = combinePlayerStats([
      computePlayerStats(sliceAt(0, 24), { gkKeys: GK_KEYS }),
      computePlayerStats(sliceAt(25, LAST_TICK), { gkKeys: GK_KEYS }),
    ]);
    const team = liveEventStats(FIXTURE.events as never[], Number.MAX_SAFE_INTEGER);
    expect(bad.players.reduce((s, p) => s + p.passesCompleted, 0) + bad.unattributed.passesCompleted)
      .toBe(team.home.passCompleted + team.away.passCompleted);
    expect(bad.players.reduce((s, p) => s + p.passesAttempted, 0) + bad.unattributed.passesAttempted)
      .toBe(team.home.passAttempts + team.away.passAttempts);
    // 그리고 그 손실이 실제로 일어났다(공허하게 통과하지 않는다).
    expect(bad.unattributed.passesCompleted).toBe(1);
  });

  it("경고누적·퇴장 플래그가 하프를 넘어 살아남는다", () => {
    expect(stat(combined, "away", "A2").secondYellow).toBe(true);
    expect(stat(combined, "away", "A2").sentOff).toBe(true);
  });

  it("성공률은 합계에서 다시 계산한다 — 하프 성공률의 평균이 아니다", () => {
    // 하프별 1/1(100%) + 1/3(33.3%) → 합계 2/4 = 50%. 평균이면 66.7% 가 나온다.
    const mk = (completes: number, fails: number): StatMatchLog => {
      const snaps: StatSnapshot[] = [];
      const events: StatEvent[] = [];
      let t = 0;
      const push = (owner: string | null): void => {
        snaps.push({
          tick: t,
          minute: 0,
          ball: { x: 50, y: 34 },
          ballOwner: owner,
          players: [
            { playerId: "H2", team: "home", pos: { x: 50, y: 34 } },
            { playerId: "H3", team: "home", pos: { x: 55, y: 34 } },
            { playerId: "A2", team: "away", pos: { x: 60, y: 34 } },
          ],
        });
        t++;
      };
      for (let i = 0; i < completes; i++) {
        push("H2");
        push(null);
        events.push({ tick: t, type: "pass", team: "home", playerId: "H3" });
        push("H3");
      }
      for (let i = 0; i < fails; i++) {
        push("H2");
        push(null);
        events.push({ tick: t, type: "interception", team: "away", playerId: "A2" });
        push("A2");
      }
      return { tickSnapshots: snaps, events };
    };
    const a = computePlayerStats(mk(1, 0));
    const b = computePlayerStats(mk(1, 2));
    expect(passPct(stat(a, "home", "H2"))).toBe(100);
    expect(passPct(stat(b, "home", "H2"))).toBeCloseTo(33.3, 1);
    const c = combinePlayerStats([a, b]);
    const h2 = stat(c, "home", "H2");
    expect([h2.passesCompleted, h2.passesAttempted]).toEqual([2, 4]);
    expect(passPct(h2)).toBe(50); // 66.7 이면 비율의 평균을 낸 것이다
  });

  it("시도가 0 이면 성공률은 null 이다 — 0% 는 거짓말이다", () => {
    expect(passPct({ passesAttempted: 0, passesCompleted: 0 })).toBeNull();
  });
});

// ── 10. 평점 · MOTM ──────────────────────────────────────────────────────

describe("평점 — 계수는 RATING_WEIGHTS 한 곳에만 있다", () => {
  const blank =(over: Partial<PlayerStatLine> = {}): PlayerStatLine => ({
    key: "home:X", team: "home", playerId: "X",
    goals: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, xg: 0,
    tackles: 0, interceptions: 0, clearances: 0, fouls: 0,
    yellowCards: 0, redCards: 0, secondYellow: false, sentOff: false,
    offsides: 0, saves: 0, goalsConceded: 0,
    passesAttempted: 0, passesCompleted: 0, longPasses: 0, longPassesCompleted: 0,
    keyPasses: 0, assists: 0, touches: 0, carries: 0, carryDistanceM: 0, carryProgressM: 0,
    dispossessed: 0, distanceM: 0, ticksPlayed: 1, minutesPlayed: 1, heat: [], rating: 6,
    ...over,
  });

  const B = RATING_WEIGHTS.base;

  it("아무것도 안 하면 기본점 그대로 — 그리고 그 기본점은 6.5 다(hero 확정 ②)", () => {
    expect(computeRating(blank())).toBe(B);
    // ⚠️ 이 리터럴만은 남긴다: "무관여 6.0 → 6.5" 는 hero 가 내린 **결정**이지
    //    내일 흔들 튜닝값이 아니다. 되돌아가면 여기서 걸려야 한다.
    expect(B).toBe(6.5);
  });

  it("골·도움·수비 기여는 올리고, 뺏김·파울·카드·실점은 내린다", () => {
    expect(computeRating(blank({ goals: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ assists: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ keyPasses: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ tackles: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ interceptions: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ clearances: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ saves: 1 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ passesAttempted: 10, passesCompleted: 10 }))).toBeGreaterThan(B);
    expect(computeRating(blank({ dispossessed: 1 }))).toBeLessThan(B);
    // ⚠️ 파울 1개는 **표시 해상도(소수 1자리) 아래**다(−0.05 → 반올림하면 기본점 그대로).
    //    의도한 성질이라(한 번 반칙했다고 평점이 내려가면 과하다) 발화하는 볼륨으로 건다.
    expect(computeRating(blank({ fouls: 1 }))).toBe(B);
    expect(computeRating(blank({ fouls: 4 }))).toBeLessThan(B);
    expect(computeRating(blank({ yellowCards: 1 }))).toBeLessThan(B);
    expect(computeRating(blank({ redCards: 1, sentOff: true }))).toBeLessThan(B);
    expect(computeRating(blank({ goalsConceded: 1 }))).toBeLessThan(B);
    expect(computeRating(blank({ passesAttempted: 10, passesCompleted: 0 }))).toBeLessThan(B);
  });

  it("골 1점 = 정확히 +1.0 (hero 확정 ①)", () => {
    expect(computeRating(blank({ goals: 1 }))).toBe(B + 1.0);
    expect(RATING_WEIGHTS.attack.goal).toBe(1.0);
  });

  /**
   * ⚠️ `keyPasses` 는 **어시스트를 포함**한다(`PlayerStatLine.keyPasses` 정의) → 어시스트 1개는
   * `assist` 와 `keyPass` **두 항에 모두** 걸린다. 계수를 조정할 때 `assist` 만 보면 실제보다
   * 낮게 읽는다. 그 실효치를 계약으로 박아 둔다 — 산식이 바뀌면 여기서 먼저 걸린다.
   */
  it("어시스트의 실효 가치 = assist + keyPass 이고, 골보다는 작다", () => {
    const eff = computeRating(blank({ assists: 1, keyPasses: 1 })) - B;
    // 평점은 소수 1자리로 반올림돼 나오므로 그 해상도로 비교한다.
    expect(eff).toBeCloseTo(RATING_WEIGHTS.attack.assist + RATING_WEIGHTS.attack.keyPass, 1);
    // 실효치가 골보다 작다 — 계수표에서도, 실제 산출에서도.
    expect(RATING_WEIGHTS.attack.assist + RATING_WEIGHTS.attack.keyPass)
      .toBeLessThan(RATING_WEIGHTS.attack.goal);
    expect(computeRating(blank({ assists: 1, keyPasses: 1 })))
      .toBeLessThan(computeRating(blank({ goals: 1 })));
  });

  it("min~max 로 클램프된다", () => {
    expect(computeRating(blank({ goals: 200 }))).toBe(RATING_WEIGHTS.max);
    expect(computeRating(blank({ fouls: 1000 }))).toBe(RATING_WEIGHTS.min);
  });

  it("포지션 희소성 보정 — 수비수의 골은 더, 공격수의 볼뺏기는 더 쳐준다", () => {
    expect(computeRating(blank({ goals: 1 }), "DF")).toBeGreaterThan(computeRating(blank({ goals: 1 }), "FW"));
    expect(computeRating(blank({ tackles: 5 }), "FW")).toBeGreaterThan(computeRating(blank({ tackles: 5 }), "DF"));
    // 포지션을 모르면 보정이 없다(= UNKNOWN 은 1.0 중립이라 곱해도 그대로다).
    expect(RATING_WEIGHTS.position.UNKNOWN).toEqual({ attack: 1, defence: 1 });
    expect(computeRating(blank({ goals: 1, tackles: 3 }))).toBeCloseTo(
      B + RATING_WEIGHTS.attack.goal + 3 * RATING_WEIGHTS.defence.tackle,
      1,
    );
  });

  /**
   * ⚠️ 여기에 **계수 값을 리터럴로 박지 않는다** — hero 가 릴리스 상태에서 조정하는 자리이고,
   * 리터럴로 박으면 조정할 때마다 계약이 깨져 신호가 죽는다(§2.5 사다리 정신).
   * 대신 **바뀌면 안 되는 것**만 건다: 부호 · 크기 순서 · 노브의 존재.
   */
  it("계수표의 구조 계약 — 부호와 크기 순서(값 자체는 hero 조정 대상이라 안 박는다)", () => {
    const W = RATING_WEIGHTS;
    // 보상은 +, 벌점은 −.
    for (const v of [W.attack.goal, W.attack.assist, W.attack.keyPass, W.attack.passCompleted,
      W.defence.tackle, W.defence.interception, W.defence.clearance,
      W.keeper.saveVolume, W.keeper.saveRateScale]) expect(v).toBeGreaterThan(0);
    for (const v of [W.attack.passFailed, W.keeper.goalConceded,
      W.discipline.dispossessed, W.discipline.foul, W.discipline.yellow, W.discipline.red]) expect(v).toBeLessThan(0);
    // 골 > 어시(실효) > 키패스 > 패스 1개.
    expect(W.attack.goal).toBeGreaterThan(W.attack.assist + W.attack.keyPass);
    expect(W.attack.keyPass).toBeGreaterThan(W.attack.passCompleted);
    // 퇴장이 경고보다 아프다.
    expect(W.discipline.red).toBeLessThan(W.discipline.yellow);
    // 상한/하한이 기본점을 사이에 둔다.
    expect(W.min).toBeLessThan(W.base);
    expect(W.base).toBeLessThan(W.max);
  });

  /**
   * 사다리(단조성) — **"이 계수가 정말 레버인가"**. 값을 박는 대신 *올리면 그 방향으로
   * 움직인다*를 건다. 계수가 코드에서 안 읽히면(=죽은 노브) 여기서 걸린다(§2.5).
   */
  it("계수를 올리면 평점이 그 방향으로 움직인다(죽은 노브 검출)", () => {
    /**
     * ⚠️ 클램프를 풀고 잰다. 안 그러면 상한 10.0 에 붙은 표본에서 **모든 bump 가 10 → 10** 이라
     * "안 움직였다"가 되고, 그건 노브가 죽어서가 아니라 자[尺]가 막힌 것이다(거짓 red).
     */
    const UNCLAMPED = ((): RatingWeights => {
      const w = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
      w.max = 1e6;
      w.min = -1e6;
      return w;
    })();
    const bump = (path: (w: RatingWeights) => void): RatingWeights => {
      const w = JSON.parse(JSON.stringify(UNCLAMPED)) as RatingWeights;
      path(w);
      return w;
    };
    const line = blank({
      goals: 1, assists: 1, keyPasses: 2, shots: 3, shotsOnTarget: 2,
      passesAttempted: 20, passesCompleted: 16, longPassesCompleted: 3,
      carries: 4, carryProgressM: 40,
      tackles: 2, interceptions: 3, clearances: 2,
      dispossessed: 1, fouls: 1, saves: 4, goalsConceded: 2,
    });
    const at = (w: RatingWeights): number => ratingWithWeights(line, "MF", w);
    const ref = at(UNCLAMPED);

    expect(at(bump((w) => { w.base += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.goal += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.assist += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.keyPass += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.shot += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.shotOnTarget += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.passCompleted += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.passFailed += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.longPassCompleted += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.carry += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.attack.carryProgressPer10m += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.defence.tackle += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.defence.interception += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.defence.clearance += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.keeper.saveVolume += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.keeper.goalConceded += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.discipline.dispossessed += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.discipline.foul += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.position.MF.attack += 0.5; }))).toBeGreaterThan(ref);
    expect(at(bump((w) => { w.position.MF.defence += 0.5; }))).toBeGreaterThan(ref);
    // 선방률이 기준선보다 높은 표본이라(4선방 2실점) 스케일을 키우면 올라간다.
    expect(at(bump((w) => { w.keeper.saveRateScale += 1; }))).toBeGreaterThan(ref);
    // 기준선을 올리면 같은 성적이 상대적으로 나빠진다.
    expect(at(bump((w) => { w.keeper.expectedSaveRate += 0.1; }))).toBeLessThan(ref);
    // 옐로/레드는 이 표본에 없다 — 있는 표본으로 따로 건다(무발화 노브 방지).
    const carded = blank({ yellowCards: 1 });
    expect(ratingWithWeights(carded, "MF", bump((w) => { w.discipline.yellow += 0.5; })))
      .toBeGreaterThan(ratingWithWeights(carded, "MF", UNCLAMPED));
    const off = blank({ redCards: 1, sentOff: true });
    expect(ratingWithWeights(off, "MF", bump((w) => { w.discipline.red += 0.5; })))
      .toBeGreaterThan(ratingWithWeights(off, "MF", UNCLAMPED));
  });
});

// ── 10-b. GK 선방률 축 (hero 확정 ③) ─────────────────────────────────────

describe("GK 평점 = 선방률 축 — 일한 양과 무관한 상수가 아니어야 한다", () => {
  const gk = (saves: number, conceded: number): PlayerStatLine => ({
    key: "home:GK", team: "home", playerId: "GK",
    goals: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, xg: 0,
    tackles: 0, interceptions: 0, clearances: 0, fouls: 0,
    yellowCards: 0, redCards: 0, secondYellow: false, sentOff: false,
    offsides: 0, saves, goalsConceded: conceded,
    passesAttempted: 0, passesCompleted: 0, longPasses: 0, longPassesCompleted: 0,
    keyPasses: 0, assists: 0, touches: 0, carries: 0, carryDistanceM: 0, carryProgressM: 0,
    dispossessed: 0, distanceM: 0, ticksPlayed: 1, minutesPlayed: 1, heat: [], rating: 0,
  });
  const B = RATING_WEIGHTS.base;

  /** 이 웨이브가 고치러 온 결함 그 자체(hero 제보). */
  it("6실점 6선방 GK 가 무관여와 같은 점수가 **아니다** (구 산식은 정확히 상쇄됐다)", () => {
    expect(computeRating(gk(6, 6), "GK")).not.toBe(B);
    // 구 산식: saves*0.30 + conceded*(−0.30) = 0 → 정확히 기본점. 그 상쇄가 사라졌는지 본다.
    expect(RATING_WEIGHTS.keeper.saveVolume + RATING_WEIGHTS.keeper.goalConceded).not.toBe(0);
  });

  it("많이 막은 키퍼가 많이 먹은 키퍼보다 높다(같은 유효슛 수)", () => {
    expect(computeRating(gk(8, 2), "GK")).toBeGreaterThan(computeRating(gk(2, 8), "GK"));
    expect(computeRating(gk(8, 2), "GK")).toBeGreaterThan(B);
    expect(computeRating(gk(2, 8), "GK")).toBeLessThan(B);
  });

  /**
   * 소표본 수축 — 유효슛 2개짜리 하프에서 선방률이 0%/100% 로 튀는 것을 막는다.
   * **같은 비율이면 표본이 클수록 기준선에서 멀어야** 한다(확신이 커진 것이니까).
   */
  it("표본이 얇을수록 기준선 쪽으로 당겨진다", () => {
    const small = computeRating(gk(2, 0), "GK") - B; // 유효슛 2, 100%
    const big = computeRating(gk(12, 0), "GK") - B; // 유효슛 12, 100%
    expect(big).toBeGreaterThan(small);
    // 아래쪽도 같다.
    const smallBad = B - computeRating(gk(0, 2), "GK");
    const bigBad = B - computeRating(gk(0, 12), "GK");
    expect(bigBad).toBeGreaterThan(smallBad);
  });

  /**
   * ⚠️ **출하값을 한쪽 팔로 쓰지 마라 — 그게 지뢰다.**
   *
   * 종전 계약은 `priorFaced = 0` 을 **출하 표와** 견줬다(`> computeRating(thin, "GK")`).
   * 그러면 hero 가 출하값을 0 으로 내리는 순간 두 팔이 같은 값이 되어 **비교가 자기 자신과의
   * 비교로 퇴화**하고 red 가 된다 — 그런데 `priorFaced = 0` 은 가상의 설정이 아니라
   * **수축 아블레이션과 하네스 `--weights` 경로가 실제로 쓰는 값**이다(`player-stats.ts` 의
   * `keeperAxis` 주석). 조정하면 red 가 되는 계약은 신호가 아니라 지뢰다(#403 W1d minor-1 과 같은 부류).
   *
   * 그래서 **두 팔을 다 주입한다.** 출하값이 무엇이든 성질이 성립하고, 재는 것은 계수가 아니라
   * `keeperAxis` 의 **수축 산식**이다: 사전표본을 많이 깔수록 얇은 표본의 답이 기준선으로 당겨진다.
   * (`saveRateScale` 도 고정 상수로 주입한다 — 이 계약은 "수축이 작동하는가"이지 그 세기가 아니다.)
   */
  describe("`priorFaced` 가 그 수축의 세기다 — 출하값과 무관한 성질로 건다", () => {
    /** 축을 켠 채 밴드를 연 표. `priorFaced` 만 바뀌고 나머지는 모든 팔에서 동일하다. */
    const at = (prior: number, line: PlayerStatLine): number => {
      const w = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
      w.keeper.priorFaced = prior;
      w.keeper.saveRateScale = 10; // 반올림(0.1)이 사다리를 삼키지 않게 크게
      w.keeper.expectedSaveRate = 0.5;
      w.max = 1e6; // 클램프가 비교를 먹으면 "안 움직였다"가 거짓 red 가 된다
      w.min = -1e6;
      return ratingWithWeights(line, "GK", w);
    };
    const LADDER = [0, 1, 4, 16] as const;

    it("사전표본을 늘릴수록 얇은 표본이 기준선으로 당겨진다(양방향)", () => {
      // 위쪽 — 유효슛 2개를 다 막은 키퍼. 수축이 세질수록 내려온다.
      const up = LADDER.map((p) => at(p, gk(2, 0)));
      for (let i = 1; i < up.length; i++) {
        expect(up[i]!, `prior ${LADDER[i]} vs ${LADDER[i - 1]}: ${up}`).toBeLessThan(up[i - 1]!);
      }
      // 아래쪽 — 유효슛 2개를 다 먹은 키퍼. 수축이 세질수록 올라온다.
      const down = LADDER.map((p) => at(p, gk(0, 2)));
      for (let i = 1; i < down.length; i++) {
        expect(down[i]!, `prior ${LADDER[i]} vs ${LADDER[i - 1]}: ${down}`).toBeGreaterThan(down[i - 1]!);
      }
    });

    it("수축은 **얇은** 표본에 더 세게 걸린다(그게 이 장치가 있는 이유다)", () => {
      const thin = Math.abs(at(0, gk(2, 0)) - at(16, gk(2, 0)));
      const thick = Math.abs(at(0, gk(24, 0)) - at(16, gk(24, 0)));
      expect(thin, `thin ${thin} · thick ${thick}`).toBeGreaterThan(thick);
    });
  });

  /** 필드 플레이어에게 무해해야 한다 — 포지션 라벨이 아니라 **한 일**로 분기하므로. */
  it("유효슛을 상대한 적이 없으면 이 축은 통째로 0 이다", () => {
    expect(computeRating(gk(0, 0), "GK")).toBe(B);
    expect(computeRating(gk(0, 0), "FW")).toBe(B);
  });

  it("`positions` 를 안 넘겨도 GK 는 제 축을 받는다(옵션 누락에 견딘다)", () => {
    expect(computeRating(gk(8, 2))).toBeGreaterThan(B);
    expect(computeRating(gk(2, 8))).toBeLessThan(B);
  });

  /**
   * ⚠️ **이 계약이 `keeperAxis` 의 분모 가드가 존재하는 이유다.**
   *
   * `priorFaced = 0`(수축 끄기)은 가상의 설정이 아니다 — 수축 아블레이션과 하네스의
   * `--weights` 경로가 **실제로 쓰는 값**이고, hero 가 조정하라고 내준 표면 위에 있다.
   * 거기에 `faced = 0`(유효슛을 한 번도 안 상대한 선수 = **필드 플레이어 전원**)이 겹치면
   * `0/0 = NaN` 이 되고, NaN 은 `Math.min`/`Math.max` 비교를 **전부 통과**해 클램프도 못 막는다
   * → 화면의 모든 평점이 NaN.
   *
   * 그래서 "계수를 0 으로 내려도 유한값이 나온다"를 계약으로 박는다. 가드를 지우거나
   * 조건을 무력화(`if (true)`)하면 여기서 걸린다.
   */
  it("hero 가 `priorFaced` 를 0 으로 내려도 평점이 유한하다(NaN 금지)", () => {
    const w = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
    w.keeper.priorFaced = 0;
    for (const [saves, conceded] of [[0, 0], [3, 0], [0, 3], [4, 4]] as const) {
      const v = ratingWithWeights(gk(saves, conceded), "GK", w);
      expect(Number.isFinite(v)).toBe(true);
      expect(Number.isNaN(v)).toBe(false);
    }
    // 필드 플레이어(유효슛 0)도 — 여기가 NaN 이면 화면 전체가 NaN 이 된다.
    const field = ratingWithWeights(gk(0, 0), "MF", w);
    expect(Number.isFinite(field)).toBe(true);
    expect(field).toBe(w.base);
  });

  /**
   * ⚠️ 종전 계약은 *"**출하값에서는** 분모 가드가 `faced > 0` 과 같은 답을 낸다"* 였고,
   * 그 성질은 `RATING_WEIGHTS.keeper.priorFaced > 0` **이기 때문에만** 참이라 단언 한 줄이
   * 출하값 사실 게이트였다(= 0 으로 내리면 red = 지뢰).
   *
   * 실은 그 등가가 **모든 `priorFaced ≥ 0` 에서** 참이다:
   *  - `prior > 0` → `faced = 0` 에서 `shrunk = (0 + prior·E)/(0 + prior) = E` → 기여 정확히 **0**.
   *  - `prior = 0` → `denom = faced` 라 두 조건이 **문자 그대로 같다**.
   * 그래서 값을 보지 않고 그 등가 자체를 건다 — "유효슛을 상대한 적 없는 선수에게 이 축은
   * 정확히 0 을 준다, `priorFaced` 가 무엇이든". 가드를 `if (true)` 로 무력화하면
   * `prior = 0` 팔에서 `0/0 = NaN` 이 되어 여기서 걸린다(NaN 은 clamp 를 통과한다).
   */
  it("분모 가드는 `priorFaced` 값과 무관하게 옳다 — faced = 0 이면 기여가 정확히 0", () => {
    for (const prior of [0, 1, 4, 16]) {
      const w = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
      w.keeper.priorFaced = prior;
      const idle = ratingWithWeights(gk(0, 0), "GK", w);
      expect(Number.isNaN(idle), `prior ${prior}`).toBe(false);
      // 기여가 0 = 이 축을 통째로 건너뛴 것(`faced > 0` 가드)과 같은 답.
      expect(idle, `prior ${prior}`).toBe(w.base);
      // 필드 플레이어도 같다 — 여기가 NaN 이면 화면의 모든 평점이 NaN 이 된다.
      expect(ratingWithWeights(gk(0, 0), "MF", w), `prior ${prior}`).toBe(w.base);
    }
    // 출하 경로에서도 같은 답인지 한 번 더(주입 경로만 맞고 기본 경로가 어긋나는 것 방지).
    expect(computeRating(gk(0, 0), "GK")).toBe(B);
  });

  /** 계수를 전부 0 으로 내려도(hero 가 축을 꺼 보는 극단) 깨지지 않는다. */
  it("계수를 0 으로 내린 극단에서도 유한하다", () => {
    const w = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
    w.keeper.priorFaced = 0;
    w.keeper.saveRateScale = 0;
    w.keeper.expectedSaveRate = 0;
    w.keeper.saveVolume = 0;
    w.keeper.goalConceded = 0;
    for (const [s, c] of [[0, 0], [5, 5]] as const) {
      expect(Number.isFinite(ratingWithWeights(gk(s, c), "GK", w))).toBe(true);
    }
  });
});

// ── 10-c. 상한 클램프 (m2 — **계수를 방어하지 않는다**) ─────────────────────

/**
 * ⚠️ **여기에 계수 회귀 게이트를 만들지 마라.**
 *
 * 처음 이 describe 는 *"`태클 12 + 가로챔 17` 은 **세 포지션 전부** 상한에 닿는다"* 를 단언했다.
 * 우변에 리터럴이 없어(`toBe(RATING_WEIGHTS.max)`) "사실 기록"처럼 보였지만, 실제로는 **그 입력이
 * 상한에 닿는다는 것 자체**를 박제하는 계수 게이트였다 — 통합 검증 실측으로 변이 4종
 * (`defence.tackle 0.22→0.11` · `defence.interception 0.13→0.065` · `max 10→20` ·
 * `position.DF.defence 1.1→0.5`)이 **정확히 이 두 건만** red 로 만들었다.
 * 그 넷은 전부 hero 가 "수비 볼륨 포화"를 완화하려고 **내일 내릴 바로 그 값**이다
 * (#403 W1b 조정 포인트 1번). **조정하면 red 가 되는 계약은 신호가 아니라 지뢰다.**
 *
 * 그래서 지금 남은 것은 **계수와 무관하게 참인 성질**뿐이다 — 클램프는 `[min, max]` 밖으로
 * 내보내지 않고, 그 잘림이 실제로 클램프다. **얼마나 포화하는가는 코드가 아니라 문서·하네스가
 * 기록한다**(`apps/web/scripts/rating-distribution.ts` 의 `포화%` 열은 계수를 바꾸면 당연히 바뀐다).
 *
 * 근거 수치(W1c 시점 리얼 config 실측 — **스냅샷이지 계약이 아니다**):
 *  - 라이브형 라인 `태클 12 + 가로챔 17` = DF 11.84 · MF 10.62 · FW 13.29 → 전부 10.0 으로 clamp.
 *  - 픽스처 표본에서 **DF 800 중 10건(1.25%)이 0골·0어시로 10.0**(예: `seed 1122334455` 의 `home:H3`).
 */
describe("상한 클램프 — 계수와 무관하게 참인 성질만 건다", () => {
  const line = (over: Partial<PlayerStatLine>): PlayerStatLine => ({
    key: "home:D", team: "home", playerId: "D",
    goals: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, xg: 0,
    tackles: 0, interceptions: 0, clearances: 0, fouls: 0,
    yellowCards: 0, redCards: 0, secondYellow: false, sentOff: false,
    offsides: 0, saves: 0, goalsConceded: 0,
    passesAttempted: 0, passesCompleted: 0, longPasses: 0, longPassesCompleted: 0,
    keyPasses: 0, assists: 0, touches: 0, carries: 0, carryDistanceM: 0, carryProgressM: 0,
    dispossessed: 0, distanceM: 0, ticksPlayed: 1, minutesPlayed: 1, heat: [], rating: 0,
    ...over,
  });

  /**
   * 수비 볼륨이 아무리 커도 표시값은 밴드 안이다 — 계수를 올리든 내리든 참이다.
   * (구 계약은 여기서 `toBe(max)` 였고, 그래서 계수를 **내리는** 순간 red 였다.)
   */
  it("수비 볼륨이 큰 라인도 어떤 포지션에서든 [min, max] 안이다", () => {
    const heavy = line({ tackles: 12, interceptions: 17 });
    for (const pos of ["DF", "MF", "FW"] as const) {
      const v = computeRating(heavy, pos);
      expect(v, `${pos}: ${v}`).toBeLessThanOrEqual(RATING_WEIGHTS.max);
      expect(v, `${pos}: ${v}`).toBeGreaterThanOrEqual(RATING_WEIGHTS.min);
    }
    // 입력의 사실(계수와 무관) — 이 라인은 공격 기여가 0 이다.
    expect(heavy.goals).toBe(0);
    expect(heavy.assists).toBe(0);
  });

  /**
   * 잘림이 **진짜 클램프인지**는 계수 없이도 검사할 수 있다 — 밴드를 활짝 연 표로 같은 라인을
   * 재고, 출하 표의 결과가 그 값을 `[min, max]` 로 자른 것과 같은지 본다.
   * ⚠️ **헤드룸이 얼마인지는 단언하지 않는다** — 그게 계수 게이트가 되던 자리다.
   */
  it("표시값 = 밴드를 연 계산값을 [min, max] 로 자른 것(클램프가 실제로 클램프다)", () => {
    const wide = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
    wide.max = 1e6;
    wide.min = -1e6;
    /**
     * ⚠️ **표본이 상한만 건드리면 `min` 커버리지가 0 이다**(통합 검증 minor-b): `min` 클램프를
     * 지워도 위 세 표본은 전부 green 이었다 — `fouls 40` 조차 4.5 로 밴드 **안**이라, 하한을
     * 잡는 것은 오직 옆의 `[min, max] 안이다` 계약 하나뿐이었다. 그게 언젠가 은퇴하면 조용히 0 이 된다.
     * 그래서 **규율 항이 확실히 하한을 넘기는 합성 라인**을 넣는다. 규율은 포지션 배수를 안 타므로
     * (`ratingWithWeights`: `discipline` 은 `pos` 와 안 곱한다) 세 포지션 모두에서 아래로 뚫린다.
     * ⚠️ 계수 게이트가 아니다 — 단언은 여전히 "잘린 값과 같다"이고, 계수가 바뀌어 이 표본이
     * 하한에 안 닿아도 **red 가 되지 않는다**(커버리지만 줄어든다).
     */
    const belowMin = line({ fouls: 40, dispossessed: 40, yellowCards: 2, secondYellow: true, sentOff: true });
    for (const l of [line({ tackles: 12, interceptions: 17 }), line({ goals: 9 }), line({ fouls: 40 }), belowMin]) {
      for (const pos of ["DF", "MF", "FW"] as const) {
        const raw = ratingWithWeights(l, pos, wide);
        const cut = Math.min(RATING_WEIGHTS.max, Math.max(RATING_WEIGHTS.min, raw));
        expect(computeRating(l, pos)).toBeCloseTo(cut, 5);
      }
    }
  });
});

// ── 10-d. 계수표는 런타임에도 못 바꾼다 (통합 검증 minor-2) ─────────────────

/**
 * `DeepReadonly` 는 **컴파일 타임 전용**이라 주장이 실효를 넘었다 — 검증자가 실행으로 확인한
 * 우회가 이것이다(tsc 0 에러):
 * ```ts
 * const alias: RatingWeights = RATING_WEIGHTS;  // readonly → mutable 대입은 TS 가 안 본다
 * alias.base = 3.0;                             // 앱 전역 평점이 바뀐다
 * ```
 * 주장을 낮추는 대신 **주장이 참이 되게** 재귀 `Object.freeze` 를 걸었다. 이 계약은 그 잠금이
 * 조용히 풀리는 것을 잡는다(값은 하나도 안 본다 = hero 의 조정과 무관하다).
 */
describe("RATING_WEIGHTS 는 런타임에도 못 바꾼다", () => {
  const blank = (): PlayerStatLine => ({
    key: "home:X", team: "home", playerId: "X",
    goals: 0, shots: 0, shotsOnTarget: 0, shotsOffTarget: 0, xg: 0,
    tackles: 0, interceptions: 0, clearances: 0, fouls: 0,
    yellowCards: 0, redCards: 0, secondYellow: false, sentOff: false,
    offsides: 0, saves: 0, goalsConceded: 0,
    passesAttempted: 0, passesCompleted: 0, longPasses: 0, longPassesCompleted: 0,
    keyPasses: 0, assists: 0, touches: 0, carries: 0, carryDistanceM: 0, carryProgressM: 0,
    dispossessed: 0, distanceM: 0, ticksPlayed: 1, minutesPlayed: 1, heat: [], rating: 0,
  });

  it("중첩까지 얼어 있다 — 별칭으로도 못 바꾼다", () => {
    expect(Object.isFrozen(RATING_WEIGHTS)).toBe(true);
    expect(Object.isFrozen(RATING_WEIGHTS.attack)).toBe(true);
    expect(Object.isFrozen(RATING_WEIGHTS.keeper)).toBe(true);
    expect(Object.isFrozen(RATING_WEIGHTS.position)).toBe(true);
    expect(Object.isFrozen(RATING_WEIGHTS.position.FW)).toBe(true);

    // TS 는 이 대입을 막지 않는다(readonly → mutable) — 그래서 런타임이 막아야 한다.
    const alias = RATING_WEIGHTS as unknown as RatingWeights;
    const base = alias.base;
    const fwAttack = alias.position.FW.attack;
    expect(() => {
      alias.base = 3.0;
    }).toThrow(TypeError);
    expect(() => {
      alias.position.FW.attack = 99;
    }).toThrow(TypeError);
    expect(alias.base).toBe(base);
    expect(alias.position.FW.attack).toBe(fwAttack);
    expect(computeRating(blank(), "MF")).toBe(RATING_WEIGHTS.base);
  });

  it("정당한 스윕 경로(`ratingWithWeights`)는 그대로 열려 있다", () => {
    const w = JSON.parse(JSON.stringify(RATING_WEIGHTS)) as RatingWeights;
    w.base = RATING_WEIGHTS.base + 1;
    expect(ratingWithWeights(blank(), "MF", w)).toBe(w.base);
    // 원본은 그대로 — 복제본을 만졌다고 전역이 따라 움직이면 잠금이 무의미하다.
    expect(computeRating(blank(), "MF")).toBe(RATING_WEIGHTS.base);
  });
});

describe("MOTM", () => {
  /**
   * ⚠️ **"결정적 공격 기여자 중 하나"는 값 의존이었다.**
   *
   * 종전 계약은 MOTM 이 `goals > 0 || assists > 0` 인 선수여야 한다고 걸었다. 그건 이 픽스처에서
   * 공격 기여자가 최고 평점이라는 **계수 의존 사실**이라, GK 축을 만지면(예: 수축 아블레이션
   * `priorFaced 4→0` — 얇은 표본의 선방률이 그대로 튀어 GK 가 1위로 올라온다) 무너진다.
   * MOTM 이 잘못 뽑힌 게 아니라 **1위가 바뀐 것**인데 계약이 red 가 되는 = 지뢰다.
   *
   * 남기는 것은 계수와 무관하게 참인 성질뿐이다 — ① 뽑힌 사람의 평점이 실제 최댓값이고
   * ② 그 최댓값 집합 안에서 골랐으며 ③ 후보 풀이 **양 팀에 걸쳐 있다**(= "팀 무관"이 이 표본에서
   * 실제로 시험된다). "팀 무관"에 이빨을 주는 것은 아래의 원정 1위 케이스다.
   */
  it("팀 무관 최고 평점 1명", () => {
    const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });
    const playing = res.players.filter((p) => p.ticksPlayed > 0);
    expect(res.motm).not.toBeNull();
    const best = Math.max(...playing.map((p) => p.rating));
    expect(res.motm!.rating).toBe(best);
    const top = playing.filter((p) => p.rating === best).map((p) => p.key);
    expect(top).toContain(res.motm!.key);
    // 이 픽스처가 "팀 무관"을 실제로 시험하는가 — 한쪽 팀만 있으면 위 단언은 공허하다.
    expect([...new Set(playing.map((p) => p.team))].sort()).toEqual(["away", "home"]);
  });

  /**
   * 팀 무관에 이빨 — 1위가 원정이면 원정이 MOTM 이다. 가정은 **"골은 평점을 올린다"** 하나뿐이고
   * (hero 확정 ① 의 방향 불변식) 값은 하나도 안 본다.
   */
  it("최고 평점이 원정 선수면 원정이 MOTM 이다", () => {
    const res = computePlayerStats({
      tickSnapshots: [
        {
          tick: 0, minute: 0, ball: { x: 50, y: 34 }, ballOwner: null,
          players: [
            { playerId: "H1", team: "home", pos: { x: 10, y: 34 } },
            { playerId: "A1", team: "away", pos: { x: 90, y: 34 } },
          ],
        },
      ],
      events: [{ tick: 0, type: "goal", team: "away", playerId: "A1" }],
    });
    expect(stat(res, "away", "A1").rating).toBeGreaterThan(stat(res, "home", "H1").rating);
    expect(res.motm!.key).toBe("away:A1");
    expect(res.motm!.team).toBe("away");
  });

  it("동점이면 골 → 어시스트 → 키 순으로 결정론적으로 고른다(순서를 바꿔도 같은 답)", () => {
    const mk = (ids: string[]): PlayerStatsResult =>
      computePlayerStats({
        tickSnapshots: [
          {
            tick: 0,
            minute: 0,
            ball: { x: 50, y: 34 },
            ballOwner: null,
            players: ids.map((id, i) => ({ playerId: id, team: "home" as const, pos: { x: 10 * i, y: 34 } })),
          },
        ],
        events: [],
      });
    const a = mk(["H1", "H2", "H3"]);
    const b = mk(["H3", "H2", "H1"]);
    expect(a.motm!.key).toBe("home:H1"); // 전원 6.0 동점 → 키 오름차순
    expect(b.motm!.key).toBe(a.motm!.key);
  });

  it("출전 0틱(이벤트만 있는 선수)은 MOTM 후보가 아니다", () => {
    const res = computePlayerStats({
      tickSnapshots: [
        {
          tick: 0, minute: 0, ball: { x: 50, y: 34 }, ballOwner: null,
          players: [{ playerId: "H1", team: "home", pos: { x: 5, y: 34 } }],
        },
      ],
      events: [{ tick: 0, type: "goal", team: "away", playerId: "GHOST" }],
    });
    expect(stat(res, "away", "GHOST").goals).toBe(1);
    expect(stat(res, "away", "GHOST").ticksPlayed).toBe(0);
    expect(res.motm!.key).toBe("home:H1");
  });
});

// ── 11. 방어 ─────────────────────────────────────────────────────────────

describe("손상·빈 입력", () => {
  it("빈 로그로 죽지 않는다", () => {
    const r = computePlayerStats({});
    expect(r.players).toEqual([]);
    expect(r.motm).toBeNull();
    expect(r.ticks).toBe(0);
  });

  it("팀이 없는 선수·이벤트는 조용히 무시하고 나머지를 집계한다", () => {
    const r = computePlayerStats({
      tickSnapshots: [
        {
          tick: 0, minute: 0, ball: { x: 1, y: 1 }, ballOwner: null,
          players: [
            { playerId: "X", pos: { x: 1, y: 1 } }, // team 없음
            { playerId: "H1", team: "home", pos: { x: 2, y: 2 } },
          ],
        },
      ],
      events: [{ tick: 0, type: "foul", playerId: "H1" }], // team 없음
    });
    expect(r.players.map((p) => p.key)).toEqual(["home:H1"]);
    expect(r.unattributed.events["foul"]).toBe(1);
  });

  it("heatBins 가 다른 결과는 합칠 수 없다(조용히 잘못된 히트맵을 만들지 않는다)", () => {
    const a = computePlayerStats(FIXTURE, { heatBins: { cols: 4, rows: 4 } });
    const b = computePlayerStats(FIXTURE, { heatBins: { cols: 12, rows: 8 } });
    expect(() => combinePlayerStats([a, b])).toThrow();
  });
});

// ── 12. 히트맵 공간 매핑 ─────────────────────────────────────────────────

describe("히트맵은 좌표를 **그 빈에** 앉힌다", () => {
  /**
   * ⚠️ 종전 계약은 `합 == ticksPlayed` 와 `length === 96` 뿐이라, `idx = 0` 고정 · row 붕괴 ·
   * x/y 축 스왑 · `pitch` 옵션 무시가 **전부 통과했다**(= 히트맵이 통째로 틀려도 초록).
   * 공간 단언 없이는 "몇 개인가"만 맞고 "어디인가"는 아무도 안 본다.
   */
  const one = (x: number, y: number): StatMatchLog => ({
    tickSnapshots: [
      {
        tick: 0,
        minute: 0,
        ball: { x: 0, y: 0 },
        ballOwner: null,
        players: [{ playerId: "X", team: "home", pos: { x, y } }],
      },
    ],
    events: [],
  });
  const binsOf = (log: StatMatchLog, opts = {}): number[] =>
    stat(computePlayerStats(log, opts), "home", "X").heat;
  const hot = (heat: number[]): number[] =>
    heat.map((v, i) => (v > 0 ? i : -1)).filter((i) => i >= 0);

  it("기본 105×68 / 12×8 에서 좌표가 계산된 빈 하나에만 앉는다", () => {
    // col = floor(x/105*12), row = floor(y/68*8), idx = row*12 + col.
    expect(hot(binsOf(one(5, 34)))).toEqual([48]); // col 0, row 4
    expect(hot(binsOf(one(100, 34)))).toEqual([59]); // col 11, row 4
    expect(hot(binsOf(one(52.5, 8.5)))).toEqual([18]); // col 6, row 1
    expect(hot(binsOf(one(0, 0)))).toEqual([0]); // 좌상단
  });

  it("x 는 길이축, y 는 폭축이다 — 축을 바꾸면 다른 빈이 된다", () => {
    // (5,34) 를 축 스왑으로 읽으면 col=floor(34/105*12)=3, row=floor(5/68*8)=0 → idx 3.
    expect(hot(binsOf(one(5, 34)))).not.toEqual([3]);
    // 두 점이 x 만 다르면 **같은 row, 다른 col** 이어야 한다.
    const a = hot(binsOf(one(10, 34)))[0]!;
    const b = hot(binsOf(one(90, 34)))[0]!;
    expect(Math.floor(a / 12)).toBe(Math.floor(b / 12)); // 같은 row
    expect(a % 12).toBeLessThan(b % 12); // col 이 x 를 따라간다
    // 두 점이 y 만 다르면 **같은 col, 다른 row**.
    const c = hot(binsOf(one(52.5, 5)))[0]!;
    const d = hot(binsOf(one(52.5, 60)))[0]!;
    expect(c % 12).toBe(d % 12);
    expect(Math.floor(c / 12)).toBeLessThan(Math.floor(d / 12));
  });

  it("경계를 넘는 좌표는 마지막 빈으로 클램프된다(배열 밖으로 새지 않는다)", () => {
    expect(hot(binsOf(one(105, 68)))).toEqual([95]);
    expect(hot(binsOf(one(999, 999)))).toEqual([95]);
    expect(binsOf(one(999, 999)).reduce((a, b) => a + b, 0)).toBe(1);
  });

  it("`pitch` 를 바꾸면 빈이 따라 움직인다(옵션이 실제로 흐른다)", () => {
    // 같은 좌표라도 피치가 두 배면 col/row 가 앞쪽으로 간다: col 0, row 2 → idx 24.
    expect(hot(binsOf(one(5, 34), { pitch: { lengthM: 210, widthM: 136 } }))).toEqual([24]);
    expect(hot(binsOf(one(5, 34)))).toEqual([48]); // 기본과 다르다
  });

  it("`heatBins` 를 바꾸면 격자와 길이가 따라 움직인다", () => {
    const heat = binsOf(one(5, 34), { heatBins: { cols: 4, rows: 2 } });
    expect(heat).toHaveLength(8);
    expect(hot(heat)).toEqual([4]); // col 0, row 1 → 1*4+0
  });

  it("양 골키퍼는 서로 **반대쪽 열**에 앉는다(피치 방향이 살아 있다)", () => {
    const res = computePlayerStats(FIXTURE, { gkKeys: GK_KEYS });
    const colOf = (line: PlayerStatLine): number => {
      let sum = 0;
      let n = 0;
      for (let i = 0; i < line.heat.length; i++) {
        sum += (i % 12) * line.heat[i]!;
        n += line.heat[i]!;
      }
      return sum / n;
    };
    const home = colOf(stat(res, "home", "H1")); // x=5
    const away = colOf(stat(res, "away", "A1")); // x=100
    expect(home).toBeLessThan(2);
    expect(away).toBeGreaterThan(10);
    expect(away - home).toBeGreaterThan(8);
  });
});

// ── 13. 옵션 키는 `(team, playerId)` 다 ─────────────────────────────────

describe("`gkKeys`·`positions` 도 팀 스코프 키를 쓴다 (옵션이 이 파일의 규율을 뚫지 못하게)", () => {
  /**
   * ⚠️ 맨 `playerId` 로 받던 동안 `{P7}` 하나가 **양 팀 P7 을 모두** GK/DF 로 만들었다.
   * 그건 #231 이 엔진에서 하프를 죽인 것과 **같은 모양의 결함**이다.
   * 규칙 하나당 표본 하나 — 중복 id 전용 픽스처로 태운다.
   */
  const dupGk: StatMatchLog = {
    tickSnapshots: [0, 1].map((t) => ({
      tick: t,
      minute: 0,
      ball: { x: 52, y: 34 },
      ballOwner: null,
      players: [
        { playerId: "P1", team: "home" as const, pos: { x: 5, y: 34 } }, // home GK
        { playerId: "P7", team: "home" as const, pos: { x: 60, y: 34 } },
        { playerId: "P1", team: "away" as const, pos: { x: 100, y: 34 } }, // away GK (같은 id)
        { playerId: "P7", team: "away" as const, pos: { x: 45, y: 34 } },
      ],
    })),
    events: [
      { tick: 1, type: "goal", team: "home", playerId: "P7", xg: 0.4 },
      { tick: 1, type: "goal", team: "away", playerId: "P7", xg: 0.3 },
    ],
  };

  it("실점은 **그 팀** GK 에게만 붙는다 — 반대 팀 동명 GK 로 새지 않는다", () => {
    const res = computePlayerStats(dupGk, {
      gkKeys: playerKeySet([["home", "P1"], ["away", "P1"]]),
    });
    expect(stat(res, "away", "P1").goalsConceded).toBe(1); // home 골
    expect(stat(res, "home", "P1").goalsConceded).toBe(1); // away 골
    // 유령 행이 생기지 않는다.
    expect(res.players.map((p) => p.key)).toEqual(["home:P1", "home:P7", "away:P1", "away:P7"]);
  });

  it("한쪽만 GK 로 지정하면 그쪽만 실점을 받는다", () => {
    const res = computePlayerStats(dupGk, { gkKeys: playerKeySet([["away", "P1"]]) });
    expect(stat(res, "away", "P1").goalsConceded).toBe(1);
    expect(stat(res, "home", "P1").goalsConceded).toBe(0);
  });

  it("포지션 보정도 지정한 팀에만 걸린다", () => {
    const res = computePlayerStats(dupGk, { positions: { "home:P7": "DF" } });
    // 둘 다 골 1 + 유효슛 1 로 **기록이 같다** → 차이는 오직 포지션 보정에서 온다.
    // (값은 hero 조정 대상이라 안 박고, DF 공격 보정이 UNKNOWN 보다 크다는 관계로 건다.)
    expect(RATING_WEIGHTS.position.DF.attack).toBeGreaterThan(RATING_WEIGHTS.position.UNKNOWN.attack);
    expect(stat(res, "home", "P7").rating).toBeGreaterThan(stat(res, "away", "P7").rating);
    expect(stat(res, "away", "P7").rating).toBe(computeRating(stat(res, "away", "P7")));
  });

  it("맨 playerId 를 키로 주면 아무에게도 안 걸린다(조용히 절반만 걸리는 것보다 낫다)", () => {
    const res = computePlayerStats(dupGk, {
      positions: { P7: "DF" } as Record<string, "DF">,
      gkKeys: new Set(["P1"]),
    });
    // 아무도 보정을 못 받았다 = 양쪽이 **같다**(리터럴이 필요 없는 더 강한 계약).
    expect(stat(res, "home", "P7").rating).toBe(stat(res, "away", "P7").rating);
    expect(stat(res, "home", "P7").rating).toBe(computeRating(stat(res, "home", "P7")));
    expect(stat(res, "home", "P1").goalsConceded).toBe(0);
  });

  it("`playerKeySet` 이 옵션 키를 만든다", () => {
    expect([...playerKeySet([["home", "P7"], ["away", "P7"]])]).toEqual(["home:P7", "away:P7"]);
  });
});

describe("옵션이 결과까지 흐른다 (직접 호출만 검사하면 배선이 끊겨도 초록이다)", () => {
  /**
   * ⚠️ `computeRating` 을 직접 불러 보정을 검사하면, `computePlayerStats` 안에서
   * `opts.positions` 를 `undefined` 로 바꾸는 변이가 통과한다. 파이프라인 끝에서 재야 한다.
   */
  const posOf = (p: Record<string, "DF" | "FW"> | undefined): number =>
    stat(computePlayerStats(FIXTURE, { gkKeys: GK_KEYS, positions: p }), "home", "H4").rating;

  it("computePlayerStats — 포지션에 따라 최종 평점이 갈린다", () => {
    // H4 = 어시+키패스(공격) + 태클(수비) → DF·FW 보정이 **서로 다른 항**을 키운다.
    // 값은 hero 조정 대상이라 안 박고, "보정이 파이프라인 끝까지 흐른다"를 관계로 건다.
    const none = posOf(undefined);
    const df = posOf({ "home:H4": "DF" });
    const fw = posOf({ "home:H4": "FW" });
    // 세 값이 **서로 다르다** = 옵션이 파이프라인 끝까지 흘렀고 실제로 답을 바꾼다.
    // (어느 쪽이 큰지는 계수표에 달렸다 — FW 는 공격 보정이 1 미만이라 H4 를 낮출 수도 있다.)
    expect(new Set([none, df, fw]).size).toBe(3);
  });

  it("combinePlayerStats — 합산 결과에도 포지션이 흐른다", () => {
    const halves = (): PlayerStatsResult[] => [
      computePlayerStats(
        {
          tickSnapshots: (FIXTURE.tickSnapshots ?? []).filter((s) => s.tick <= 29),
          events: (FIXTURE.events ?? []).filter((e) => e.tick <= 29),
        },
        { gkKeys: GK_KEYS },
      ),
      computePlayerStats(
        {
          tickSnapshots: (FIXTURE.tickSnapshots ?? []).filter((s) => s.tick > 29),
          events: (FIXTURE.events ?? []).filter((e) => e.tick > 29),
        },
        { gkKeys: GK_KEYS },
      ),
    ];
    const plain = stat(combinePlayerStats(halves()), "home", "H4").rating;
    const asDf = stat(combinePlayerStats(halves(), { positions: { "home:H4": "DF" } }), "home", "H4").rating;
    const asFw = stat(combinePlayerStats(halves(), { positions: { "home:H4": "FW" } }), "home", "H4").rating;
    // 합산 경로에서도 세 값이 서로 다르다(= 포지션이 흐른다). 방향은 계수표 소관.
    expect(new Set([plain, asDf, asFw]).size).toBe(3);
  });
});

// ── 14. 귀속 커버리지 ────────────────────────────────────────────────────

describe("패스 귀속 커버리지 — 화면이 '기록 불완전'을 말할 수 있어야 한다", () => {
  it("귀속된 시도 / 전체 시도 — 픽스처는 5/6(잔차 1건 = H1 걷어내기가 나간 스로인)", () => {
    expect(passAttributionCoverage(computePlayerStats(FIXTURE, { gkKeys: GK_KEYS }))).toBeCloseTo(
      5 / 6,
      6,
    );
  });

  it("잔차가 하나도 없으면 정확히 1", () => {
    // 스로인 없는 조각만 잘라내면 전량 귀속된다.
    const noThrowIn: StatMatchLog = {
      tickSnapshots: (FIXTURE.tickSnapshots ?? []).filter((s) => s.tick <= 16),
      events: (FIXTURE.events ?? []).filter((e) => e.tick <= 16),
    };
    const r = computePlayerStats(noThrowIn, { gkKeys: GK_KEYS });
    expect(r.unattributed.passesAttempted).toBe(0);
    expect(passAttributionCoverage(r)).toBe(1);
    expect(r.players.reduce((a, p) => a + p.passesAttempted, 0)).toBeGreaterThan(0);
  });

  it("소유 체인이 끊기면 1 아래로 내려간다(지표가 실제로 움직인다)", () => {
    const sliceAt = (lo: number, hi: number): StatMatchLog => ({
      tickSnapshots: (FIXTURE.tickSnapshots ?? []).filter((s) => s.tick >= lo && s.tick <= hi),
      events: (FIXTURE.events ?? []).filter((e) => e.tick >= lo && e.tick <= hi),
    });
    const bad = combinePlayerStats([
      computePlayerStats(sliceAt(0, 24), { gkKeys: GK_KEYS }),
      computePlayerStats(sliceAt(25, LAST_TICK), { gkKeys: GK_KEYS }),
    ]);
    const good = passAttributionCoverage(computePlayerStats(FIXTURE, { gkKeys: GK_KEYS }))!;
    const worse = passAttributionCoverage(bad)!;
    expect(worse).toBeLessThan(good);
    expect(worse).toBeLessThan(1);
  });

  it("패스 시도가 없으면 null (0% 는 거짓말)", () => {
    expect(passAttributionCoverage(computePlayerStats({}))).toBeNull();
  });
});

// ── 15. 실경기 로그 (있을 때만 — 위 계약을 대체하지 않는 보강) ───────────

describe("실엔진 로그 대조 — `e2e/fixtures/p388-half1.json` (리포에 커밋됨, 항상 돈다)", () => {
  /**
   * ⚠️ **읽기 전용**이다. 이 파일은 `scripts/gen-p388-fixture.test.ts` 가 부작용으로 다시 쓰는
   * 문제가 별도 이슈(#414)로 올라가 있다 — 여기서 쓰거나 dirty 하게 만들지 마라.
   *
   * 이 로그를 쓰는 이유 둘:
   *  ① **실엔진 `clearance` 가 들어 있다**(showcase 데모 로그엔 0건이라 손 픽스처로만 검증됐었다).
   *  ② **스냅샷이 성기다**(600틱 / 194스냅 ≈ 3.1틱당 1개 — 서버가 트림한 로그의 모양).
   *     소유 체인이 끊기는 실제 조건이라 잔차가 0 이 아니다.
   */
  const p388 = new URL("../../e2e/fixtures/p388-half1.json", import.meta.url).pathname;
  const load = (): StatMatchLog => JSON.parse(readFileSync(p388, "utf8")) as StatMatchLog;

  it("픽스처가 실재한다(계약이 조용히 사라지지 않게)", () => {
    expect(existsSync(p388)).toBe(true);
    const log = load();
    expect((log.tickSnapshots ?? []).length).toBeGreaterThan(100);
    expect((log.events ?? []).length).toBeGreaterThan(50);
  });

  it("걷어내기가 실엔진 로그에서 **그 선수에게** 붙는다", () => {
    const log = load();
    const res = computePlayerStats(log, { gkKeys: playerKeySet([["home", "H0"], ["away", "A0"]]) });

    // 기대값을 로그에서 **독립적으로** 다시 센다(모듈 출력을 그대로 베끼지 않는다).
    const expected = new Map<string, number>();
    for (const e of log.events ?? []) {
      if (e.type !== "clearance" || !e.team || !e.playerId) continue;
      const k = `${e.team}:${e.playerId}`;
      expected.set(k, (expected.get(k) ?? 0) + 1);
    }
    const total = [...expected.values()].reduce((a, b) => a + b, 0);
    expect(total, "이 픽스처에 걷어내기가 없으면 계약이 공허하다").toBeGreaterThan(0);

    for (const [k, n] of expected) {
      const line = res.players.find((p) => p.key === k);
      expect(line, `${k} 가 없다`).toBeDefined();
      expect(line!.clearances, k).toBe(n);
    }
    expect(res.players.reduce((a, p) => a + p.clearances, 0)).toBe(total);
    // 걷어내기는 패스가 아니다 — 팀 패스 시도에 섞이면 성공률이 오염된다.
    const team = liveEventStats((log.events ?? []) as never[], Number.MAX_SAFE_INTEGER);
    expect(
      res.players.reduce((a, p) => a + p.passesAttempted, 0) + res.unattributed.passesAttempted,
    ).toBe(team.home.passAttempts + team.away.passAttempts);
  });

  it("성긴 스냅샷에서도 선수 합 + 잔차 = 팀 합", () => {
    const log = load();
    const res = computePlayerStats(log, { gkKeys: playerKeySet([["home", "H0"], ["away", "A0"]]) });
    const team = liveEventStats((log.events ?? []) as never[], Number.MAX_SAFE_INTEGER);
    for (const side of ["home", "away"] as const) {
      const t = team[side];
      expect(sumOf(res, side, (p) => p.goals)).toBe(t.goals);
      expect(sumOf(res, side, (p) => p.shots)).toBe(t.shots);
      expect(sumOf(res, side, (p) => p.shotsOnTarget)).toBe(t.onTarget);
      expect(sumOf(res, side, (p) => p.fouls)).toBe(t.fouls);
      expect(sumOf(res, side, (p) => p.yellowCards)).toBe(t.yellow);
      expect(sumOf(res, side, (p) => p.xg)).toBeCloseTo(t.xg, 9);
    }
    expect(
      res.players.reduce((a, p) => a + p.passesCompleted, 0) + res.unattributed.passesCompleted,
    ).toBe(team.home.passCompleted + team.away.passCompleted);
  });

  it("성긴 로그의 귀속 커버리지가 상한 아래로 떨어지지 않는다", () => {
    // 실측(engine@0.34.0 · 3.1틱당 스냅샷 1개): 95.8%. 여기가 무너지면 화면 숫자가 조용히
    // 낮아지므로 **바닥을 걸어 둔다** — 잔차만 늘리는 회귀(전량 잔차)를 이 줄이 잡는다.
    const res = computePlayerStats(load(), { gkKeys: playerKeySet([["home", "H0"], ["away", "A0"]]) });
    const cov = passAttributionCoverage(res);
    expect(cov).not.toBeNull();
    expect(cov!).toBeGreaterThan(0.9);
    // 앵커: 실제로 패스가 있었다(0/0 로 통과하지 않는다).
    expect(res.players.reduce((a, p) => a + p.passesAttempted, 0)).toBeGreaterThan(50);
  });
});

describe("실경기 로그 대조", () => {
  const logPath = new URL("../../../../packages/engine/dev-viewer/match-log.json", import.meta.url).pathname;

  it.skipIf(!existsSync(logPath))("데모 로그에서 선수 합 + 잔차가 팀 합과 정확히 같다", () => {
    const log = JSON.parse(readFileSync(logPath, "utf8")) as StatMatchLog;
    const res = computePlayerStats(log, { gkKeys: playerKeySet([["home", "H0"], ["away", "A0"]]) });
    const team = liveEventStats((log.events ?? []) as never[], Number.MAX_SAFE_INTEGER);

    for (const side of ["home", "away"] as const) {
      const t = team[side];
      expect(sumOf(res, side, (p) => p.goals)).toBe(t.goals);
      expect(sumOf(res, side, (p) => p.shots)).toBe(t.shots);
      expect(sumOf(res, side, (p) => p.shotsOnTarget)).toBe(t.onTarget);
      expect(sumOf(res, side, (p) => p.shotsOffTarget)).toBe(t.offTarget);
      expect(sumOf(res, side, (p) => p.saves)).toBe(t.saves);
      expect(sumOf(res, side, (p) => p.fouls)).toBe(t.fouls);
      expect(sumOf(res, side, (p) => p.yellowCards)).toBe(t.yellow);
      expect(sumOf(res, side, (p) => p.redCards)).toBe(t.red);
      expect(sumOf(res, side, (p) => p.offsides)).toBe(t.offsides);
      expect(sumOf(res, side, (p) => p.xg)).toBeCloseTo(t.xg, 9);
    }
    const uc = res.unattributed;
    expect(
      res.players.reduce((a, p) => a + p.passesCompleted, 0) + uc.passesCompleted,
    ).toBe(team.home.passCompleted + team.away.passCompleted);
    expect(
      res.players.reduce((a, p) => a + p.passesAttempted, 0) + uc.passesAttempted,
    ).toBe(team.home.passAttempts + team.away.passAttempts);

    // 촘촘한 로그(틱당 스냅샷 1개)는 잔차가 **0** 이어야 한다 — 성긴 로그의 4%는 스냅샷
    // 해상도 탓이지 알고리즘 탓이 아니라는 것을 이 줄이 증명한다.
    expect(passAttributionCoverage(res)).toBe(1);
    expect(uc.passesAttempted).toBe(0);
    expect(uc.passesCompleted).toBe(0);

    // 앵커 — 이 로그가 실제로 내용이 있다(공허한 0=0 통과 방지).
    expect(team.home.goals + team.away.goals).toBeGreaterThan(0);
    expect(res.players.length).toBeGreaterThanOrEqual(22);
  });
});
