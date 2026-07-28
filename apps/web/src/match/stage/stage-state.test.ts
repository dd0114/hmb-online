import { describe, expect, it } from "vitest";
import {
  CLOCK_PLACEHOLDER,
  clockLabel,
  DEFAULT_TOGGLES,
  halfEndTickOf,
  halfForState,
  headerScore,
  headerTick,
  isHalftimeState,
  playedBaseline,
  parseToggles,
  resolveActiveTab,
  serializeToggles,
  sheetHeight,
  statePanelFor,
  tabsFor,
  type TabKey,
} from "./stage-state";

describe("toggles 저장/복원", () => {
  it("기본은 전부 off(경기장면만)", () => {
    expect(DEFAULT_TOGGLES).toEqual({ stats: false, log: false, brief: false });
    expect(parseToggles(null)).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("")).toEqual(DEFAULT_TOGGLES);
  });

  it("왕복(serialize→parse)이 값을 보존한다", () => {
    const t = { stats: true, log: false, brief: true };
    expect(parseToggles(serializeToggles(t))).toEqual(t);
  });

  it("손상/구버전 저장값은 기본값으로 흡수한다", () => {
    expect(parseToggles("{oops")).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles("[1,2]")).toEqual(DEFAULT_TOGGLES);
    expect(parseToggles('"stats"')).toEqual(DEFAULT_TOGGLES);
    // 부분 저장 = 있는 것만 반영, 나머지는 기본값
    expect(parseToggles('{"log":true,"junk":1}')).toEqual({ stats: false, log: true, brief: false });
    // 타입이 틀린 값은 무시
    expect(parseToggles('{"stats":"yes"}')).toEqual(DEFAULT_TOGGLES);
  });
});

describe("상태 패널 / 하프", () => {
  it("감독시간=감독, FINISHED=결과, 그 외 없음", () => {
    // 현행 상태명과 레거시 이름을 **둘 다** 통과시켜야 한다(#226 — 한쪽만 보면 배포본이 규칙 밖에 남는다).
    expect(statePanelFor("HALFTIME")).toBe("halftime");
    expect(statePanelFor("H1_BREAK")).toBe("halftime");
    expect(statePanelFor("FINISHED")).toBe("result");
    expect(statePanelFor("BRIEFING")).toBeNull();
    expect(statePanelFor(undefined)).toBeNull();
  });

  it("FINISHED 는 후반, 그 외는 전반을 재생한다", () => {
    expect(halfForState("FINISHED")).toBe(2);
    expect(halfForState("H1_BREAK")).toBe(1);
  });
});

describe("감독시간 판정 / 헤더 시계 (#226)", () => {
  it("현행 HALFTIME 과 레거시 H1_BREAK 둘 다 감독시간이다", () => {
    expect(isHalftimeState("HALFTIME")).toBe(true);
    expect(isHalftimeState("H1_BREAK")).toBe(true);
    for (const s of ["FIRST_HALF", "SECOND_HALF", "FINISHED", "BRIEFING", undefined]) {
      expect(isHalftimeState(s)).toBe(false);
    }
  });

  it("감독시간 헤더 시계는 재생 플레이헤드가 아니라 하프 끝을 가리킨다", () => {
    // 되감아 플레이헤드가 0 이어도 헤더는 하프 끝 — hero 제보(0')의 재현 조건이 바로 이것.
    expect(headerTick("HALFTIME", 0, 2699)).toBe(2699);
    expect(headerTick("H1_BREAK", 1200, 2699)).toBe(2699);
  });

  it("라이브 하프는 그대로 플레이헤드를 따라간다", () => {
    expect(headerTick("FIRST_HALF", 1200, 2699)).toBe(1200);
    expect(headerTick("SECOND_HALF", 3900, 5399)).toBe(3900);
    expect(headerTick("FINISHED", 5399, 5399)).toBe(5399);
  });

  it("하프 끝은 로그 마지막 스냅샷 틱에서 파생된다 — 웹에 45분 상수를 두지 않는다", () => {
    // 리얼 전반: 엔진 totalTicks 5400 → half 2700 → 스냅샷 틱 0..2699.
    expect(halfEndTickOf({ tickSnapshots: [{ tick: 0 }, { tick: 2699 }] })).toBe(2699);
    // 후반 로그는 틱이 2700 부터 이어진다(인덱스 ≠ 틱).
    expect(halfEndTickOf({ tickSnapshots: [{ tick: 2700 }, { tick: 5399 }] })).toBe(5399);
  });

  it("로그가 없거나 모양이 깨졌으면 하프 끝은 null(숫자를 지어내지 않는다)", () => {
    for (const bad of [null, undefined, {}, { tickSnapshots: [] }, { tickSnapshots: [{}] }, { tickSnapshots: "x" }]) {
      expect(halfEndTickOf(bad)).toBeNull();
    }
  });

  it("하프 끝을 모르면(로그 미도착) 플레이헤드로 되돌아가지 않고 시계를 접는다", () => {
    // null 을 주면 ScoreBar 가 시계를 아예 안 그린다 = 틀린 분보다 없는 편이 낫다.
    expect(headerTick("HALFTIME", 0, null)).toBeNull();
    expect(headerTick("HALFTIME", 1200, null)).toBeNull();
  });
});

describe("경기 분 표기 — 상시 표시 (#233 스코프 추가)", () => {
  it("라이브/다시보기는 재생 위치의 게임 분(내림)", () => {
    expect(clockLabel("FIRST_HALF", 0)).toBe("0'");
    expect(clockLabel("FIRST_HALF", 1290)).toBe("21'"); // 21분 30초는 아직 21'
    expect(clockLabel("SECOND_HALF", 2700)).toBe("45'");
    expect(clockLabel("SECOND_HALF", 3900)).toBe("65'");
    expect(clockLabel("FINISHED", 5399)).toBe("89'");
  });

  it("플레이헤드가 아직 없으면 슬롯을 지운다 — 값만 비운다", () => {
    // 요소가 사라졌다 나타나면 헤더가 흔들린다. "경기 시간이 안 보인다"의 절반이 이거였다.
    expect(clockLabel("SECOND_HALF", null)).toBe(CLOCK_PLACEHOLDER);
    expect(clockLabel("FIRST_HALF", null)).toBe(CLOCK_PLACEHOLDER);
  });

  it("감독시간은 하프 끝을 반올림, 모르면 접는다(#226 유지)", () => {
    expect(clockLabel("HALFTIME", 2699)).toBe("45'"); // 44.98분 — 내리면 44'
    expect(clockLabel("H1_BREAK", 2699)).toBe("45'");
    expect(clockLabel("HALFTIME", null)).toBeNull();
  });
});

describe("이미 끝난 하프의 확정 스코어 = 베이스라인 (#233)", () => {
  const h1 = { scoreH1Home: 1, scoreH1Away: 4, scoreHome: null, scoreAway: null };

  it("후반을 재생하는 상태는 전반 확정 스코어가 베이스라인", () => {
    // halfForState 가 2 를 주는 상태 전부 — 후반 로그의 골은 전반 위에 쌓인다.
    expect(playedBaseline("SECOND_HALF", h1)).toEqual({ home: 1, away: 4 });
    expect(playedBaseline("FINISHED", h1)).toEqual({ home: 1, away: 4 });
  });

  it("전반을 재생하는 상태는 베이스라인이 0 — 앞에 끝난 하프가 없다", () => {
    expect(playedBaseline("FIRST_HALF", { scoreH1Home: null, scoreH1Away: null })).toEqual({ home: 0, away: 0 });
    expect(playedBaseline("HALFTIME", h1)).toEqual({ home: 0, away: 0 });
  });

  it("후반인데 전반 확정값이 없으면 null — 0 으로 단정하지 않는다", () => {
    // 0 으로 때우면 배포본이 지금 보이는 그 틀린 값(후반만의 점수)이 그대로 나온다.
    expect(playedBaseline("SECOND_HALF", { scoreH1Home: null, scoreH1Away: null })).toBeNull();
    expect(playedBaseline("SECOND_HALF", { scoreH1Home: 1, scoreH1Away: null })).toBeNull();
  });
});

describe("헤더 스코어 — 확정(서버) + 진행 중 하프 델타(재생) (#233)", () => {
  it("후반 진행 중 = 전반 확정 + 후반 재생 델타", () => {
    const scores = { scoreH1Home: 1, scoreH1Away: 4 };
    // 후반 킥오프(아직 0골) 에도 전반 스코어가 살아 있어야 한다 — 배포본은 여기서 0:0 이었다.
    expect(headerScore("SECOND_HALF", scores, { home: 0, away: 0 })).toEqual({ home: 1, away: 4 });
    // 후반 2골(away) 뒤.
    expect(headerScore("SECOND_HALF", scores, { home: 0, away: 2 })).toEqual({ home: 1, away: 6 });
  });

  it("후반 재생 델타가 아직 없으면(로그 미도착) 전반 확정값만 보인다", () => {
    expect(headerScore("SECOND_HALF", { scoreH1Home: 1, scoreH1Away: 4 }, null)).toEqual({ home: 1, away: 4 });
  });

  it("후반인데 전반 확정값이 없으면 '-' — 틀린 숫자보다 없는 편이 낫다", () => {
    expect(headerScore("SECOND_HALF", {}, { home: 0, away: 2 })).toEqual({ home: "-", away: "-" });
  });

  it("전반 진행 중은 재생 델타 그대로(무회귀)", () => {
    expect(headerScore("FIRST_HALF", {}, { home: 1, away: 0 })).toEqual({ home: 1, away: 0 });
    expect(headerScore("FIRST_HALF", {}, null)).toEqual({ home: 0, away: 0 });
  });

  it("감독시간은 전반 확정, 종료는 최종 확정 — 재생 델타를 따라가지 않는다(#226)", () => {
    const rewound = { home: 0, away: 0 };
    expect(headerScore("HALFTIME", { scoreH1Home: 0, scoreH1Away: 4 }, rewound)).toEqual({ home: 0, away: 4 });
    expect(headerScore("H1_BREAK", { scoreH1Home: 2, scoreH1Away: 1 }, rewound)).toEqual({ home: 2, away: 1 });
    expect(headerScore("FINISHED", { scoreHome: 3, scoreAway: 2 }, rewound)).toEqual({ home: 3, away: 2 });
  });

  /**
   * 이 픽스의 **설계 근거 자체**를 박제한다(독립검증 minor-2). 검증자가 `state==="FINISHED"` 앞에
   * "`scoreHome` 이 있으면 무조건 그린다"를 끼웠는데 전 게이트가 green 이었다 — 진행 중 상태에
   * `scoreHome` 을 먹이는 테스트가 하나도 없었기 때문이다. 서버가 언젠가 `score_*` 를 조기에 채우면
   * (운영·마이그레이션) 화면이 즉시 결과를 뱉는데 아무도 못 잡는다.
   */
  it("후반 진행 중에는 최종 스코어가 와 있어도 무시한다 — 재생 위치보다 앞선 점수 금지", () => {
    const leaked = { scoreH1Home: 1, scoreH1Away: 4, scoreHome: 2, scoreAway: 8 };
    expect(headerScore("SECOND_HALF", leaked, { home: 0, away: 2 })).toEqual({ home: 1, away: 6 });
    expect(headerScore("FIRST_HALF", leaked, { home: 0, away: 1 })).toEqual({ home: 0, away: 1 });
    // 감독시간도 마찬가지 — 그 화면이 말할 것은 전반 결과지 경기 결과가 아니다.
    expect(headerScore("HALFTIME", leaked, { home: 0, away: 0 })).toEqual({ home: 1, away: 4 });
  });

  it("확정 상태인데 서버 값이 비어 있으면 '-'", () => {
    expect(headerScore("HALFTIME", {}, { home: 3, away: 3 })).toEqual({ home: "-", away: "-" });
    expect(headerScore("FINISHED", {}, { home: 3, away: 3 })).toEqual({ home: "-", away: "-" });
  });
});

describe("탭 구성", () => {
  it("토글이 전부 off 이고 상태 패널도 없으면 시트가 없다", () => {
    expect(tabsFor(DEFAULT_TOGGLES, null)).toEqual([]);
  });

  it("상태 패널이 먼저, 켜진 토글이 고정 순서로 뒤따른다", () => {
    expect(tabsFor({ stats: true, log: true, brief: true }, "halftime")).toEqual([
      "halftime",
      "stats",
      "log",
      "brief",
    ]);
    expect(tabsFor({ stats: false, log: true, brief: false }, null)).toEqual(["log"]);
  });

  it("토글은 서로 독립 — 하나를 꺼도 나머지 탭은 남는다", () => {
    const before = tabsFor({ stats: true, log: true, brief: false }, null);
    const after = tabsFor({ stats: false, log: true, brief: false }, null);
    expect(before).toEqual(["stats", "log"]);
    expect(after).toEqual(["log"]);
  });

  it("시트 높이 등급은 탭 종류로만 갈린다(콘텐츠 무관 — 내용이 쌓여도 무대가 안 줄어든다)", () => {
    expect(sheetHeight(null)).toBeNull();
    expect(sheetHeight("stats")).toBe("info");
    expect(sheetHeight("log")).toBe("info");
    expect(sheetHeight("brief")).toBe("info");
    expect(sheetHeight("halftime")).toBe("state");
    expect(sheetHeight("result")).toBe("state");
  });

  it("활성 탭: 고른 탭이 살아 있으면 유지, 사라지면 첫 탭(상태 패널 우선)", () => {
    const tabs: TabKey[] = ["halftime", "stats", "log"];
    expect(resolveActiveTab(tabs, "log")).toBe("log");
    expect(resolveActiveTab(tabs, null)).toBe("halftime");
    expect(resolveActiveTab(tabs, "brief")).toBe("halftime");
    expect(resolveActiveTab([], "stats")).toBeNull();
  });

});
