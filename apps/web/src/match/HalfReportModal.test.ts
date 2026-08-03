// @vitest-environment jsdom
/**
 * #421 W2 — 하프 리포트 팝업의 **화면 계약**.
 *
 * ⚠️ 평점 SoT(#403 `player-stats.ts`)가 머지돼 어댑터는 **W7 에서 플립됐다**(더 이상 상시 `null` 이
 * 아니다). 그래도 **`null` 경로는 사라지지 않는다** — 기록이 없는 하프·손상 로그·아직 안 온 로그가
 * 그 자리다. 그때 팝업이 빈 카드를 그리거나 `1 / 2` 페이저를 남기면 그게 곧 결함이라,
 * "평점 카드가 없으면 스택이 1장으로 줄고 페이저·도트가 사라진다"를 계약으로 계속 박는다.
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
/**
 * ⚠️ **`highlightStatsOf` 는 진짜를 쓴다**(`importActual`). 이 스위트가 보려는 것은 "카드가 집계
 * 줄에서 실제로 기록을 뽑아 그리는가"라, 그것까지 목으로 갈면 빈 배열을 그려도 통과한다.
 * 목으로 가는 것은 **어느 선수를 고르나**(= 로그 집계) 하나뿐이다.
 */
vi.mock("./skip-report-rating", async (orig) => ({
  ...(await orig<typeof import("./skip-report-rating")>()),
  topRatedOfHalf: () => mocks.top,
}));

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

describe("스택 — 평점 카드가 없으면 1장이다 (기록 없는 하프·손상 로그)", () => {
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
    mocks.top = { team: "home", playerId: "P1", rating: 8.25, line: {}, isMotm: true };
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

  /**
   * #421-2 ② 의 AC = "전반전 가장 평점 좋은 **주요 인물** 1장". 이름·평점만 있으면 그 사람이
   * **왜** 주요 인물인지가 화면에 없다 — 등번호(경기장 토큰과 잇는 축)와 기록을 같이 그린다.
   */
  it("카드는 등번호·이름·포지션·평점 등급·하이라이트 기록을 그린다", () => {
    mocks.log = {
      events: [GOAL],
      // 등번호는 `viewer-skins.jerseyNumbers` 규칙(팀별 등장 순서) — 로그가 있어야 나온다.
      tickSnapshots: [
        {
          tick: 0,
          minute: 0,
          ball: { x: 0, y: 0 },
          players: [
            { playerId: "P1", team: "home", pos: { x: 1, y: 1 } },
            { playerId: "P9", team: "away", pos: { x: 2, y: 2 } },
          ],
        },
      ],
    };
    mocks.players = [{ id: "P1", name: "보날두", position: "FW" }];
    mocks.top = {
      team: "home",
      playerId: "P1",
      rating: 8.25,
      isMotm: true,
      line: { goals: 2, assists: 1, keyPasses: 0, shotsOnTarget: 0, tackles: 0 },
    };
    open();
    fireEvent.click(screen.getByTestId("half-report-next"));

    expect(screen.getByTestId("half-report-motm-num").textContent).toBe("1");
    expect(screen.getByTestId("half-report-motm-name").textContent).toBe("보날두");
    // 평점 등급은 선수 탭과 같은 판정(`ratingTier`) — 색이 화면마다 갈리지 않는다.
    expect(screen.getByTestId("half-report-motm-rating")).toHaveProperty("dataset.tier", "motm");

    const stats = screen.getByTestId("half-report-motm-stats");
    expect(stats.textContent).toContain("골");
    expect(stats.textContent).toContain("2");
    expect(stats.textContent).toContain("어시스트");
    // 0 인 항목은 싣지 않는다(소음).
    expect(stats.textContent).not.toContain("키패스");
  });

  it("스냅샷 없는 로그(등번호 미상)에서도 이름·평점은 그린다 — 부가 정보가 주 정보를 죽이지 않는다", () => {
    mocks.log = { events: [GOAL] };
    mocks.players = [{ id: "P1", name: "보날두" }];
    mocks.top = { team: "home", playerId: "P1", rating: 6.4, isMotm: false, line: {} };
    open();
    fireEvent.click(screen.getByTestId("half-report-next"));

    expect(screen.getByTestId("half-report-motm-num").textContent).toBe("–");
    expect(screen.getByTestId("half-report-motm-name").textContent).toBe("보날두");
    expect(screen.getByTestId("half-report-motm-rating").textContent).toBe("6.4");
    expect(screen.queryByTestId("half-report-motm-stats")).toBeNull();
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
