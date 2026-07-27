import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOGGLES,
  halfForState,
  headerTick,
  isHalftimeState,
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

  it("하프 끝을 모르면(로그 미도착) 플레이헤드로 되돌아가지 않고 시계를 접는다", () => {
    // null 을 주면 ScoreBar 가 시계를 아예 안 그린다 = 틀린 분보다 없는 편이 낫다.
    expect(headerTick("HALFTIME", 0, null)).toBeNull();
    expect(headerTick("HALFTIME", 1200, null)).toBeNull();
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
