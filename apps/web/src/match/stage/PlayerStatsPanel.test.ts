// @vitest-environment jsdom
/**
 * #403 W2 — 선수 탭·요약 카드가 **순수 판정을 실제로 배선했나**.
 *
 * `player-stats-view.test.ts` 는 규칙이 옳은지를 보고, 여기서는 그 규칙이 **화면에 닿는지**를 본다.
 *
 * ⚠️ **피치 요약 카드 계약은 여기 없다** — `PlayerTouchCard.test.ts`((B) 소속)에 있다.
 * (B) 는 #421 뒤에 따로 리베이스되므로 (A) 파일에 섞으면 분리가 성립하지 않는다.
 * 순수함수만 검증하면 "규칙은 있는데 컴포넌트가 안 부른다"가 전부 green 으로 통과한다
 * (#382 가 정확히 그 부류를 경고한다: 로테이션이 순수함수에만 있고 배선이 빠진 상태).
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다
 * (`GenWaitPanel.test.ts`·`MatchPage.test.ts` 와 동일).
 */
import { createElement as h } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { PlayerStatsPanel } from "./PlayerStatsPanel";
import { computePlayerStats, passAttributionCoverage, type StatMatchLog } from "../player-stats";
import { buildRosterMeta, gkKeysOf, positionsOf, statsWindow } from "../player-stats-view";
import type { MatchPlayerStats } from "../usePlayerStats";

const CATALOG = [
  { id: "P1", name: "오성민", position: "GK" },
  { id: "P2", name: "정태우", position: "DF" },
  { id: "P9", name: "김도현", position: "FW" },
];

/**
 * 양 팀 3명 · 슛/골/선방/가로챔 한 벌. **`P9` 를 양 팀에 둔다**(#231) — 맨 id 로 조회하는 구현은
 * 여기서 두 사람이 한 줄로 합쳐진다.
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
  const snap = (tick: number, owner: string) => ({
    tick,
    minute: Math.floor(tick / 30),
    ball: { x: 52 + tick, y: 34 },
    ballOwner: owner,
    players,
  });
  return {
    tickSnapshots: [snap(0, "P2"), snap(1, "P2"), snap(2, "P9"), snap(3, "P9")],
    events: [
      { tick: 2, minute: 0, type: "pass", team: "home", playerId: "P9" },
      { tick: 3, minute: 0, type: "shot", team: "home", playerId: "P9", xg: 0.41 },
      { tick: 3, minute: 0, type: "goal", team: "home", playerId: "P9" },
      { tick: 3, minute: 0, type: "save", team: "away", playerId: "P1" },
    ],
  };
}

function makeStats(over: Partial<MatchPlayerStats> = {}): MatchPlayerStats {
  const log = makeLog();
  const roster = buildRosterMeta(log, CATALOG);
  const result = computePlayerStats(log, { gkKeys: gkKeysOf(roster), positions: positionsOf(roster) });
  return {
    result,
    roster,
    coverage: passAttributionCoverage(result),
    // 기본 표본 = 진행 중(전반 15분). 창은 **앱과 같은 함수**로 만든다 — 손으로 적으면 화면이
    // 실제로 받는 모양과 갈라진다(목이 계약의 일부다).
    window: statsWindow("FIRST_HALF", 900, 34),
    isLoading: false,
    isError: false,
    ...over,
  };
}

const NAMES = { homeName: "Thunder Bay United", awayName: "축구왕여르" };

function renderPanel(props: Partial<Parameters<typeof PlayerStatsPanel>[0]> = {}) {
  return render(
    h(PlayerStatsPanel, {
      stats: makeStats(),
      ...NAMES,
      myTeamSide: "away",
      ...props,
    } as Parameters<typeof PlayerStatsPanel>[0]),
  );
}

afterEach(cleanup);

describe("선수 탭 — 팀 세그먼트(#322 어웨이 표본)", () => {
  /**
   * ⚠️ **표본이 계약의 절반이다.** 기존 web 목·계약이 전부 유저=홈이라 "홈 = 나" 가정이 3개월
   * 살았다(#322). 그래서 여기 기본 표본은 **유저 = away** 다.
   */
  it("순서는 홈 먼저, 표식과 기본 선택은 내 팀(어웨이)에", () => {
    renderPanel();
    const btns = screen.getAllByRole("button", { pressed: undefined });
    expect(btns.length).toBeGreaterThan(0);

    expect(screen.getByTestId("players-team-home").textContent).toContain("Thunder Bay United");
    expect(screen.getByTestId("players-team-away").textContent).toContain("축구왕여르");
    // 표식은 **내 팀 이름 바로 뒤** — 어웨이 쪽에만.
    expect(screen.queryByTestId("players-my-team-home")).toBeNull();
    expect(screen.getByTestId("players-my-team-away")).not.toBeNull();
    // 기본 선택 = 내 팀. 처음 열면 내 선수단이 보여야 한다.
    expect(screen.getByTestId("players-team-away").getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("players-team-home").getAttribute("data-selected")).toBe("false");
  });

  it("세그먼트를 바꾸면 **상대 선수단**이 그대로 나온다(결정 ② = 우리와 완전히 동일)", () => {
    renderPanel();
    // away(내 팀) 에는 away:P9 가 있다.
    expect(screen.queryByTestId("players-row-away-P9")).not.toBeNull();
    expect(screen.queryByTestId("players-row-home-P9")).toBeNull();

    fireEvent.click(screen.getByTestId("players-team-home"));
    expect(screen.queryByTestId("players-row-home-P9")).not.toBeNull();
    expect(screen.queryByTestId("players-row-away-P9")).toBeNull();
    // 상대 표에도 같은 6열이 산다(요약이 아니다).
    expect(screen.getByTestId("players-passpct-home-P9")).not.toBeNull();
    expect(screen.getByTestId("players-defence-home-P9")).not.toBeNull();
  });

  it("관전(내 팀 미상)이면 표식이 없고 홈이 기본", () => {
    renderPanel({ myTeamSide: null });
    expect(screen.queryByTestId("players-my-team-home")).toBeNull();
    expect(screen.queryByTestId("players-my-team-away")).toBeNull();
    expect(screen.getByTestId("players-team-home").getAttribute("data-selected")).toBe("true");
  });
});

describe("선수 탭 — 표", () => {
  it("같은 id 가 양 팀에 있어도 두 사람이 갈린다(#231)", () => {
    renderPanel({ myTeamSide: "home" });
    // home:P9 가 골을 넣었고 away:P9 는 안 넣었다 — 합쳐졌다면 한쪽이 사라지거나 값이 섞인다.
    const homeRow = screen.getByTestId("players-row-home-P9");
    expect(homeRow.textContent).toContain("김도현");
    fireEvent.click(screen.getByTestId("players-team-away"));
    expect(screen.getByTestId("players-row-away-P9")).not.toBeNull();
  });

  it("정렬 칩을 누르면 실제로 순서가 바뀐다", () => {
    renderPanel({ myTeamSide: "home" });
    const order = () =>
      Array.from(document.querySelectorAll("[data-testid^='players-row-home-']")).map((el) =>
        el.getAttribute("data-testid"),
      );
    const byRating = order();
    fireEvent.click(screen.getByTestId("players-sort-num"));
    expect(screen.getByTestId("players-sort-num").getAttribute("data-selected")).toBe("true");
    const byNum = order();
    expect(byNum).not.toEqual(byRating);
    expect(byNum).toEqual(["players-row-home-P1", "players-row-home-P2", "players-row-home-P9"]);
  });

  /** GK 의 `수비` 열은 선방이다 — 숫자만 두면 "GK 가 수비를 5번 했다"로 읽힌다. */
  it("GK 행은 수비 열이 선방이라고 말한다", () => {
    renderPanel({ myTeamSide: "away" });
    const gk = screen.getByTestId("players-row-away-P1");
    expect(gk.getAttribute("data-gk")).toBe("true");
    const cell = screen.getByTestId("players-defence-away-P1");
    expect(cell.textContent).toContain("선방");
    expect(cell.textContent).toContain("1"); // 위 픽스처의 save 1건
  });

  it("행을 누르면 그 선수를 고른다 — 피치·카드와 같은 선택", () => {
    const onSelect = vi.fn();
    renderPanel({ myTeamSide: "home", onSelect });
    fireEvent.click(screen.getByTestId("players-row-home-P9"));
    expect(onSelect).toHaveBeenCalledWith({ team: "home", playerId: "P9" });
  });

  /**
   * ── A-1 (독립검증) — **MOTM 칩은 확정 하프에만** ────────────────────────────────────────
   * `win.kind === "settled" &&` 를 지운 변이가 유닛 101 + e2e 29 를 **전부 통과**했다 =
   * 코드는 옳은데 그 성질을 지키는 것이 없었다. 그 상태면 7분 시점에 금색
   * `이 경기 최우수 선수` 칩이 뜬다 — MOTM 은 목업상 **종료 화면(⑤)의 개념**이고, 진행 중에
   * "최우수"를 확정해 말하는 것은 경기가 끝나기 전에 결론을 내는 것이다.
   * ⚠️ 양방향으로 건다 — 확정에서 0 이면 그것대로 기능이 죽은 것이다.
   */
  const motmChips = () => document.querySelectorAll('[data-tier="motm"]').length;

  it("MOTM 칩은 확정 하프에만 뜬다 — 라이브에는 0", () => {
    // MOTM 은 팀 무관 최고 평점 1명이라, 그 선수가 속한 팀을 골라야 칩이 보인다(픽스처 = home:P9 득점).
    const { unmount } = renderPanel({
      myTeamSide: "home",
      stats: makeStats({ window: statsWindow("FINISHED", 2000, 90) }),
    });
    expect(motmChips(), "확정 하프인데 MOTM 칩이 없다 = 기능이 죽었다").toBe(1);
    unmount();

    renderPanel({ myTeamSide: "home" }); // 기본 표본 = 진행 중(FIRST_HALF 15분)
    expect(motmChips(), "경기가 도는 중에 '최우수 선수'를 확정해 말하면 안 된다").toBe(0);
  });

  it("고른 선수의 행이 표시된다(피치에서 골라도 표가 따라온다)", () => {
    renderPanel({ myTeamSide: "home", selected: { team: "home", playerId: "P9" } });
    expect(screen.getByTestId("players-row-home-P9").getAttribute("data-picked")).toBe("true");
    expect(screen.getByTestId("players-row-home-P2").getAttribute("data-picked")).toBe("false");
  });
});

describe("선수 탭 — 라이브 캡션과 기록 불완전", () => {
  it("라이브면 N분까지 / 확정 하프면 캡션이 아예 없다", () => {
    const { unmount } = renderPanel();
    expect(screen.getByTestId("players-live-caption").textContent).toBe("34분까지의 기록");
    unmount();
    // 감독시간·종료 = 확정 하프 → 캡션 없음(그리고 상한도 없다 — 같은 창에서 나온다).
    renderPanel({ stats: makeStats({ window: statsWindow("HALFTIME", null, 7) }) });
    expect(screen.queryByTestId("players-live-caption")).toBeNull();
  });

  /**
   * ⚠️ 이 배지가 **양방향으로** 걸려야 한다. 항상 뜨면 경고가 배경 소음이 되고, 안 뜨면
   * 성긴 로그의 낮은 숫자가 사실로 읽힌다.
   */
  it("귀속이 불완전하면 배지가 뜨고, 완전하면 없다", () => {
    const { unmount } = renderPanel({ stats: makeStats({ coverage: 0.82 }) });
    const badge = screen.getByTestId("players-pass-incomplete");
    expect(badge.textContent).toContain("기록 불완전");
    expect(badge.getAttribute("title")).toContain("82%");
    unmount();
    renderPanel({ stats: makeStats({ coverage: 1 }) });
    expect(screen.queryByTestId("players-pass-incomplete")).toBeNull();
  });

  it("아직 아무도 안 뛰었으면 빈 표라고 말한다", () => {
    renderPanel({
      stats: makeStats({
        result: { players: [], motm: null, unattributed: { passesCompleted: 0, passesAttempted: 0, events: {} }, heatBins: { cols: 12, rows: 8 }, uptoTick: 0, ticks: 0 },
      }),
    });
    expect(screen.getByTestId("players-empty")).not.toBeNull();
  });
});
