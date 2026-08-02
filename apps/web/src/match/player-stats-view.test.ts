/**
 * #403 W2 — 선수 기록 **표시 계층** 계약.
 *
 * 집계 자체는 W1(`player-stats.test.ts`, 88건)이 지킨다. 여기가 지키는 것은 그 줄들이 화면에
 * 어떻게 서느냐다 — 그리고 이 층에서 실제로 무너졌던 자리는 셋이다:
 *  ① **"홈 = 나"** (#322). 목·계약이 전부 유저=홈이라 3개월 살았던 부류.
 *  ② **없는 값을 0 으로 때우기** — 패스 시도 0 을 0% 로 그리면 "제일 못한 선수"가 된다.
 *  ③ **불완전한 귀속을 조용히 숨기기** — 성긴 로그에서 숫자만 보이면 그게 거짓말이 된다.
 */
import { describe, expect, it } from "vitest";
import {
  buildRosterMeta,
  coverageLabel,
  defaultSegment,
  gkKeysOf,
  currentHalfSettled,
  isMotmKey,
  passIncomplete,
  passPctLabel,
  positionsOf,
  ratingTier,
  rowsFor,
  sortRows,
  statsWindow,
  teamSegments,
  DEFAULT_SORT,
  type PlayerRow,
} from "./player-stats-view";
import { computePlayerStats, type StatMatchLog, type PlayerStatLine } from "./player-stats";

// ── 픽스처 ───────────────────────────────────────────────────────────────

const CATALOG = [
  { id: "P1", name: "오성민", position: "GK" },
  { id: "P2", name: "정태우", position: "DF" },
  { id: "P9", name: "김도현", position: "FW" },
];

/**
 * 스냅샷 2틱 · 양 팀 3명씩. **home 과 away 에 같은 `P9` 를 둔다** — 유저 덱과 봇 로스터가 같은
 * 카탈로그를 공유해 실제로 자주 일어나는 상태이고(#231), 맨 id 로 조회하는 구현이 여기서 죽는다.
 */
function makeLog(): StatMatchLog {
  const players = [
    { playerId: "P1", team: "home", pos: { x: 5, y: 34 } },
    { playerId: "P2", team: "home", pos: { x: 30, y: 20 } },
    { playerId: "P9", team: "home", pos: { x: 70, y: 34 } },
    { playerId: "P1", team: "away", pos: { x: 100, y: 34 } },
    { playerId: "P2", team: "away", pos: { x: 75, y: 40 } },
    { playerId: "P9", team: "away", pos: { x: 35, y: 34 } },
  ];
  return {
    tickSnapshots: [
      { tick: 0, minute: 0, ball: { x: 52, y: 34 }, ballOwner: "P9", players },
      { tick: 1, minute: 0, ball: { x: 53, y: 34 }, ballOwner: "P9", players },
    ],
    events: [],
  };
}

const line = (over: Partial<PlayerStatLine>): PlayerStatLine =>
  ({
    key: "home:X",
    team: "home",
    playerId: "X",
    goals: 0,
    shots: 0,
    shotsOnTarget: 0,
    shotsOffTarget: 0,
    xg: 0,
    tackles: 0,
    interceptions: 0,
    clearances: 0,
    fouls: 0,
    yellowCards: 0,
    redCards: 0,
    secondYellow: false,
    sentOff: false,
    offsides: 0,
    saves: 0,
    goalsConceded: 0,
    passesAttempted: 0,
    passesCompleted: 0,
    longPasses: 0,
    longPassesCompleted: 0,
    keyPasses: 0,
    assists: 0,
    touches: 0,
    carries: 0,
    carryDistanceM: 0,
    carryProgressM: 0,
    dispossessed: 0,
    distanceM: 0,
    ticksPlayed: 1,
    minutesPlayed: 1,
    heat: [],
    rating: 6,
    ...over,
  }) as PlayerStatLine;

const row = (over: Partial<PlayerRow> & { key: string }): PlayerRow => ({
  team: "home",
  playerId: over.key.split(":")[1] ?? "X",
  name: "선수",
  position: "MF",
  num: "5",
  isGk: false,
  line: line({ key: over.key }),
  passPct: null,
  defence: 0,
  ...over,
});

// ── 로스터 메타 ──────────────────────────────────────────────────────────

describe("buildRosterMeta — 이름·포지션·등번호", () => {
  it("키가 `(team, playerId)` 라 양 팀 동명 선수가 갈린다", () => {
    const meta = buildRosterMeta(makeLog(), CATALOG);
    expect(meta.has("home:P9")).toBe(true);
    expect(meta.has("away:P9")).toBe(true);
    expect(meta.get("home:P9")!.name).toBe("김도현");
    // 번호는 **팀별** 등장 순서 — 같은 선수라도 팀이 다르면 다른 번호를 단다(코어와 같은 규칙).
    expect(meta.get("home:P9")!.num).toBe("3");
    expect(meta.get("away:P9")!.num).toBe("3");
    expect(meta.get("away:P1")!.num).toBe("1");
  });

  /** `/api/players` 가 배열이 아닐 수 있다(구 서버·목의 200 `{}`) — 던지면 화면이 통째로 죽는다. */
  it("카탈로그가 없거나 배열이 아니어도 죽지 않는다 — 이름이 id 로 떨어질 뿐", () => {
    for (const bad of [undefined, null, {} as never]) {
      const meta = buildRosterMeta(makeLog(), bad as never);
      expect(meta.get("home:P9")!.name).toBe("P9");
      expect(meta.get("home:P9")!.position).toBeNull();
    }
  });

  it("로그가 없으면 빈 표 — 화면은 '기록 없음' 으로 성립한다", () => {
    expect(buildRosterMeta(null, CATALOG).size).toBe(0);
    expect(buildRosterMeta({}, CATALOG).size).toBe(0);
  });
});

describe("gkKeysOf / positionsOf — 집계 옵션 규약", () => {
  /**
   * ⚠️ `gkKeys` 는 **`playerKey` 형태**여야 한다(`player-stats.ts` 옵션 주석). 맨 id 를 넣으면
   * 같은 선수가 양 팀에 있을 때 `{"P1"}` 하나가 양쪽 P1 을 다 GK 로 만들어 실점이 두 번 붙는다.
   */
  it("GK 키는 팀이 붙은 형태다", () => {
    const keys = gkKeysOf(buildRosterMeta(makeLog(), CATALOG));
    expect([...keys].sort()).toEqual(["away:P1", "home:P1"]);
    expect(keys.has("P1")).toBe(false);
  });

  it("포지션 표도 같은 키 축이다", () => {
    const pos = positionsOf(buildRosterMeta(makeLog(), CATALOG));
    expect(pos["home:P9"]).toBe("FW");
    expect(pos["away:P2"]).toBe("DF");
    expect(pos["P9"]).toBeUndefined();
  });
});

// ── 행 ───────────────────────────────────────────────────────────────────

describe("rowsFor", () => {
  const result = computePlayerStats(makeLog(), {
    gkKeys: gkKeysOf(buildRosterMeta(makeLog(), CATALOG)),
  });
  const roster = buildRosterMeta(makeLog(), CATALOG);

  it("그 팀만, 그리고 뛴 선수만", () => {
    const rows = rowsFor(result, "away", roster);
    expect(rows.map((r) => r.playerId).sort()).toEqual(["P1", "P2", "P9"]);
    expect(rows.every((r) => r.team === "away")).toBe(true);
  });

  it("이름·포지션·번호가 붙는다", () => {
    const r = rowsFor(result, "home", roster).find((x) => x.playerId === "P9")!;
    expect(r.name).toBe("김도현");
    expect(r.position).toBe("FW");
    expect(r.num).toBe("3");
    expect(r.isGk).toBe(false);
  });

  /**
   * **`수비` 열은 GK 에서 선방을 뜻한다**(목업 ①). 필드 공식(태클+가로챔+걷어내기)을 GK 에도
   * 그대로 쓰면 선방 5개를 한 키퍼가 `0` 으로 뜬다 — 그 화면은 "아무것도 안 한 키퍼"가 된다.
   */
  it("GK 의 수비 열 = 선방, 필드 = 태클+가로챔+걷어내기", () => {
    const gk = { ...result.players.find((p) => p.key === "home:P1")!, saves: 5, tackles: 1 };
    const fp = { ...result.players.find((p) => p.key === "home:P9")!, tackles: 2, interceptions: 3, clearances: 1 };
    const custom = { ...result, players: [gk, fp] };
    const rows = rowsFor(custom, "home", roster);
    expect(rows.find((r) => r.playerId === "P1")!.defence).toBe(5);
    expect(rows.find((r) => r.playerId === "P9")!.defence).toBe(6);
  });
});

// ── 정렬 ─────────────────────────────────────────────────────────────────

describe("sortRows", () => {
  const rows: PlayerRow[] = [
    row({ key: "home:A", name: "A", num: "3", line: line({ key: "home:A", rating: 6.4, goals: 0, shots: 1 }), passPct: 90, defence: 1 }),
    row({ key: "home:B", name: "B", num: "1", line: line({ key: "home:B", rating: 7.8, goals: 1, shots: 3 }), passPct: 72, defence: 0 }),
    row({ key: "home:C", name: "C", num: "2", line: line({ key: "home:C", rating: 7.0, goals: 0, shots: 0 }), passPct: null, defence: 6 }),
    row({ key: "home:D", name: "D", num: "4", line: line({ key: "home:D", rating: 7.0, goals: 0, shots: 0 }), passPct: 0, defence: 6 }),
  ];

  it("평점·골·슈팅·수비는 내림차순(잘한 순)", () => {
    expect(sortRows(rows, "rating").map((r) => r.name)).toEqual(["B", "C", "D", "A"]);
    expect(sortRows(rows, "goals")[0]!.name).toBe("B");
    expect(sortRows(rows, "shots")[0]!.name).toBe("B");
    expect(sortRows(rows, "defence").slice(0, 2).map((r) => r.name).sort()).toEqual(["C", "D"]);
  });

  it("번호만 오름차순 — 라인업 순으로 읽는 자리다", () => {
    expect(sortRows(rows, "num").map((r) => r.num)).toEqual(["1", "2", "3", "4"]);
  });

  /**
   * ⚠️ **시도 0(null)을 0% 로 취급하면 안 된다.** 아직 한 번도 안 찬 선수가 실제로 0% 를 기록한
   * 선수보다 뒤로 가야 한다 — 그 둘은 다른 사실이고, 표는 `—` 로 이미 구분해 그리고 있다.
   */
  it("패스% 의 null(시도 0)은 실제 0% 보다 **뒤**다", () => {
    const sorted = sortRows(rows, "passPct").map((r) => r.name);
    expect(sorted).toEqual(["A", "B", "D", "C"]);
    expect(sorted.indexOf("D")).toBeLessThan(sorted.indexOf("C"));
  });

  it("동점은 평점 → 번호 → 키로 끝까지 끊는다(순서가 흔들리지 않는다)", () => {
    const a = sortRows(rows, "defence").map((r) => r.key);
    const b = sortRows([...rows].reverse(), "defence").map((r) => r.key);
    expect(a).toEqual(b);
    expect(a.slice(0, 2)).toEqual(["home:C", "home:D"]); // 평점 동점 → 번호 2 < 4
  });
});

// ── 표시 파생 ────────────────────────────────────────────────────────────

describe("표시 파생", () => {
  it("평점 등급", () => {
    expect(ratingTier(7.8, false)).toBe("hi");
    expect(ratingTier(7.0, false)).toBe("mid");
    expect(ratingTier(6.4, false)).toBe("low");
    expect(ratingTier(6.4, true)).toBe("motm"); // MOTM 은 값이 아니라 신분이다
  });

  it("패스% 는 시도 0 이면 `—` — 0% 로 때우지 않는다", () => {
    expect(passPctLabel(null)).toBe("—");
    expect(passPctLabel(0)).toBe("0%");
    expect(passPctLabel(72.4)).toBe("72%");
  });

  /**
   * 성긴 로그(서버 트림·구 매치)에서는 소유 체인이 끊겨 패스 시도의 일부가 아무에게도 안 붙는다.
   * 그 상태에서 숫자만 보이면 "이 선수는 그만큼밖에 안 찼다"는 거짓이 된다 — **말한다**.
   */
  it("귀속이 1 미만이면 불완전이라고 말한다 / 모르면 말하지 않는다", () => {
    expect(passIncomplete(1)).toBe(false);
    expect(passIncomplete(0.82)).toBe(true);
    expect(passIncomplete(null)).toBe(false); // 시도 0 = 아직 아무 일도 안 일어났다
    expect(coverageLabel(0.826)).toBe("패스 귀속 82%");
    expect(coverageLabel(1)).toBeNull();
  });

  /**
   * ⚠️ **정렬 기본값은 평점이다**(목업 ① — 평점 칩이 눌린 채로 그려져 있다). 독립검증 m2:
   * `"goals"` 로 바꾸는 변이가 유닛 91 + e2e 14 를 전부 통과했다 = 어디에도 안 박혀 있었다.
   * 기대값은 **리터럴**이다(앱 상수를 계산해 비교하면 변이가 같이 따라온다 — CLAUDE.md 함정 2).
   */
  it("정렬 기본값은 평점 — 표의 첫 질문은 '누가 잘했나'다", () => {
    expect(DEFAULT_SORT).toBe("rating");
  });

  it("MOTM 판정은 키로 한다(맨 id 아님)", () => {
    const res = { motm: { key: "away:P9", team: "away" as const, playerId: "P9", rating: 8 } } as never;
    expect(isMotmKey(res, "away:P9")).toBe(true);
    expect(isMotmKey(res, "home:P9")).toBe(false);
  });
});

// ── 팀 세그먼트 (#322 — 이 층에서 제일 잘 무너지는 자리) ────────────────

describe("teamSegments / defaultSegment — **홈은 내가 아니다**(#322)", () => {
  const NAMES = { home: "Thunder Bay United", away: "축구왕여르" };

  /**
   * ⚠️ **어웨이 라운드 표본이 계약의 절반이다.** 기존 web 목·계약이 전부 유저=홈이라 이 부류가
   * 3개월 살았다. 여기서는 **유저가 away** 인 표본을 태운다 — `homeName = ownerName` 으로
   * 되돌린 구현은 이 두 단언에서 죽는다.
   */
  it("유저가 어웨이여도 **순서는 홈 먼저** — 표식으로 말한다", () => {
    const segs = teamSegments(NAMES, "away");
    expect(segs.map((s) => s.side)).toEqual(["home", "away"]);
    expect(segs.map((s) => s.label)).toEqual(["Thunder Bay United", "축구왕여르"]);
    expect(segs.map((s) => s.mine)).toEqual([false, true]);
  });

  it("유저가 홈이면 표식이 홈에 붙는다", () => {
    expect(teamSegments(NAMES, "home").map((s) => s.mine)).toEqual([true, false]);
  });

  it("어느 쪽도 내 팀이 아니면(관전) 표식이 없다 — 거짓 표식을 달지 않는다", () => {
    expect(teamSegments(NAMES, null).every((s) => !s.mine)).toBe(true);
  });

  /** 순서를 안 바꾸는 대신 **선택**으로 답한다 — 처음 열면 내 선수단이 보인다. */
  it("기본 선택 = 내 팀(모르면 홈)", () => {
    expect(defaultSegment("away")).toBe("away");
    expect(defaultSegment("home")).toBe("home");
    expect(defaultSegment(null)).toBe("home");
  });
});


// ── 집계 창 — 상한과 캡션의 단일 출처 (BL-1) ───────────────────────────────

describe("statsWindow — 상한과 캡션은 **한 곳**에서 나온다(BL-1)", () => {
  /**
   * ⚠️ 이것이 blocker 의 실체였다. 상한은 훅이 `state === "FINISHED"` 로, 캡션은 화면이
   * `headerMinute` 로 각각 만들었다 → 감독시간에는 무대가 `경기장면` 탭으로 내려가(#244)
   * `MatchViewer` 가 마운트되지 않아 `tick === null` → 상한 `0` → **전 선수 0** 인데 캡션은
   * 하프 끝 분을 받아 **"7분까지의 기록"** 이라고 말했다. 헤더가 `0 : 1` 인 같은 화면에서.
   */
  it("감독시간의 전반은 **확정** — 상한도 캡션도 없다", () => {
    for (const state of ["HALFTIME", "H1_BREAK"]) {
      const w = statsWindow(state, null, 7);
      expect(w.kind, state).toBe("settled");
      expect(w.uptoTick, `${state}: 확정 하프를 재생 위치로 자르면 전 선수 0 이 된다`).toBeNull();
      expect(w.caption, `${state}: 상한이 없는데 "N분까지"라고 말하면 거짓말이다`).toBeNull();
      expect(w.shortLabel).toBeNull();
    }
  });

  it("후반 진행 중에도 전반은 확정이다 — 상한은 후반에만 걸린다", () => {
    // 지금 보는 하프(후반)는 라이브 → 상한 있음. 전반은 훅이 따로 전량으로 센다.
    expect(statsWindow("SECOND_HALF", 1400, 23).uptoTick).toBe(1400);
    expect(currentHalfSettled("SECOND_HALF")).toBe(false);
    expect(currentHalfSettled("HALFTIME")).toBe(true);
    expect(currentHalfSettled("H1_BREAK")).toBe(true);
    expect(currentHalfSettled("GEN2")).toBe(true);
    expect(currentHalfSettled("FIRST_HALF")).toBe(false);
    expect(currentHalfSettled("FINISHED")).toBe(true);
  });

  it("종료 = 전 경기 전량, 캡션 없음(요구 C · 목업 ③)", () => {
    const w = statsWindow("FINISHED", 500, 90);
    expect(w.kind).toBe("settled");
    expect(w.uptoTick).toBeNull();
    expect(w.caption).toBeNull();
  });

  it("진행 중이면 플레이헤드가 상한이고 캡션이 그 분을 말한다", () => {
    const w = statsWindow("FIRST_HALF", 900, 15);
    expect(w).toEqual({
      kind: "live",
      uptoTick: 900,
      caption: "15분까지의 기록",
      shortLabel: "15분까지",
    });
  });

  /**
   * "아직 모른다"와 "0틱까지"는 다른 사실이다. **0 을 데이터로 그리지 않고, 앞을 열지도 않는다** —
   * 진행 중 하프에 상한이 없으면 그건 곧 스포일러다(#233/#238).
   */
  it("진행 중인데 재생 위치를 모르면 `pending` — 0 도 아니고 무제한도 아니다", () => {
    const w = statsWindow("FIRST_HALF", null, null);
    expect(w.kind).toBe("pending");
    expect(w.uptoTick, "0 이면 '0틱까지'가 데이터로 그려진다").toBe(-1);
    expect(w.uptoTick, "null 이면 라이브 하프 전량 = 스포일러").not.toBeNull();
    expect(w.caption).toBe("전반 재생 위치를 기다리는 중");
    // 어느 하프를 기다리는지 말한다 — 후반 대기에서 "전반 기록도 없다"로 읽히지 않게(A-4).
    expect(statsWindow("SECOND_HALF", null, null).caption).toBe("후반 재생 위치를 기다리는 중");
  });

  /**
   * **캡션과 상한은 갈라질 수 없다** — 이것이 BL-1 이 재발하지 않는다는 뜻이다.
   * 분을 말하는 창은 반드시 상한이 있고, 상한이 없는 창은 분을 말하지 않는다.
   */
  it("분을 말하면 상한이 있고, 상한이 없으면 분을 말하지 않는다", () => {
    const cases: [string, number | null, number | null][] = [
      ["FIRST_HALF", 900, 15],
      ["FIRST_HALF", null, 15],
      ["HALFTIME", null, 7],
      ["H1_BREAK", 0, 45],
      ["SECOND_HALF", 1400, 23],
      ["SECOND_HALF", null, null],
      ["FINISHED", 2000, 90],
      ["GEN2", null, 45],
    ];
    for (const [state, tick, minute] of cases) {
      const w = statsWindow(state, tick, minute);
      const saysMinute = w.caption != null && /\d+분까지/.test(w.caption);
      expect(saysMinute, `${state}/${tick}: 분을 말하는데 상한이 없다`).toBe(
        saysMinute && w.uptoTick != null,
      );
      if (w.uptoTick == null) {
        expect(w.caption, `${state}: 상한이 없는 창이 캡션을 달았다`).toBeNull();
      }
    }
  });
});
