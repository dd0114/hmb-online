// @vitest-environment jsdom
/**
 * #421 W2 — 하프 리포트 팝업의 **화면 계약**.
 *
 * 가장 중요한 것은 ③이다: 평점 SoT(#403 `player-stats.ts`)는 아직 main 에 없어 어댑터가 `null` 을
 * 준다. 그때 팝업이 빈 카드를 그리거나 `1 / 2` 페이저를 남기면 **모듈이 오기 전 배포가 곧 결함**이
 * 된다. 그래서 "평점 카드가 없으면 스택이 1장으로 줄고 페이저·도트가 사라진다"를 계약으로 박는다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다(GenWaitPanel.test 동일).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  log: null as unknown,
  isLoading: false,
  players: [] as unknown,
  top: null as unknown,
}));

vi.mock("../api/hooks", () => ({
  useHalfLog: () => ({ data: mocks.log, isLoading: mocks.isLoading }),
  usePlayers: () => ({ data: mocks.players }),
}));
vi.mock("./skip-report-rating", () => ({ topRatedOfHalf: () => mocks.top }));

import { HalfReportModal } from "./HalfReportModal";

const GOAL = { tick: 600, minute: 20, type: "goal", team: "home", playerId: "P1" };
const CARD = { tick: 900, minute: 30, type: "card", detail: "yellow", team: "away", playerId: "P9" };

function open(over: Partial<Parameters<typeof HalfReportModal>[0]> = {}) {
  const onClose = vi.fn();
  render(
    h(HalfReportModal, {
      matchId: "m1",
      half: 1,
      homeName: "우리팀",
      awayName: "봇 FC",
      myTeamSide: "home",
      baseline: { home: 0, away: 0 },
      onClose,
      ...over,
    }),
  );
  return onClose;
}

afterEach(() => {
  cleanup();
  mocks.log = null;
  mocks.isLoading = false;
  mocks.players = [];
  mocks.top = null;
});

describe("스택 — 평점 카드가 없으면 1장이다 (#403 머지 전)", () => {
  it("페이저·도트·뒤 카드가 모두 없고 주 버튼이 바로 [닫기]다", () => {
    mocks.log = { events: [GOAL] };
    const onClose = open();

    expect(screen.getByTestId("half-report-card")).toHaveProperty("dataset.card", "timeline");
    expect(screen.queryByTestId("half-report-pager")).toBeNull();
    expect(screen.queryByTestId("half-report-dots")).toBeNull();
    expect(screen.queryByTestId("half-report-behind-1")).toBeNull();

    const next = screen.getByTestId("half-report-next");
    expect(next.textContent).toBe("닫기");
    fireEvent.click(next);
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("스택 — 평점이 오면 2장이 되고 한 장씩 넘어간다", () => {
  it("타임라인 → 주요 인물 → 닫기", () => {
    mocks.log = { events: [GOAL] };
    mocks.players = [{ id: "P1", name: "보날두" }];
    mocks.top = { team: "home", playerId: "P1", rating: 8.25, line: {} };
    const onClose = open();

    expect(screen.getByTestId("half-report-pager").textContent).toBe("1 / 2");
    expect(screen.getByTestId("half-report-dots").children).toHaveLength(2);
    // 뒤에 남은 장이 카드로 비쳐야 "더 있다"가 읽힌다(NoticePopup 과 같은 은유).
    expect(screen.getByTestId("half-report-behind-1")).toBeTruthy();

    const next = screen.getByTestId("half-report-next");
    expect(next.textContent).toBe("다음");
    fireEvent.click(next);

    expect(screen.getByTestId("half-report-card")).toHaveProperty("dataset.card", "top-rated");
    expect(screen.getByTestId("half-report-motm-name").textContent).toBe("보날두");
    expect(screen.getByTestId("half-report-motm-rating").textContent).toBe("8.3");
    expect(screen.getByTestId("half-report-pager").textContent).toBe("2 / 2");
    // 마지막 장에서는 뒤 카드가 없다.
    expect(screen.queryByTestId("half-report-behind-1")).toBeNull();
    expect(onClose).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId("half-report-next"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("타임라인 카드", () => {
  it("골·카드를 표기 분과 함께 그리고 선수·팀 이름을 붙인다", () => {
    mocks.log = { events: [GOAL, CARD] };
    mocks.players = [
      { id: "P1", name: "보날두" },
      { id: "P9", name: "욱링엄" },
    ];
    open();

    const goal = screen.getByTestId("half-report-row-600");
    expect(goal.textContent).toContain("20'");
    expect(goal.textContent).toContain("골!");
    expect(goal.textContent).toContain("보날두");
    expect(goal.textContent).toContain("우리팀");

    const card = screen.getByTestId("half-report-row-900");
    expect(card.textContent).toContain("옐로카드");
    expect(card.textContent).toContain("봇 FC");
  });

  it("기록이 없는 하프는 그렇게 말한다(빈 목록을 그대로 두지 않는다)", () => {
    mocks.log = { events: [] };
    open();
    expect(screen.getByTestId("half-report-empty").textContent).toContain("골·카드 기록이 없습니다");
  });

  it("로그가 아직 안 왔으면 '없다'가 아니라 '불러오는 중'이다", () => {
    mocks.log = null;
    mocks.isLoading = true;
    open();
    expect(screen.getByTestId("half-report-empty").textContent).toContain("불러오는 중");
  });

  it("스코어는 베이스라인 위에 쌓인다(후반 리포트가 0:0 부터 세지 않는다, #233)", () => {
    mocks.log = { events: [GOAL] };
    open({ half: 2, baseline: { home: 2, away: 1 } });
    expect(screen.getByTestId("half-report-score").textContent).toContain("우리팀 3 : 1 봇 FC");
    expect(screen.getByTestId("half-report-title").textContent).toBe("후반 리포트");
  });
});

describe("응답 형태를 믿지 않는다", () => {
  it("`/api/players` 가 배열이 아니어도(구 서버·목의 `{}`) 리포트가 살아 있다", () => {
    // apps/web CLAUDE.md: 이 가드가 없으면 `.map` 이 던져 화면이 통째로 흰 화면이 된다.
    mocks.log = { events: [GOAL] };
    mocks.players = {};
    open();
    expect(screen.getByTestId("half-report-row-600")).toBeTruthy();
  });

  it("이벤트가 없는 손상 로그에도 카드가 뜬다", () => {
    mocks.log = {};
    open();
    expect(screen.getByTestId("half-report-card")).toBeTruthy();
  });
});
