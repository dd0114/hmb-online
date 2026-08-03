/**
 * #421 W2 — 하프 리포트(골·카드 타임라인) 데이터 계약.
 *
 * 이 파일이 지키는 것 셋:
 *  ① 리포트에 **골·카드만** 들어간다(흐름 노이즈가 섞이면 "읽을 거리"가 아니게 된다).
 *  ② **경고 누적 퇴장이 두 줄이 되지 않는다** — 엔진이 같은 틱에 옐로+레드를 둘 다 낸다.
 *  ③ **같은 playerId 가 양 팀에 있어도 두 사건이 뭉개지지 않는다**(#231/#324).
 */
import { describe, expect, it, vi } from "vitest";
import { buildHalfReportRows, halfReportScore, type HalfReportEventLike } from "./half-report";

const ev = (e: Partial<HalfReportEventLike> & { tick: number; type: string }): HalfReportEventLike => ({
  minute: Math.floor(e.tick / 30),
  ...e,
}) as HalfReportEventLike;

describe("buildHalfReportRows — 무엇이 실리나", () => {
  it("골·카드만 싣는다(패스·태클·슛·코너는 통계 탭 몫)", () => {
    const rows = buildHalfReportRows([
      ev({ tick: 10, type: "pass", team: "home" }),
      ev({ tick: 20, type: "shot", team: "home", playerId: "P1" }),
      ev({ tick: 30, type: "goal", team: "home", playerId: "P1" }),
      ev({ tick: 40, type: "tackle", team: "away" }),
      ev({ tick: 50, type: "card", detail: "yellow", team: "away", playerId: "P9" }),
      ev({ tick: 60, type: "kickoff", detail: "corner", team: "home" }),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["goal", "yellow"]);
  });

  it("빈 입력·손상 입력에서도 던지지 않는다(리포트가 화면을 죽이면 안 된다)", () => {
    expect(buildHalfReportRows([])).toEqual([]);
    expect(buildHalfReportRows(null)).toEqual([]);
    expect(buildHalfReportRows(undefined)).toEqual([]);
    expect(
      buildHalfReportRows([{ tick: Number.NaN, minute: 3, type: "goal", team: "home" } as HalfReportEventLike]),
    ).toEqual([]);
  });

  it("시각은 **로그가 구운 minute** 이다 — 틱을 분으로 직독하지 않는다(#388)", () => {
    // 엔진은 45분(1350틱)을 돌리고 표기만 0~90' 로 스케일한다 → tick/60 은 정확히 절반이 나온다.
    const [row] = buildHalfReportRows([ev({ tick: 1200, minute: 40, type: "goal", team: "home" })]);
    expect(row?.clock).toBe("40'");
    expect(row?.clock).not.toBe("20'"); // 틱 직독이 냈을 값
  });

  it("minute 이 없는 로그(구 서버)에서만 틱 폴백으로 내려간다", () => {
    const [row] = buildHalfReportRows([
      { tick: 125, type: "goal", team: "home" } as unknown as HalfReportEventLike,
    ]);
    expect(row?.clock).toBe("2'05\"");
  });

  it("아이콘·라벨은 `eventDisplay` 를 그대로 쓴다(로그 패널과 한 글자도 갈라지지 않게)", () => {
    const rows = buildHalfReportRows([
      ev({ tick: 10, type: "goal", team: "home", playerId: "P1" }),
      ev({ tick: 20, type: "card", detail: "yellow", team: "home", playerId: "P2" }),
      ev({ tick: 30, type: "card", detail: "red", team: "away", playerId: "P3" }),
    ]);
    expect(rows.map((r) => r.label)).toEqual(["골!", "옐로카드", "레드카드"]);
    expect(rows[0]?.icon).toBe("⚽");
  });

  it("시각 순으로 나온다(로그가 뒤섞여 와도)", () => {
    const rows = buildHalfReportRows([
      ev({ tick: 300, type: "goal", team: "away", playerId: "P5" }),
      ev({ tick: 100, type: "goal", team: "home", playerId: "P1" }),
    ]);
    expect(rows.map((r) => r.tick)).toEqual([100, 300]);
  });
});

describe("경고 누적 퇴장 — 한 사건은 한 줄이다", () => {
  const sameTick = [
    ev({ tick: 700, type: "card", detail: "yellow", team: "home", playerId: "P7" }),
    ev({ tick: 700, type: "card", detail: "red", team: "home", playerId: "P7" }),
  ];

  it("같은 틱·같은 선수의 옐로+레드는 레드 한 줄로 합쳐진다", () => {
    const rows = buildHalfReportRows(sameTick);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.kind).toBe("red");
    expect(rows[0]?.secondYellow).toBe(true);
  });

  it("단독 레드는 경고 누적이 아니다(표식을 아무 데나 붙이지 않는다)", () => {
    const rows = buildHalfReportRows([ev({ tick: 700, type: "card", detail: "red", team: "home", playerId: "P7" })]);
    expect(rows[0]?.secondYellow).toBeUndefined();
  });

  it("다른 선수의 같은 틱 옐로는 살아남는다 — 병합 축은 (틱, 팀, 선수)다", () => {
    const rows = buildHalfReportRows([
      ...sameTick,
      ev({ tick: 700, type: "card", detail: "yellow", team: "away", playerId: "P7" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.kind).sort()).toEqual(["red", "yellow"]);
  });
});

describe("같은 playerId 가 양 팀에 있다 (#231/#324)", () => {
  it("두 팀의 같은 선수 골이 한 줄로 뭉개지지 않는다", () => {
    const rows = buildHalfReportRows([
      ev({ tick: 200, type: "goal", team: "home", playerId: "P22" }),
      ev({ tick: 400, type: "goal", team: "away", playerId: "P22" }),
    ]);
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.key)).size).toBe(2);
    expect(rows.map((r) => r.team)).toEqual(["home", "away"]);
  });

  it("이름 조회는 **팀 축까지** 받는다 — 시그니처가 그 축을 접지 못하게 한다", () => {
    const nameOf = vi.fn(() => "보날두");
    const rows = buildHalfReportRows([ev({ tick: 200, type: "goal", team: "away", playerId: "P22" })], { nameOf });
    expect(nameOf).toHaveBeenCalledWith("away", "P22");
    expect(rows[0]?.playerName).toBe("보날두");
  });

  it("이름을 못 찾으면 비운다 — id 를 이름 자리에 그리지 않는다", () => {
    const rows = buildHalfReportRows([ev({ tick: 200, type: "goal", team: "home", playerId: "P22" })], {
      nameOf: () => undefined,
    });
    expect(rows[0]?.playerName).toBeUndefined();
    expect(rows[0]?.playerId).toBe("P22");
  });
});

describe("halfReportScore — 하프 로그는 그 하프의 골만 갖는다 (#233)", () => {
  const events = [
    ev({ tick: 100, type: "goal", team: "home" }),
    ev({ tick: 200, type: "goal", team: "away" }),
    ev({ tick: 300, type: "goal", team: "away" }),
  ];

  it("전반 리포트는 베이스라인 0 에서 센다", () => {
    expect(halfReportScore(events, { home: 0, away: 0 })).toEqual({ home: 1, away: 2 });
  });

  it("후반 리포트는 앞 하프 확정 스코어 위에 쌓는다(0:0 부터 다시 세지 않는다)", () => {
    expect(halfReportScore(events, { home: 2, away: 1 })).toEqual({ home: 3, away: 3 });
  });

  it("베이스라인이 없으면 하프 로컬(무회귀)", () => {
    expect(halfReportScore(events)).toEqual({ home: 1, away: 2 });
    expect(halfReportScore(null)).toEqual({ home: 0, away: 0 });
  });
});
