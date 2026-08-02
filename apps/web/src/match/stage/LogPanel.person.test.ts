/**
 * #406 요구 5-4 — 로그줄의 **사람 조각**(hero 확정 ④ = 이름 + 등번호).
 *
 * <p>조인점은 `logLinePerson` 한 곳이다. 이 계약이 지키는 것:
 * <ol>
 *   <li>표기 형식 = `짧은이름(등번호)` — 이름 축이 <b>짧은 쪽</b>이다(390px 밀집 UI).</li>
 *   <li>카탈로그 우선 — 로그 이벤트는 playerId 만 실어 오므로 이름 SoT 는 카탈로그다.</li>
 *   <li>폴백 — 이름 없으면 `#7`(현행 유지), 사람 없는 줄(휘슬)엔 조각 자체가 없다.</li>
 *   <li><b>`P077` 이 화면에 안 나온다</b>(#334 가 등번호에서 겪은 사고의 이름 축).</li>
 * </ol>
 */
import { describe, expect, it } from "vitest";
import { buildPlayerNames } from "../../common/player-names";
import { logLineNumber, logLinePerson } from "./LogPanel";

/** 실경기 id 표본으로 쓴다 — 픽스처 id(`H9`)는 접두사 전제를 우연히 통과시킨다(#334 교훈). */
const CATALOG = [
  { id: "P077", name: "손흥민", shortName: "손흥민" },
  { id: "P061", name: "오렐리앵 추아메니", shortName: "추아메니" },
];
const names = buildPlayerNames(CATALOG);
const NUMS = { "home:P077": "7", "away:P061": "6", "home:P900": "4" };

describe("logLinePerson — 이름 + 등번호", () => {
  it("짧은 이름과 등번호를 한 조각으로 붙인다", () => {
    expect(logLinePerson(names, NUMS, { playerId: "P077", team: "home" })).toBe("손흥민(7)");
  });

  /**
   * ★ 축 계약 — 풀네임이 8자인 선수에서 <b>짧은 축을 쓰는지</b>가 드러난다.
   * 풀네임을 쓰면 `오렐리앵 추아메니(6)` = 12자라 390px 로그줄에서 라벨이 먹힌다.
   */
  it("풀네임이 아니라 짧은 이름을 쓴다", () => {
    expect(logLinePerson(names, NUMS, { playerId: "P061", team: "away" })).toBe("추아메니(6)");
    expect(logLinePerson(names, NUMS, { playerId: "P061", team: "away" })).not.toContain("오렐리앵");
  });

  it("등번호를 모르면 이름만", () => {
    expect(logLinePerson(names, {}, { playerId: "P077", team: "home" })).toBe("손흥민");
  });

  /** 카탈로그가 모르는 선수 — 현행 동작(등번호)이 살아 있어야 한다. 구 매치·봇 로스터 경로. */
  it("이름을 모르면 등번호로 떨어진다 (#334 현행 유지)", () => {
    expect(logLinePerson(names, NUMS, { playerId: "P900", team: "home" })).toBe("#4");
  });

  it("★ 이름도 번호도 없으면 **id 가 아니라** 조각을 뺀다", () => {
    const out = logLinePerson(names, {}, { playerId: "P900", team: "home" });
    expect(out).toBeUndefined();
    expect(out ?? "").not.toContain("P900");
    // `미상 선수` 도 붙이지 않는다 — 주체가 없는 줄에 사람을 만들어 내는 것이 된다.
    expect(out ?? "").not.toContain("미상");
  });

  it("사람이 없는 줄(휘슬·킥오프)엔 조각이 없다", () => {
    expect(logLinePerson(names, NUMS, {})).toBeUndefined();
  });

  /** 같은 playerId 가 양 팀에 있을 수 있다(#324) — 번호는 팀별, 이름은 같은 사람이라 공통. */
  it("양 팀에 같은 선수가 뛰어도 팀별 번호가 붙는다", () => {
    const nums = { "home:P077": "7", "away:P077": "11" };
    expect(logLinePerson(names, nums, { playerId: "P077", team: "home" })).toBe("손흥민(7)");
    expect(logLinePerson(names, nums, { playerId: "P077", team: "away" })).toBe("손흥민(11)");
  });

  it("조인은 한 곳이다 — 번호 조회는 여전히 `logLineNumber` 규약(#334)을 탄다", () => {
    // team 이 없는 로그는 단독 키 폴백. 사람 조각도 같은 규약 위에 얹혀야 한다.
    const nums = { P077: "9" };
    expect(logLineNumber(nums, { playerId: "P077" })).toBe("9");
    expect(logLinePerson(names, nums, { playerId: "P077" })).toBe("손흥민(9)");
  });

  it("카탈로그가 비어 있어도(로딩 중) 줄이 깨지지 않는다", () => {
    const empty = buildPlayerNames(null);
    expect(logLinePerson(empty, NUMS, { playerId: "P077", team: "home" })).toBe("#7");
  });
});
