import { describe, expect, it } from "vitest";
import {
  DEFAULT_TOGGLES,
  halfForState,
  parseToggles,
  resolveActiveTab,
  serializeToggles,
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
  it("H1_BREAK=감독, FINISHED=결과, 그 외 없음", () => {
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

  it("활성 탭: 고른 탭이 살아 있으면 유지, 사라지면 첫 탭(상태 패널 우선)", () => {
    const tabs: TabKey[] = ["halftime", "stats", "log"];
    expect(resolveActiveTab(tabs, "log")).toBe("log");
    expect(resolveActiveTab(tabs, null)).toBe("halftime");
    expect(resolveActiveTab(tabs, "brief")).toBe("halftime");
    expect(resolveActiveTab([], "stats")).toBeNull();
  });

});
