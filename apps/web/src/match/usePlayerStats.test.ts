// @vitest-environment jsdom
/**
 * #403 W2 독립검증 **MAJ-1** — `enabled` 가 실효가 있나.
 *
 * ── 무엇이 깨졌었나 ──────────────────────────────────────────────────────────────────────
 * `enabled` 를 **`useHalfLog` 의 페치 스위치**로만 구현했었다. 그런데 `StageShell` 이 무대를 띄우려고
 * 같은 쿼리키(`["matchLog", id, half]`, `staleTime/gcTime: Infinity`)를 이미 채워 두므로 `curLog` 는
 * **항상 캐시에서 채워지고**, 집계 `useMemo` 에는 검사가 없어 그대로 돌았다 —
 * 독립검증 계측: **선수 탭이 닫힌 채 6초 재생에 `computePlayerStats` 24회**(열었을 때 28회).
 * 즉 "보고 있을 때만 켠다"는 **주석에만 있었다**.
 *
 * ── 왜 유닛으로 재나 ─────────────────────────────────────────────────────────────────────
 * e2e 로는 "몇 번 돌았나"를 못 본다(화면이 같다). 그래서 **호출 횟수를 직접 센다** —
 * 주석이 지키는 게 아니라 이 계약이 지킨다. `!enabled` 가드를 지우면 여기서 죽는다.
 *
 * NOTE: 루트 vitest include 가 `apps/**\/*.test.ts` 라 JSX 없이 createElement 로 쓴다.
 */
import { createElement as h } from "react";
import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 로그·카탈로그는 **항상 도착한 것처럼** 준다 — 캐시가 채워진 실제 상황을 재현해야 한다. */
const LOG = {
  tickSnapshots: [
    {
      tick: 0,
      minute: 0,
      ball: { x: 52, y: 34 },
      ballOwner: "P1",
      players: [
        { playerId: "P1", team: "home", pos: { x: 10, y: 34 } },
        { playerId: "P2", team: "away", pos: { x: 90, y: 34 } },
      ],
    },
  ],
  events: [],
};

const playersQuery = vi.fn();

vi.mock("../api/hooks", () => ({
  useHalfLog: (_id: string, _half: number, enabled: boolean) => ({
    data: LOG, // ⚠️ enabled 와 무관하게 **캐시에서 온다** — 그게 이 결함의 전제였다.
    isLoading: false,
    isError: false,
    _enabled: enabled,
  }),
  usePlayers: (enabled: boolean = true) => {
    playersQuery(enabled);
    return { data: [{ id: "P1", name: "가", position: "GK" }, { id: "P2", name: "나", position: "FW" }] };
  },
}));

const computeSpy = vi.fn();
vi.mock("./player-stats", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return {
    ...real,
    computePlayerStats: (...args: unknown[]) => {
      computeSpy();
      return (real.computePlayerStats as (...a: unknown[]) => unknown)(...args);
    },
  };
});

import { useMatchPlayerStats } from "./usePlayerStats";

function Probe({
  tick,
  enabled,
  state = "FIRST_HALF",
}: {
  tick: number | null;
  enabled: boolean;
  state?: string;
}) {
  useMatchPlayerStats("m1", state, tick, 10, enabled);
  return null;
}

beforeEach(() => {
  computeSpy.mockClear();
  playersQuery.mockClear();
});
afterEach(cleanup);

describe("enabled — 보고 있을 때만 돈다", () => {
  it("꺼져 있으면 플레이헤드가 흘러도 **한 번도** 집계하지 않는다", () => {
    const { rerender } = render(h(Probe, { tick: 0, enabled: false }));
    for (let t = 1; t <= 20; t += 1) rerender(h(Probe, { tick: t, enabled: false }));
    expect(computeSpy, "탭이 닫혔는데 집계가 돌면 관전 프레임 예산을 먹는다").toHaveBeenCalledTimes(0);
  });

  /** ⚠️ 반대쪽도 걸어야 한다 — 항상 0 이면 화면이 빈다(공허한 `toHaveCount(0)` 부류). */
  it("켜면 실제로 집계한다(계약이 공허하지 않다는 확인)", () => {
    render(h(Probe, { tick: 0, enabled: true }));
    expect(computeSpy.mock.calls.length).toBeGreaterThan(0);
  });

  it("켜져 있으면 플레이헤드가 바뀔 때마다 다시 돈다(상한이 실제로 따라간다)", () => {
    const { rerender } = render(h(Probe, { tick: 0, enabled: true }));
    const first = computeSpy.mock.calls.length;
    rerender(h(Probe, { tick: 100, enabled: true }));
    expect(computeSpy.mock.calls.length).toBeGreaterThan(first);
  });

  /**
   * ── A-3 (독립검증) — **후반(두 하프 합산) 경로도 같이 잰다** ──────────────────────────
   * 위 케이스는 전부 `FIRST_HALF` 라 `priorEnabled`(후반을 보는 중 전반을 같이 세는 분기)가
   * **한 번도 실행되지 않았다**. 후반이 실제 사용 시간의 절반이고, 거기서는 집계가 **하프당 한 번씩
   * 두 번** 돈다 — 게이팅이 그 경로에서 새면 비용이 두 배다.
   * (⚠️ `priorPart` 안의 `!enabled` 는 `priorEnabled = enabled && …` 와 **중복 조건**이라 지금은
   *  동작이 안 바뀐다. 죽은 조건이지 구멍이 아니다 — 지우지 마라, 두 겹이 의도다.)
   */
  it("후반(전반 합산 경로)에서도 꺼져 있으면 0 · 켜면 두 하프가 다 돈다", () => {
    const { rerender, unmount } = render(h(Probe, { tick: 0, enabled: false, state: "SECOND_HALF" }));
    for (let t = 1; t <= 10; t += 1) rerender(h(Probe, { tick: t, enabled: false, state: "SECOND_HALF" }));
    expect(computeSpy, "후반 경로에서 게이팅이 샌다").toHaveBeenCalledTimes(0);
    unmount();

    computeSpy.mockClear();
    render(h(Probe, { tick: 0, enabled: true, state: "SECOND_HALF" }));
    // 전반(확정, 상한 없음) + 후반(플레이헤드 상한) = 두 번. 한 번이면 합산 경로가 죽은 것이다.
    expect(computeSpy.mock.calls.length, "두 하프가 다 돌아야 '경기 진행분'이 된다").toBe(2);
  });

  /** m8 — 선수 탭을 한 번도 안 여는 유저에게 110명 카탈로그를 내려받지 않는다. */
  it("카탈로그 조회도 꺼진 동안엔 비활성이다", () => {
    render(h(Probe, { tick: 0, enabled: false }));
    expect(playersQuery).toHaveBeenCalledWith(false);
    cleanup();
    playersQuery.mockClear();
    render(h(Probe, { tick: 0, enabled: true }));
    expect(playersQuery).toHaveBeenCalledWith(true);
  });
});
