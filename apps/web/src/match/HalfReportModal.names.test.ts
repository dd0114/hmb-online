// @vitest-environment jsdom
/**
 * 하프 리포트 스택의 **선수명 사다리·축** 계약 (#406 요구 6, W8).
 *
 * <p>W8 이 이 화면을 초크포인트로 옮겼다. 옮기기 전 상태:
 * <pre>
 *   const byId = new Map(catalog.map((p) => [p.id, p.name]));      // 이름 사다리 두 번째 선언
 *   {meta?.name ?? nameOf(top.team, top.playerId) ?? top.playerId} // 3단 = playerId
 * </pre>
 * 카탈로그 우선순위도, 짧은 축도, `미상 선수` 폴백도 없었다 — #411 스위치 날 이 스택만 옛 규칙으로
 * 남고, 카탈로그에 행이 없는 선수는 <b>`P077` 이 그대로 떴다</b>.
 *
 * <h3>스캐너가 이 축을 못 본다</h3>
 * `catalog.map((p) => [p.id, p.name])` 은 <b>순회 렌더</b>라 AST 스캐너의 기재된 미탐 경계 안이고,
 * <b>축을 바꾸는 변이</b>(`short` → `full`)는 어떤 형태로도 스캐너에 안 걸린다. 그래서 여기서 잰다.
 *
 * <h3>표본은 <b>#411 스위치 후</b> 모양이다</h3>
 * 오늘 라이브는 `shortName` 이 없어 두 축의 값이 같다 — 그 표본으로는 축 변이가 전부 생존한다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다.
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UNKNOWN_PLAYER_NAME } from "../common/player-names";

const mocks = vi.hoisted(() => ({
  log: null as unknown,
  players: [] as unknown,
  top: null as unknown,
}));

vi.mock("../api/hooks", () => ({
  useHalfLog: () => ({ data: mocks.log, isLoading: false }),
  usePlayers: () => ({ data: mocks.players }),
}));
vi.mock("./skip-report-rating", async (orig) => ({
  ...(await orig<typeof import("./skip-report-rating")>()),
  topRatedOfHalf: () => mocks.top,
}));

import { HalfReportModal } from "./HalfReportModal";

/** `shortName` 이 풀네임과 **다른** 카탈로그 = #411 스위치 후. `P999` 는 일부러 없다. */
const CATALOG = [
  { id: "P077", name: "크바라츠헬리아", shortName: "흐비차", position: "FW" },
  { id: "P001", name: "레프 야신", shortName: "야신", position: "GK" },
];

const GOAL = { tick: 600, minute: 20, type: "goal", team: "home", playerId: "P077" };
/** 선수를 모르는 사건 — 이름 칸이 **비어야** 한다(`미상 선수` 가 아니다). */
const GOAL_NO_PLAYER = { tick: 700, minute: 23, type: "goal", team: "home" };
/** 카탈로그에 없는 선수의 사건. */
const CARD_UNKNOWN = { tick: 900, minute: 30, type: "card", detail: "yellow", team: "away", playerId: "P999" };

function open() {
  render(
    h(HalfReportModal, {
      matchId: "m1",
      half: 1,
      homeName: "우리팀",
      awayName: "봇 FC",
      myTeamSide: "home",
      baseline: { home: 0, away: 0 },
      onClose: () => {},
    }),
  );
}

/**
 * 스택의 2번째 장(주요 인물)으로 넘긴다.
 *
 * ⚠️ `element.click()` 을 쓰면 안 된다 — `act()` 밖이라 상태 갱신이 **그 프레임에 반영되지 않고**
 * 다음 단언이 여전히 타임라인 카드를 본다(실제로 3건이 그렇게 실패했다). `fireEvent` 는 act 로 감싼다.
 */
function toMotm() {
  fireEvent.click(screen.getByTestId("half-report-next"));
}

afterEach(() => {
  cleanup();
  mocks.log = null;
  mocks.players = [];
  mocks.top = null;
});

describe("타임라인 행 — **밀집 축**(`short`)", () => {
  it("행 이름이 shortName 이다 (**풀네임이 아니다**)", () => {
    mocks.log = { events: [GOAL] };
    mocks.players = CATALOG;
    open();
    const row = screen.getByTestId("half-report-row-600").textContent ?? "";
    expect(row).toContain("흐비차");
    // ★ 변이: `names.full` 로 바꾸면 여기서 죽는다.
    expect(row).not.toContain("크바라츠헬리아");
  });

  it("★ 카탈로그가 모르는 선수는 `미상 선수` — **`P999` 가 아니다**", () => {
    mocks.log = { events: [CARD_UNKNOWN] };
    mocks.players = CATALOG;
    open();
    const row = screen.getByTestId("half-report-row-900").textContent ?? "";
    expect(row).toContain(UNKNOWN_PLAYER_NAME);
    expect(row).not.toContain("P999");
  });

  /**
   * ⚠️ **"선수를 모른다"와 "선수가 없는 사건"은 다른 사실이다.** 후자에 `미상 선수` 를 붙이면
   * 없는 사람을 지어내는 것이라 `half-report.ts` 의 `playerName` 규율(`undefined` = 칸을 비운다)을
   * 어긴다. 이설하면서 가장 깨지기 쉬운 자리다(`playerId` 유무 분기를 지우면 여기서 죽는다).
   */
  it("선수 없는 사건은 이름 칸이 빈다 — `미상 선수` 를 지어내지 않는다", () => {
    mocks.log = { events: [GOAL_NO_PLAYER] };
    mocks.players = CATALOG;
    open();
    const row = screen.getByTestId("half-report-row-700").textContent ?? "";
    expect(row).not.toContain(UNKNOWN_PLAYER_NAME);
    expect(row).toContain("우리팀"); // 팀 라벨은 그대로 = 행이 살아 있다(공허한 단언 아님)
  });
});

describe("주요 인물 카드 — 같은 스택은 **한 사람을 한 이름으로** 부른다", () => {
  it("MOTM 이름도 `short` 다 (앞 장 타임라인 행과 같은 축)", () => {
    mocks.log = { events: [GOAL] };
    mocks.players = CATALOG;
    mocks.top = { team: "home", playerId: "P077", rating: 8.25, line: {}, isMotm: true };
    open();
    toMotm();
    expect(screen.getByTestId("half-report-motm-name").textContent).toBe("흐비차");
  });

  it("★ 카탈로그가 모르면 `미상 선수` — **playerId 가 새지 않는다**", () => {
    mocks.log = { events: [GOAL] };
    mocks.players = CATALOG;
    mocks.top = { team: "away", playerId: "P999", rating: 7.1, line: {}, isMotm: false };
    open();
    toMotm();
    const text = screen.getByTestId("half-report-motm-name").textContent ?? "";
    expect(text).toBe(UNKNOWN_PLAYER_NAME);
    expect(text).not.toBe("P999");
  });

  /**
   * ⚠️ **트림된 로그**(스냅샷 없음)에서도 이름은 나온다. 이름을 로스터 표에 매달면 그 표가
   * 등번호를 만들 수 없어 비고, 이름이 같이 사라진다 — 그래서 이름은 로스터가 아니라
   * 초크포인트에서 직접 온다(번호만 `–` 로 떨어진다).
   */
  it("스냅샷 없는 로그에서도 이름은 나오고 번호만 `–` 다", () => {
    mocks.log = { events: [GOAL] }; // tickSnapshots 없음 → 로스터 비어 있음
    mocks.players = CATALOG;
    mocks.top = { team: "home", playerId: "P077", rating: 8.0, line: {}, isMotm: false };
    open();
    toMotm();
    expect(screen.getByTestId("half-report-motm-name").textContent).toBe("흐비차");
    expect(screen.getByTestId("half-report-motm-num").textContent).toBe("–");
  });
});
