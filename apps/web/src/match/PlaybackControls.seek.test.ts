// @vitest-environment jsdom
/**
 * 과거 전용 시크바 — **배선** 계약 (#406 W3 / 요구 5-3).
 *
 * 순수 판정은 `seek-gate.test.ts` 가 지고, 여기서는 그 판정이 **화면과 코어에 실제로 걸려 있는지**를
 * 본다. 이 갈래가 필요한 이유는 #216 독립검증 major-1 과 같다 — 규칙을 순수 함수로만 박제하면
 * 그것을 부르는 한 줄을 지워도 아무도 안 죽는다.
 *
 * 계약 다섯:
 *  ① 라이브 플레이 모드에 **유저 시크바가 있다**(예전엔 컨트롤이 0개였다).
 *  ② 슬라이더가 덮는 최대치가 **라이브 헤드**다 — `snapCount - 1` 이 아니다.
 *  ③ 그 층을 뚫어도(`max` 되돌리기 = 변이체) `clampSeek` 층이 남아 미래로 안 간다.
 *  ④ **미래 핀은 클릭이 거부**된다(흐리게만 그리는 게 아니다).
 *  ⑤ 뒤로 가면 배지 + [현재로] 가 뜨고, **복구 루프가 끌어당기지 않는다**(hero 확정 = 수동 복귀만).
 *     [현재로] 를 누르면 원래 동작(추종)으로 돌아온다.
 *
 * jsdom 엔 canvas 2D 가 없으므로 `createViewer` 를 목킹한다(렌더 엔진은 e2e·dev-viewer 담보).
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminFlagContext } from "../admin/admin-flag";

const viewer = vi.hoisted(() => {
  const hooks = {} as Record<string, unknown>;
  return {
    setAutoPace: vi.fn(),
    setSpeed: vi.fn(),
    setSkin: vi.fn(),
    load: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    togglePlay: vi.fn(),
    restart: vi.fn(),
    jumpEvent: vi.fn(),
    jumpToTick: vi.fn(),
    play: vi.fn(),
    pause: vi.fn(),
    seek: vi.fn(),
    scrubTo: vi.fn(),
    // #406 W4: 선수 하이라이트. **목은 계약의 일부다** — 실제 컨트롤러에 있는 메서드를 빠뜨리면
    // 그 테스트는 자기가 만든 세계를 검증한다(#342). 여기 없던 동안 65건이 red 였다.
    setSelection: vi.fn(),
    hooks,
  };
});
const createViewer = vi.hoisted(() => vi.fn(() => viewer));
// `createViewer` **만** 목이고 나머지는 실물이다 — `skinKeyOf` 를 목으로 덮으면 선택 키가
// undefined 가 되어 #324 축(양 팀 동일 playerId)이 이 파일에서 구조적으로 검사 불가가 된다.
// ⚠️ 종전엔 주석만 "실물 그대로"라 적고 **규칙을 손으로 베껴** 넣었다(#406 W4 m-1). 손으로 벤
// 목은 계약이 아니라 자기가 만든 세계다(#342) — 규칙이 갈려도 이 파일은 조용히 초록이다.
vi.mock("@hmb/viewer-core", async () => ({
  ...(await vi.importActual<typeof import("@hmb/viewer-core")>("@hmb/viewer-core")),
  createViewer,
}));

/** 후반 로그 100 스냅샷(틱 2700..2799) — 인덱스와 절대 틱을 섞으면 여기서 죽는다. */
const H2_FIRST_TICK = 2700;
const SNAP_COUNT = 100;
/** 지난 장면(인덱스 10) · 아직 안 온 장면(인덱스 90). 상한은 절반(50)이다. */
const PAST_PIN_TICK = H2_FIRST_TICK + 10;
const FUTURE_PIN_TICK = H2_FIRST_TICK + 90;
const EVENTS = [
  { tick: PAST_PIN_TICK, type: "goal", team: "home" },
  { tick: FUTURE_PIN_TICK, type: "goal", team: "away" },
];
const H2_LOG = {
  tickSnapshots: Array.from({ length: SNAP_COUNT }, (_, i) => ({ tick: H2_FIRST_TICK + i })),
  events: EVENTS,
  finalScore: { home: 0, away: 0 },
} as unknown;

const fx = { log: H2_LOG };
vi.mock("../api/hooks", () => ({
  useHalfLog: () => ({ data: fx.log, isLoading: false, isError: false }),
  usePlayers: () => ({ data: [] }),
}));

import { MatchViewer } from "./MatchViewer";

const HALF_REAL_MS = 420_000;
/** grace 1500ms ÷ 1000ms/tick = 2 인덱스. 상한 50 + 2 = 52 가 허용 끝이다. */
const GRACE_IDX = 2;
const LIVE_IDX = 50;

function liveClock(elapsedFrac: number) {
  const now = Date.now();
  const start = now - HALF_REAL_MS * elapsedFrac;
  return {
    phase: "SECOND_HALF" as const,
    kickoffAt: new Date(start).toISOString(),
    phaseStartAt: new Date(start).toISOString(),
    phaseEndsAt: new Date(start + HALF_REAL_MS).toISOString(),
    serverNow: new Date(now).toISOString(),
    halfRealMs: HALF_REAL_MS,
    halftimeMs: 180_000,
    seekForwardBlocked: true,
    seekGraceMs: 1500,
  };
}

function chromeOf() {
  return (createViewer.mock.calls[0] as unknown as unknown[])[1] as {
    onScrub?: (pct: number) => void;
    onLoaded?: (info: { events: unknown[]; snapCount: number; statusText: string }) => void;
  };
}

const tree = (clock: ReturnType<typeof liveClock> | null) =>
  h(
    AdminFlagContext.Provider,
    { value: false },
    h(MatchViewer, { matchId: "m1", half: 2 as const, homeName: "홈", awayName: "원정", clock }),
  );

/** 라이브 후반(절반 경과) 관전 화면. `clock: null` 이면 종료 화면(전 구간 자유). */
function open(clock: ReturnType<typeof liveClock> | null, curTick = H2_FIRST_TICK + LIVE_IDX) {
  viewer.hooks.cur = () => ({ tick: curTick, tickPosIdx: curTick - H2_FIRST_TICK });
  viewer.hooks.seek = viewer.seek;
  viewer.hooks.idxOfTick = (t: number) => t - H2_FIRST_TICK;
  const r = render(tree(clock));
  act(() => {
    chromeOf().onLoaded!({ events: EVENTS, snapCount: SNAP_COUNT, statusText: "" });
  });
  // 마운트 시 seek-to-now(진입 점프)는 정상 동작 — 그 뒤의 조작만 본다.
  viewer.jumpToTick.mockClear();
  viewer.play.mockClear();
  viewer.scrubTo.mockClear();
  viewer.seek.mockClear();
  return r;
}

const bar = () => screen.getByTestId("viewer-seek-half2") as HTMLInputElement;
const badge = () => screen.getByTestId("viewer-seek-past-half2");
const nowBtn = () => screen.getByTestId("viewer-seek-now-half2");

/** 코어가 프레임마다 부르는 스크럽 콜백 — 재생 헤드가 실제로 흘렀다고 알린다. */
function headMovesTo(index: number) {
  act(() => {
    chromeOf().onScrub!((index / (SNAP_COUNT - 1)) * 100);
  });
}

beforeEach(() => {
  window.history.replaceState({}, "", "/match/m1");
  window.localStorage.clear();
  createViewer.mockClear();
  fx.log = H2_LOG;
  for (const fn of Object.values(viewer)) if (typeof fn === "function" && "mockClear" in fn) fn.mockClear();
  for (const k of Object.keys(viewer.hooks)) delete viewer.hooks[k];
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("#406 W3 ① 라이브 플레이 모드에 유저 시크바가 있다", () => {
  it("일반 유저 관전 화면에 시간바와 트랙이 그려진다", () => {
    open(liveClock(0.5));
    expect(screen.getByTestId("viewer-seek-bar-half2")).toBeTruthy();
    expect(bar().tagName).toBe("INPUT");
    // QA 도구는 여전히 없다 — 이 웨이브가 연 것은 **시크바 하나**다.
    expect(screen.queryByTestId("viewer-play-toggle-half2")).toBeNull();
    expect(screen.queryByTestId("viewer-speed-2-half2")).toBeNull();
    expect(screen.queryByTestId("viewer-scrub-half2"), "QA 스크럽은 여전히 admin 전용").toBeNull();
  });

  it("스냅샷이 1개 이하인 로그에는 바를 만들지 않는다(이동할 곳이 없다)", () => {
    open(liveClock(0.5));
    act(() => {
      chromeOf().onLoaded!({ events: [], snapCount: 1, statusText: "" });
    });
    expect(screen.queryByTestId("viewer-seek-bar-half2")).toBeNull();
  });
});

describe("#406 W3 ② 슬라이더가 덮는 최대치 = 라이브 헤드", () => {
  it("라이브면 max 가 상한 인덱스다 — snapCount-1 이 아니다(바 오른쪽 끝 = 스포일러였다)", () => {
    open(liveClock(0.5));
    expect(bar().max).toBe(String(LIVE_IDX));
    expect(bar().max).not.toBe(String(SNAP_COUNT - 1));
    // 미래 구간(빗금)이 실제로 그려진다 = 오른쪽이 잠겼다는 신호가 화면에 있다.
    expect((screen.getByTestId("viewer-seek-future-half2") as HTMLElement).hidden).toBe(false);
  });

  it("종료(시계 없음)면 전 구간이 슬라이더고 잠긴 구간이 없다 — 같은 부품, 잠금만 빠진다", () => {
    open(null);
    expect(bar().max).toBe(String(SNAP_COUNT - 1));
    expect((screen.getByTestId("viewer-seek-future-half2") as HTMLElement).hidden).toBe(true);
    expect((screen.getByTestId("viewer-seek-live-half2") as HTMLElement).hidden).toBe(true);
    // 끝까지 이동해도 잘리지 않는다(전체 이동 — 요구 5-3 후반부).
    fireEvent.input(bar(), { target: { value: String(SNAP_COUNT - 1) } });
    expect(viewer.scrubTo).toHaveBeenLastCalledWith(100);
  });

  it("라이브 상한이 흐르면 max 도 따라 늘어난다(250ms 게이트 폴링)", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    const before = Number(bar().max);
    act(() => {
      // 실시간이 흐르면 상한도 흐른다 — 창의 10% ≈ 인덱스 10.
      vi.advanceTimersByTime(HALF_REAL_MS * 0.1);
    });
    expect(Number(bar().max)).toBeGreaterThan(before);
  });
});

describe("#406 W3 ③ clamp 층 — max 를 뚫어도 미래로 안 간다", () => {
  /**
   * **변이체를 이 테스트 안에서 직접 만든다.** `max` 를 `snapCount-1` 로 되돌리는 것이 가장 그럴듯한
   * 회귀(=예전 코드)인데, 그 상태에서도 값은 `seek.toIndex` 의 `clampSeek` 를 지나야 한다.
   * 두 층이 각각 살아 있는지를 ②·③ 이 나눠서 죽인다.
   */
  it("max 를 트랙 끝으로 되돌려도 상한 + grace 를 넘지 못한다", () => {
    open(liveClock(0.5));
    bar().max = String(SNAP_COUNT - 1); // ← 변이체
    fireEvent.input(bar(), { target: { value: String(SNAP_COUNT - 1) } });
    const pct = viewer.scrubTo.mock.calls.at(-1)?.[0] as number;
    const idx = Math.round((pct / 100) * (SNAP_COUNT - 1));
    expect(idx, `clamp 층이 없다 — 인덱스 ${idx} 로 갔다`).toBeLessThanOrEqual(LIVE_IDX + GRACE_IDX);
  });

  it("QA 초 스텝(#180)도 같은 상한을 지난다 — 도구 경로만 미래로 새지 않는다", () => {
    window.history.replaceState({}, "", "/match/m1?viewerControls=full");
    open(liveClock(0.5), H2_FIRST_TICK + LIVE_IDX);
    fireEvent.click(screen.getByTestId("viewer-step-plus5s-half2"));
    // 현재 2750 에서 +5초 = 2755(인덱스 55) → 상한 50 + grace 2 = 인덱스 52 = 틱 2752.
    expect(viewer.seek).toHaveBeenLastCalledWith(H2_FIRST_TICK + LIVE_IDX + GRACE_IDX);
  });

  it("뒤로는 자유다 — 상한을 걸었다고 되감기까지 막지 않는다", () => {
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: "10" } });
    const pct = viewer.scrubTo.mock.calls.at(-1)?.[0] as number;
    expect(Math.round((pct / 100) * (SNAP_COUNT - 1))).toBe(10);
  });
});

/*
 * ⚠️ 이 갈래는 원래 *"미래 핀은 **흐리고**, 눌러도 안 간다"* 였다 — `dataset.future === "true"` 를
 *    단언하며 `opacity: .28` 결함을 **계약이 박제**하고 있었다. 흐린 핀도 DOM 에 남아
 *    `title`/`aria-label`(`30' · HOME GOAL`)로 아직 안 온 골이 읽혔다(독립검증 blocker).
 *    지금은 **DOM 부재**로 잰다 — 감추는 수단이 스타일이면 스타일을 되돌리는 변이체가 곧 스포일러다.
 */
describe("#406 W3 ④ 미래 핀 — DOM 에 없다(흐린 게 아니다), 상한이 흐르면 나타난다", () => {
  it("아직 안 온 장면 핀은 **만들지 않는다** — 지난 핀은 그대로 있다", () => {
    open(liveClock(0.5));
    expect(
      screen.queryByTestId(`viewer-seek-pin-${FUTURE_PIN_TICK}`),
      "미래 골 핀이 DOM 에 있다 = 라벨·색·위치로 읽힌다",
    ).toBeNull();
    // 양성 단언 — 핀을 통째로 안 그리는 변이체가 위 부재 단언을 통과하지 못하게.
    expect(screen.getByTestId(`viewer-seek-pin-${PAST_PIN_TICK}`)).toBeTruthy();
  });

  it("라벨(`aria-label`/`title`)에도 미래 장면 문구가 없다", () => {
    open(liveClock(0.5));
    const bar = screen.getByTestId("viewer-seek-bar-half2");
    const labels = [...bar.querySelectorAll("[aria-label],[title]")].map(
      (el) => `${el.getAttribute("aria-label") ?? ""}|${el.getAttribute("title") ?? ""}`,
    );
    // 픽스처의 미래 핀은 away 골 하나다(`buildTimelinePins` 라벨 = `<분>' · AWAY GOAL`).
    expect(labels.join(" ")).not.toContain("AWAY GOAL");
    expect(labels.join(" "), "지난 홈 골 라벨까지 사라졌다 = 스캔이 공허하다").toContain("HOME GOAL");
  });

  it("상한이 흐르면 그 핀이 **나타난다** — 감추는 게 아니라 아직 안 온 것이다", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    expect(screen.queryByTestId(`viewer-seek-pin-${FUTURE_PIN_TICK}`)).toBeNull();
    act(() => {
      // 창의 45% 더 흐르면 상한이 인덱스 90 을 넘는다(라이브는 유지 — 100% 를 넘기지 않는다).
      vi.advanceTimersByTime(HALF_REAL_MS * 0.45);
    });
    expect(
      screen.getByTestId(`viewer-seek-pin-${FUTURE_PIN_TICK}`),
      "상한이 흘렀는데 핀이 안 나타난다 = 영영 감추고 있다",
    ).toBeTruthy();
  });

  it("지난 핀은 그대로 열린다 — 잠금이 기능을 통째로 막지 않는다", () => {
    open(liveClock(0.5));
    fireEvent.click(screen.getByTestId(`viewer-seek-pin-${PAST_PIN_TICK}`));
    expect(viewer.jumpToTick).toHaveBeenLastCalledWith(PAST_PIN_TICK);
  });

  /**
   * **두 번째 층** — 렌더 필터가 없어도 `seek.toScene` 이 거부한다. 시크바 핀을 손으로 만들 수는
   * 없으니 표본은 **필터가 없는 실제 호출부**, 즉 QA 풀컨트롤의 타임라인 핀(`viewer-pin-*`)이다.
   * (⚠️ 그 도구가 미래 핀을 **여전히 라벨째 그린다**는 사실도 이 표본이 문서화한다 — 시크바와 달리
   *  QA/admin 경로라 이 웨이브 스코프 밖이고, 별도 이슈 대상이다.)
   */
  it("렌더 필터가 없는 경로로 눌러도 `seek.toScene` 이 미래 장면을 거부한다", () => {
    window.history.replaceState({}, "", "/match/m1?viewerControls=full");
    open(liveClock(0.5));
    fireEvent.click(screen.getByTestId(`viewer-pin-${FUTURE_PIN_TICK}`));
    expect(viewer.jumpToTick, "아직 안 온 장면이 열렸다").not.toHaveBeenCalled();
  });

  it("종료 화면에서는 모든 핀이 열린다", () => {
    open(null);
    expect(screen.getByTestId(`viewer-seek-pin-${FUTURE_PIN_TICK}`)).toBeTruthy();
    fireEvent.click(screen.getByTestId(`viewer-seek-pin-${FUTURE_PIN_TICK}`));
    expect(viewer.jumpToTick).toHaveBeenLastCalledWith(FUTURE_PIN_TICK);
  });
});

describe("#406 W3 ⑤ 과거 모드 — 배지·[현재로]·복구 루프 억제", () => {
  it("뒤로 끌면 배지와 [현재로] 가 뜬다", () => {
    open(liveClock(0.5));
    expect(badge().hidden, "처음엔 라이브를 따라간다").toBe(true);
    fireEvent.input(bar(), { target: { value: "10" } });
    expect(badge().hidden).toBe(false);
    expect(nowBtn().hidden).toBe(false);
  });

  it("헤드에 붙은 채로 만지면 배지가 뜨지 않는다(바 끝을 잡은 유저를 과거 취급하지 않는다)", () => {
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: String(LIVE_IDX) } });
    expect(badge().hidden).toBe(true);
  });

  /*
   * ⚠️ 이 아래 두 건은 원래 **한 건**이었고 **공허했다**(독립검증 M-1): 되감아 둔 헤드로는 회수 조건
   *    (`curIdx > clamp(curIdx) + drift`)이 애초에 거짓이라, `if (pastModeRef.current) …return` 억제
   *    블록을 통째로 지워도 통과했다. 억제가 **실제로 일하는** 조건은 헤드가 상한을 앞설 때뿐이다 —
   *    그 표본(⑤-2)과, 그게 공허하지 않음을 보증하는 **대조군**(⑤-3)으로 갈랐다.
   */
  it("⑤-1 되감은 위치와 배지가 폴링 4회를 견딘다 (hero 확정 ③=B: 자동 복귀 없음)", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: "10" } });
    // 뒤로 간 뒤엔 코어도 그 자리에서 재생한다.
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 10, tickPosIdx: 10 });
    viewer.jumpToTick.mockClear();
    act(() => {
      vi.advanceTimersByTime(1000); // 폴링 4회
    });
    expect(viewer.jumpToTick, "과거로 돌려놨는데 현재로 튕겨 왔다").not.toHaveBeenCalled();
    expect(badge().hidden, "여전히 과거 보는 중").toBe(false);
  });

  it("⑤-2 헤드가 상한을 앞선 순간에도 과거 모드면 회수 점프가 발화하지 않는다(억제가 일하는 유일한 조건)", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: "10" } }); // 과거 모드 진입
    // 코어 플레이헤드만 상한 너머로 흘렀다고 알린다 — 이 조합에서만 회수 분기가 살아 있다.
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 95, tickPosIdx: 95 });
    viewer.jumpToTick.mockClear();
    act(() => {
      vi.advanceTimersByTime(250); // 폴링 1회
    });
    expect(viewer.jumpToTick, "과거 모드인데 회수 점프가 발화했다 = 억제가 없다").not.toHaveBeenCalled();
  });

  it("⑤-3 대조군 — 같은 헤드라도 라이브를 따라가는 중이면 회수 점프가 발화한다(⑤-2 가 공허하지 않다)", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 95, tickPosIdx: 95 });
    viewer.jumpToTick.mockClear();
    act(() => {
      vi.advanceTimersByTime(250);
    });
    expect(viewer.jumpToTick, "회수 경로 자체가 안 돈다 — 대조군이 성립하지 않는다").toHaveBeenCalled();
  });

  it("[현재로] 를 누르면 라이브 헤드로 돌아가고 추종이 재개된다", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: "10" } });
    viewer.jumpToTick.mockClear();

    fireEvent.click(nowBtn());
    const target = viewer.jumpToTick.mock.calls.at(-1)?.[0] as number;
    expect(target, "인덱스가 아니라 절대 틱으로 가야 한다").toBeGreaterThanOrEqual(H2_FIRST_TICK + LIVE_IDX);
    expect(viewer.play).toHaveBeenCalled();
    expect(badge().hidden).toBe(true);
    expect(nowBtn().hidden).toBe(true);

    // 복귀 뒤에는 원래 동작(회수 점프)이 되살아난다 — 억제가 고착되지 않는다.
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 95, tickPosIdx: 95 });
    viewer.jumpToTick.mockClear();
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(viewer.jumpToTick, "복귀 후에도 앞서보기 회수가 죽어 있다").toHaveBeenCalled();
  });

  it("재생이 스스로 라이브 헤드를 따라잡으면 배지가 꺼진다(영영 켜져 있지 않다)", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: "10" } });
    expect(badge().hidden).toBe(false);
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + LIVE_IDX, tickPosIdx: LIVE_IDX });
    act(() => {
      vi.advanceTimersByTime(300);
    });
    expect(badge().hidden).toBe(true);
  });

  it("⚠️ 과거를 다녀와도 상한이 헐거워지지 않는다 — 미래 핀은 그대로 잠겨 있다", () => {
    vi.useFakeTimers();
    open(liveClock(0.5));
    fireEvent.input(bar(), { target: { value: "5" } });
    fireEvent.click(nowBtn());
    viewer.jumpToTick.mockClear();

    // 왕복 뒤에도 ②③④ 가 전부 그대로여야 한다.
    expect(Number(bar().max)).toBeLessThanOrEqual(LIVE_IDX + GRACE_IDX);
    expect(
      screen.queryByTestId(`viewer-seek-pin-${FUTURE_PIN_TICK}`),
      "왕복 뒤 미래 핀이 되살아났다",
    ).toBeNull();
    // 지난 핀은 계속 열린다 — 왕복이 핀 기능을 통째로 죽인 게 아니다.
    fireEvent.click(screen.getByTestId(`viewer-seek-pin-${PAST_PIN_TICK}`));
    expect(viewer.jumpToTick).toHaveBeenLastCalledWith(PAST_PIN_TICK);
  });

  /**
   * 게이트 effect 는 **단계 창이 갱신될 때 다시 돈다**(`clock.phaseStartAt` 의존). 그 진입부에도
   * seek-to-now 점프가 있어서, 과거 예외가 없으면 서버가 창을 한 번 다시 내려주는 것만으로 유저가
   * 보던 장면이 이유 없이 현재로 튄다. 변이 검증에서 **이 갈래만 살아남아** 뒤늦게 채운 계약이다.
   *
   * ⚠️ 대조군이 필수다 — "안 불렸다"는 effect 가 애초에 안 돌아서일 수도 있다(공허한 계약).
   */
  it("단계 창이 갱신돼도 과거를 보는 중이면 입장 점프를 하지 않는다", () => {
    const c1 = liveClock(0.5);
    const r = open(c1);
    fireEvent.input(bar(), { target: { value: "10" } });
    viewer.jumpToTick.mockClear();

    const c2 = { ...c1, phaseStartAt: new Date(Date.parse(c1.phaseStartAt) + 1000).toISOString() };
    act(() => {
      r.rerender(tree(c2));
    });
    expect(viewer.jumpToTick, "과거를 보는 중인데 창 갱신이 현재로 끌어당겼다").not.toHaveBeenCalled();
    expect(badge().hidden).toBe(false);
  });

  it("대조군 — 라이브를 따라가는 중이면 창 갱신이 그대로 seek-to-now 를 한다", () => {
    const c1 = liveClock(0.5);
    const r = open(c1);
    const c2 = { ...c1, phaseStartAt: new Date(Date.parse(c1.phaseStartAt) + 1000).toISOString() };
    act(() => {
      r.rerender(tree(c2));
    });
    expect(viewer.jumpToTick, "창이 갱신되면 effect 가 다시 돌아야 한다 — 안 돌면 위 계약이 공허하다").toHaveBeenCalled();
  });

  it("종료 화면에는 배지·[현재로] 가 아예 뜨지 않는다(돌아갈 '현재'가 없다)", () => {
    open(null);
    fireEvent.input(bar(), { target: { value: "5" } });
    expect(badge().hidden).toBe(true);
    expect(nowBtn().hidden).toBe(true);
  });
});

describe("#406 W3 — 재생 헤드 표시가 코어를 따라간다", () => {
  it("코어 onScrub 이 오면 슬라이더 값이 그 인덱스로 간다(같은 신호를 두 곳이 쓴다)", () => {
    open(liveClock(0.5));
    headMovesTo(30);
    expect(bar().value).toBe("30");
  });

  it("헤드가 상한을 살짝 앞서도 슬라이더 값은 상한을 넘지 않는다", () => {
    open(liveClock(0.5));
    headMovesTo(SNAP_COUNT - 1);
    expect(Number(bar().value)).toBeLessThanOrEqual(LIVE_IDX + GRACE_IDX);
  });
});
