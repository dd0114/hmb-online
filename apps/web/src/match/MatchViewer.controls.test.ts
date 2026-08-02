// @vitest-environment jsdom
/**
 * 매치 화면 재생 컨트롤 계약 (#148, #169 S3 직접 마운트, #216 하이라이트 단일화).
 *  - 플레이 모드(일반 유저): **컨트롤 없음**. 경기는 하이라이트 연출로 자동 진행된다.
 *    (#216 전에는 하이라이트 토글이 있었다 — 끔 모드 렌더가 깨진 채였고 라이브 재생이 그 경로를
 *     강제로 탔다. 끔 경로를 지우면서 끌 수단도 함께 사라졌다.)
 *  - admin/QA 모드: 코어 풀컨트롤(재생·배속·스크럽·프레임점프) + 모드 전환 토글.
 *
 * S3: iframe·postMessage 제거 — web 이 viewer-core 를 직접 마운트한다. jsdom 엔 canvas 2D 가
 * 없으므로 createViewer 를 목킹해 **컨트롤 계약만** 검증한다(렌더 엔진은 e2e·dev-viewer 가 담보).
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminFlagContext } from "../admin/admin-flag";
import { CONTROL_MODE_STORAGE_KEY } from "./playback-controls";

// 코어 목 — 컨트롤이 부르는 메서드를 관찰한다. hooks 는 window.__viewer 로 노출된다.
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
    seek: vi.fn(),
    scrubTo: vi.fn(),
    hooks,
  };
});
const createViewer = vi.hoisted(() => vi.fn(() => viewer));
vi.mock("@hmb/viewer-core", () => ({ createViewer }));

const fx = {
  log: { tickSnapshots: [], events: [], finalScore: { home: 0, away: 0 } } as unknown,
  /** `/api/players` 응답 — **형태를 바꿔 끼울 수 있게** 둔다(아래 손상 응답 계약). */
  players: [] as unknown,
};
vi.mock("../api/hooks", () => ({
  useHalfLog: () => ({ data: fx.log, isLoading: false, isError: false }),
  // 아이콘 노출 정책(#285) 등급표의 출처. 이 스펙은 컨트롤 계약만 보므로 기본은 빈 카탈로그다.
  usePlayers: () => ({ data: fx.players }),
}));

import { MatchViewer } from "./MatchViewer";

function renderViewer(isAdmin: boolean) {
  return render(
    h(
      AdminFlagContext.Provider,
      { value: isAdmin },
      h(MatchViewer, { matchId: "m1", half: 1 as const, homeName: "홈", awayName: "원정" }),
    ),
  );
}

beforeEach(() => {
  window.history.replaceState({}, "", "/match/m1");
  window.localStorage.clear();
  createViewer.mockClear();
  fx.log = { tickSnapshots: [], events: [], finalScore: { home: 0, away: 0 } } as unknown;
  for (const fn of [viewer.setAutoPace, viewer.setSpeed, viewer.load, viewer.start, viewer.seek, viewer.scrubTo, viewer.jumpToTick, viewer.play]) fn.mockClear();
  for (const k of Object.keys(viewer.hooks)) delete viewer.hooks[k];
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MatchViewer 컨트롤 — 플레이 모드(일반 유저)", () => {
  it("코어를 canvas 에 직접 마운트한다(iframe 없음)", () => {
    renderViewer(false);
    // iframe 은 사라졌다 — React 캔버스에 코어를 직접 붙인다.
    expect(screen.queryByTitle("전반 경기 재생")).toBeNull();
    expect(screen.getByTestId("viewer-canvas-half1").tagName).toBe("CANVAS");
    expect(createViewer).toHaveBeenCalledTimes(1);
    expect(viewer.load).toHaveBeenCalledWith(fx.log);
    // QA/e2e 훅 노출.
    expect((window as unknown as { __viewer?: unknown }).__viewer).toBe(viewer.hooks);
  });

  /**
   * ⚠️ **이 계약은 #406 W3 에서 좁혀졌다.** 예전 문장은 "플레이 모드 컨트롤 바에는 버튼이 0개"였는데,
   * 요구 5-3(과거 전용 시크바)이 유저용 시간바를 그 자리에 넣었다 — 정책이 바뀐 것이지 잊어서 깨진 게
   * 아니다(apps/web CLAUDE.md §계약이 거짓말하는 방식 8: 도달 불가가 된 계약은 지우지 말고 **지금 참인
   * 것**으로 다시 쓴다). 남아 있는 규칙은 **"QA 도구는 관객 화면에 없다"** 다.
   * ⚠️ 표본이 계약의 절반이다 — 이 스펙 기본 픽스처는 스냅샷 0개라 시크바가 애초에 안 그려진다.
   *    그 픽스처로 재면 QA 도구가 되살아나도 통과할 수 있어, 여기서는 **스냅샷 있는 로그**로 잰다.
   */
  it("플레이 모드엔 QA 도구가 없다 — 유저 시크바만 있다(#216 · #406 W3)", () => {
    fx.log = {
      tickSnapshots: Array.from({ length: 60 }, (_, i) => ({ tick: i })),
      events: [],
      finalScore: { home: 0, away: 0 },
    } as unknown;
    renderViewer(false);
    act(() => {
      const chrome = (createViewer.mock.calls[0] as unknown as unknown[])[1] as {
        onLoaded?: (info: { events: unknown[]; snapCount: number; statusText: string }) => void;
      };
      chrome.onLoaded!({ events: [], snapCount: 60, statusText: "" });
    });

    expect(screen.queryByTestId("viewer-highlight-toggle-half1")).toBeNull();
    // 경기는 자동 진행 — 재생/일시정지·배속·프레임점프·mm:ss·모드토글은 아예 없다.
    expect(screen.queryByTestId("viewer-play-toggle-half1")).toBeNull();
    for (const s of [1, 2, 4]) expect(screen.queryByTestId(`viewer-speed-${s}-half1`)).toBeNull();
    expect(screen.queryByTestId("viewer-scrub-half1"), "QA 스크럽은 admin 전용").toBeNull();
    expect(screen.queryByTestId("viewer-prev-goal-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-goto-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-mode-toggle-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-admin-half1"), "풀컨트롤 묶음 자체가 없다").toBeNull();
    // 그 자리에 있는 유일한 컨트롤 = 과거 전용 시크바(#406 W3).
    expect(screen.getByTestId("viewer-seek-bar-half1")).toBeTruthy();
  });

  /**
   * #216 의 핵심 계약. 하이라이트(autoPace)는 **켬이 유일 모드**다 — 화면 어디에도 끄는 경로가
   * 없어야 한다. 버튼만 지우고 코드에 `setAutoPace(false)` 가 남으면(예전 라이브 게이트가 그랬다)
   * 유저는 다시 깨진 렌더를 보게 된다.
   */
  it("web 은 코어 연출을 절대 끄지 않는다 — setAutoPace(false) 호출 0", () => {
    renderViewer(false);
    expect(viewer.setAutoPace).not.toHaveBeenCalledWith(false);
  });

  it("마운트가 배속을 건드리지 않는다 — speed 는 이제 연출 위의 배율이라 4 를 박으면 연출이 4배가 된다", () => {
    renderViewer(false);
    expect(viewer.setSpeed).not.toHaveBeenCalledWith(4);
  });
});

describe("MatchViewer 컨트롤 — admin/QA 모드", () => {
  it("admin 계정(#119)은 코어 풀컨트롤 + 모드 전환 토글, 하이라이트 토글 없음", () => {
    renderViewer(true);
    expect(screen.getByTestId("viewer-mode-toggle-half1")).toBeTruthy();
    // 풀컨트롤: 재생/정지·배속·스크럽·골점프.
    expect(screen.getByTestId("viewer-play-toggle-half1")).toBeTruthy();
    expect(screen.getByTestId("viewer-speed-0.25-half1")).toBeTruthy();
    expect(screen.getByTestId("viewer-scrub-half1")).toBeTruthy();
    expect(screen.getByTestId("viewer-prev-goal-half1")).toBeTruthy();
    // 하이라이트 토글은 플레이·풀컨트롤 어느 쪽에도 없다(#216 끔 경로 제거).
    expect(screen.queryByTestId("viewer-highlight-toggle-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-highlight-admin-half1")).toBeNull();
  });

  it("QA 플래그(?viewerControls=full)면 비admin 도 풀컨트롤", () => {
    window.history.replaceState({}, "", "/match/m1?viewerControls=full");
    renderViewer(false);
    expect(screen.getByTestId("viewer-scrub-half1")).toBeTruthy();
    expect(screen.getByTestId("viewer-mode-toggle-half1")).toBeTruthy();
  });

  it("풀컨트롤 버튼이 코어 컨트롤러를 직접 조작한다", () => {
    renderViewer(true);
    fireEvent.click(screen.getByTestId("viewer-play-toggle-half1"));
    expect(viewer.togglePlay).toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("viewer-speed-2-half1"));
    expect(viewer.setSpeed).toHaveBeenLastCalledWith(2);
    fireEvent.click(screen.getByTestId("viewer-next-goal-half1"));
    expect(viewer.jumpEvent).toHaveBeenLastCalledWith("goal", 1);
  });

  it("모드 토글로 플레이어 체감(간소)으로 전환 — QA 컨트롤이 사라지고 저장한다", () => {
    renderViewer(true);
    fireEvent.click(screen.getByTestId("viewer-mode-play-half1"));
    expect(screen.queryByTestId("viewer-scrub-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-play-toggle-half1")).toBeNull();
    expect(window.localStorage.getItem(CONTROL_MODE_STORAGE_KEY)).toBe("play");
  });
});

/**
 * QA 관전 도구 (#177). hero: "QA는 시간도 볼 수 있어야 한다 — 몇 분 몇 초에 뭐가 있었는지 +
 * 돌려보면서 눈으로 QA". S3(iframe 제거)에서 코어의 onClock/onScrub/onLoaded 를 호스트가 안 받아
 * 유실됐던 것들이라, 여기서 **크롬 콜백 배선 자체**를 계약으로 박제한다.
 */
describe("MatchViewer — QA 시계·스크럽·타임라인 핀(#177)", () => {
  /** 코어에 넘긴 chrome 콜백 — 코어가 프레임마다 부르는 것을 테스트가 대신 부른다. */
  function chromeOf() {
    return (createViewer.mock.calls[0] as unknown as unknown[])[1] as {
      onClock?: (s: string) => void;
      onScrub?: (pct: number) => void;
      onLoaded?: (info: { events: unknown[]; snapCount: number; statusText: string }) => void;
    };
  }

  it("코어 시계(onClock)가 QA 바에 분:초로 표시된다", () => {
    renderViewer(true);
    chromeOf().onClock!(`12'34" / 24'00"`);
    expect(screen.getByTestId("viewer-clock-half1").textContent).toBe(`12'34" / 24'00"`);
  });

  it("스크럽 핸들이 재생 위치(onScrub)를 따라간다 — 눈금은 스냅샷 인덱스(초 스냅, #180)", () => {
    renderViewer(true);
    act(() => {
      chromeOf().onLoaded!({ events: [], snapCount: 201, statusText: "" });
    });
    chromeOf().onScrub!(50); // 50% of 200 = 인덱스 100
    expect((screen.getByTestId("viewer-scrub-half1") as HTMLInputElement).value).toBe("100");
    expect(screen.getByTestId("viewer-scrub-half1").getAttribute("max")).toBe("200");
    expect(screen.getByTestId("viewer-scrub-half1").getAttribute("step")).toBe("1");
  });

  it("타임라인에 키 장면 핀이 찍히고, 클릭하면 그 틱으로 점프한다", () => {
    renderViewer(true);
    act(() => {
      chromeOf().onLoaded!({
        events: [
          { tick: 300, type: "goal", team: "home" },
          { tick: 450, type: "save", team: "away" },
          { tick: 500, type: "pass", team: "home" }, // 핀 아님
        ],
        snapCount: 601,
        statusText: "",
      });
    });
    expect(screen.queryByTestId("viewer-pin-500")).toBeNull();
    const goalPin = screen.getByTestId("viewer-pin-300");
    expect(goalPin.getAttribute("title")).toContain(`5'00"`);
    expect(screen.getByTestId("viewer-pin-450")).toBeTruthy();

    fireEvent.click(goalPin);
    expect(viewer.jumpToTick).toHaveBeenLastCalledWith(300);
  });

  it("플레이 모드에는 QA 도구를 노출하지 않는다(관객 화면 유지)", () => {
    renderViewer(false);
    chromeOf().onClock!(`1'00" / 24'00"`);
    expect(screen.queryByTestId("viewer-clock-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-timeline-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-step-plus1s-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-goto-half1")).toBeNull();
  });
});

/**
 * 초단위 시간 컨트롤 (#180). hero: "게임속도가 빨라 틱단위로 짚기 어렵다 — 정확한 초에 멈춰
 * 'mm:ss 에 X 발생' 이라 말할 수 있어야 한다."
 * **정확도 계약**: 정밀 이동은 코어 `hooks.seek(tick)` 로만 한다. `jumpToTick` 은 맥락용으로
 * 3 스냅샷 되감기 때문에(viewer.impl.mjs) "그 초에 멈춘다"를 만족하지 못한다.
 */
describe("MatchViewer — 초단위 시간 컨트롤(#180)", () => {
  function chromeOf() {
    return (createViewer.mock.calls[0] as unknown as unknown[])[1] as {
      onLoaded?: (info: { events: unknown[]; snapCount: number; statusText: string }) => void;
    };
  }
  /** 코어 훅 목 — 현재 위치(cur)와 정밀 이동(seek)을 관찰한다. */
  function stubHooks(curTick: number, snapCount = 5401) {
    viewer.hooks.cur = () => ({ tick: curTick, tickPosIdx: curTick });
    viewer.hooks.seek = viewer.seek;
    viewer.hooks.idxOfTick = (t: number) => t;
    act(() => {
      chromeOf().onLoaded!({ events: [], snapCount, statusText: "" });
    });
  }

  it("±1초 / ±5초 버튼이 현재 위치 기준으로 **정확히** 그 초로 seek 한다", () => {
    renderViewer(true);
    stubHooks(754);
    fireEvent.click(screen.getByTestId("viewer-step-plus1s-half1"));
    expect(viewer.seek).toHaveBeenLastCalledWith(755);
    fireEvent.click(screen.getByTestId("viewer-step-minus1s-half1"));
    expect(viewer.seek).toHaveBeenLastCalledWith(753);
    fireEvent.click(screen.getByTestId("viewer-step-plus5s-half1"));
    expect(viewer.seek).toHaveBeenLastCalledWith(759);
    fireEvent.click(screen.getByTestId("viewer-step-minus5s-half1"));
    expect(viewer.seek).toHaveBeenLastCalledWith(749);
    // 맥락용 되감기(jumpToTick)를 쓰면 안 된다 — 그 초에 안 선다.
    expect(viewer.jumpToTick).not.toHaveBeenCalled();
  });

  it("±1프레임(스냅샷) 미세 스텝은 인덱스로 스크럽한다", () => {
    renderViewer(true);
    stubHooks(100, 201);
    fireEvent.click(screen.getByTestId("viewer-step-plus1f-half1"));
    // 인덱스 100 → 101 = 50.5%
    expect(viewer.scrubTo).toHaveBeenLastCalledWith(50.5);
  });

  it("mm:ss 입력으로 그 시각에 정확히 멈춘다", () => {
    renderViewer(true);
    stubHooks(0);
    const input = screen.getByTestId("viewer-goto-half1") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "12:34" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(viewer.seek).toHaveBeenLastCalledWith(754);
  });

  it("경기 끝을 넘어가지 않는다", () => {
    renderViewer(true);
    stubHooks(5399, 5401); // 마지막 틱
    fireEvent.click(screen.getByTestId("viewer-step-plus5s-half1"));
    expect(viewer.seek).toHaveBeenLastCalledWith(5400);
  });

  it("키보드: ←/→ 로 ∓1초, Shift 로 ∓5초 (QA 모드에서만)", () => {
    renderViewer(true);
    stubHooks(754);
    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(viewer.seek).toHaveBeenLastCalledWith(755);
    fireEvent.keyDown(window, { key: "ArrowLeft", shiftKey: true });
    expect(viewer.seek).toHaveBeenLastCalledWith(749);
  });

  it("느린 배속(0.1x)도 고를 수 있다 — 한 초를 눈으로 따라가려면 필요", () => {
    renderViewer(true);
    fireEvent.click(screen.getByTestId("viewer-speed-0.1-half1"));
    expect(viewer.setSpeed).toHaveBeenLastCalledWith(0.1);
  });

  /**
   * #216: 배속은 이제 연출을 **끄지 않는다**. 코어가 `eff = autoPace ? (HL|CRUISE) * speed : speed`
   * 로 바뀌어 배속이 연출 위의 배율이 됐다 — QA 가 속도를 잡으면서도 하이라이트 슬로우를 유지한다.
   * (구 계약은 "배속을 고르면 autoPace 를 끈다" 였고, 그게 web 에 남은 마지막 끔 경로였다.)
   */
  it("배속을 골라도 연출을 끄지 않는다 — 배율만 바뀐다", () => {
    renderViewer(true);
    fireEvent.click(screen.getByTestId("viewer-speed-0.25-half1"));
    expect(viewer.setSpeed).toHaveBeenLastCalledWith(0.25);
    expect(viewer.setAutoPace).not.toHaveBeenCalledWith(false);
  });
});

/**
 * 라이브 게이트 (#170 W3 → #216 재정합). 두 가지가 계약이다.
 *  ① 라이브에서도 **연출을 끄지 않는다** — 구현 당시엔 여기서 autoPace 를 껐고, 그래서 유저의
 *     실경기는 항상 "하이라이트 끔"(렌더가 깨진 그 경로)이었다.
 *  ② 서버 시계는 **스냅샷 인덱스**로 말하고 뷰어는 **절대 틱**으로 움직인다. 후반 로그는 틱이
 *     2700 부터 시작하므로 둘을 섞으면 seek-to-now 가 로그 맨 앞으로 가고(=후반이 늘 0분부터),
 *     상한 비교가 항상 참이 되어 매 250ms 되감긴다(=후반 재생 정지).
 */
describe("MatchViewer — 라이브 게이트(#216)", () => {
  const HALF_REAL_MS = 420_000;
  /** 후반 로그: 100 스냅샷, 틱은 2700..2799(엔진이 하프를 이어 붙인 그대로). */
  const H2_FIRST_TICK = 2700;
  const h2Log = {
    tickSnapshots: Array.from({ length: 100 }, (_, i) => ({ tick: H2_FIRST_TICK + i })),
    events: [],
    finalScore: { home: 0, away: 0 },
  } as unknown;

  function liveClock(phase: "FIRST_HALF" | "SECOND_HALF", elapsedMs: number) {
    const now = Date.now();
    const startAt = new Date(now - elapsedMs).toISOString();
    return {
      phase,
      kickoffAt: startAt,
      phaseStartAt: startAt,
      phaseEndsAt: new Date(now - elapsedMs + HALF_REAL_MS).toISOString(),
      serverNow: new Date(now).toISOString(),
      halfRealMs: HALF_REAL_MS,
      halftimeMs: 180_000,
      seekForwardBlocked: true,
      seekGraceMs: 1500,
    };
  }

  function renderLive(half: 1 | 2, clock: ReturnType<typeof liveClock>) {
    return render(
      h(
        AdminFlagContext.Provider,
        { value: false },
        h(MatchViewer, { matchId: "m1", half, homeName: "홈", awayName: "원정", clock }),
      ),
    );
  }

  it("후반 seek-to-now 가 **절대 틱**으로 점프한다(인덱스를 그대로 넘기면 로그 맨 앞으로 간다)", () => {
    fx.log = h2Log;
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK, tickPosIdx: 0 });
    renderLive(2, liveClock("SECOND_HALF", HALF_REAL_MS / 2)); // 절반 경과

    const target = viewer.jumpToTick.mock.calls.at(-1)?.[0] as number;
    expect(target, "인덱스 50 이 아니라 틱 2750 근처여야 한다").toBeGreaterThan(H2_FIRST_TICK + 40);
    expect(target).toBeLessThan(H2_FIRST_TICK + 60);
  });

  it("라이브에서도 연출(autoPace)을 끄지 않는다", () => {
    fx.log = h2Log;
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK, tickPosIdx: 0 });
    renderLive(2, liveClock("SECOND_HALF", 10_000));
    expect(viewer.setAutoPace).not.toHaveBeenCalledWith(false);
    // 재생은 시작하되 압축비를 speed 에 직접 꽂지 않는다(코어 1x = 2게임초/실초라 두 배가 됐던 자리).
    expect(viewer.play).toHaveBeenCalled();
  });

  /**
   * #216 AC2 의 **기계장치** 계약. `paceRate` 를 순수 함수로만 박제하면, 그 값을 코어에 거는
   * 한 줄(`v.setSpeed(paceRate(...))`)을 지워도 아무도 안 죽는다 — 그러면 hero 가 본 증상이
   * 조용히 돌아온다(자연 페이스와 창의 오차가 하프 내내 누적). 그래서 **코어에 실제로 걸리는지**를
   * 여기서 본다. 독립검증 major-1.
   */
  // ⚠️ #365(hero 확정 "고정 배속만, 가변 보정 안 쓴다"): 아래 두 계약은 **뒤집혔다**.
  // 예전엔 `paceRate` 가 창과 재생의 차이를 배율로 흡수했는데, 이제 서버 창이 **그 하프의 실제
  // 재생 길이**라(러너가 viewer-core 페이싱 모델로 재서 준다) 흡수할 오차가 없다.
  // 그래서 계약도 "배율을 건다" → **"배율을 건드리지 않는다"** 로 뒤집는다.
  // 되감기가 되살아나지 않는 근거(자연 재생의 선형 게이트 대비 최대 앞섬 4.2% < 허용 12%)는
  // `tools/pace-config.test.ts` 가 엔진으로 직접 재서 지킨다 — 여기서는 **배선**만 본다.
  it("뒤처져 있어도 배율을 건드리지 않는다 (#365 고정 배속만)", () => {
    fx.log = h2Log;
    // 창은 절반 지났는데 재생은 10% — 예전이면 배율 > 1 로 따라잡던 자리다.
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 10, tickPosIdx: 10 });
    vi.useFakeTimers();
    try {
      renderLive(2, liveClock("SECOND_HALF", HALF_REAL_MS / 2));
      viewer.setSpeed.mockClear(); // 마운트 시 1 로 초기화하는 건 정상 — 그 뒤 폴링만 본다
      act(() => {
        vi.advanceTimersByTime(300); // 게이트 폴링 1회(250ms)
      });
    } finally {
      vi.useRealTimers();
    }
    const speeds = viewer.setSpeed.mock.calls.map((c) => c[0] as number);
    expect(speeds, `폴링이 배율을 건 흔적: ${JSON.stringify(speeds)}`).toEqual([]);
  });

  it("앞서 있어도 배율을 건드리지 않고, 되감아 회수하지도 않는다(고무줄 금지)", () => {
    fx.log = h2Log;
    // 창 50% · 재생 58% = 드리프트 허용(12%) 안쪽 → 아무것도 하지 않는다.
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 58, tickPosIdx: 58 });
    vi.useFakeTimers();
    try {
      renderLive(2, liveClock("SECOND_HALF", HALF_REAL_MS / 2));
      viewer.jumpToTick.mockClear(); // 마운트 시 seek-to-now 는 정상 — 그 뒤만 본다
      viewer.setSpeed.mockClear();
      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }
    expect(viewer.setSpeed.mock.calls.map((c) => c[0] as number)).toEqual([]);
    expect(viewer.jumpToTick, "허용 범위 안의 앞섬은 회수하지 않는다").not.toHaveBeenCalled();
  });

  it("허용 범위를 크게 넘는 앞섬(의도적 점프)은 상한으로 회수한다", () => {
    fx.log = h2Log;
    // 창 50% · 재생 95% = 스크럽으로 뛴 것 → 앞서보기 차단(AC-W3-1).
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK + 95, tickPosIdx: 95 });
    vi.useFakeTimers();
    try {
      renderLive(2, liveClock("SECOND_HALF", HALF_REAL_MS / 2));
      viewer.jumpToTick.mockClear();
      act(() => {
        vi.advanceTimersByTime(300);
      });
    } finally {
      vi.useRealTimers();
    }
    const target = viewer.jumpToTick.mock.calls.at(-1)?.[0] as number | undefined;
    expect(target, "상한(=지금)으로 되돌려야 한다").toBeDefined();
    expect(target!).toBeLessThan(H2_FIRST_TICK + 60);
  });

  it("라이브가 아닌 하프(지나간 전반)는 점프도 배율도 걸지 않는다 — 다시보기는 자유", () => {
    fx.log = h2Log;
    viewer.hooks.cur = () => ({ tick: H2_FIRST_TICK, tickPosIdx: 0 });
    renderLive(1, liveClock("SECOND_HALF", 10_000)); // 후반 라이브 중의 전반 화면
    expect(viewer.jumpToTick).not.toHaveBeenCalled();
    expect(viewer.setSpeed).toHaveBeenLastCalledWith(1);
  });
});

/*
 * #285 — 아이콘 노출 정책이 **화면을 죽이지 않는다**.
 *
 * 정책은 `/api/players`(전 카탈로그)에서 playerId→등급 표를 만들어 캔버스에 넘긴다. 그런데 이
 * 엔드포인트가 없는 구 서버·목은 200 `{}` 를 준다 — 배열을 가정하고 `.map` 을 부르면 렌더가
 * 던져 **결과 화면이 통째로 흰 화면**이 된다(apps/web CLAUDE.md "응답 형태를 믿지 않는다").
 *
 * ⚠️ 이 계약이 없던 동안 `Array.isArray` 가드를 지워도 **유닛 1264개가 전부 통과했다**
 * (독립검증이 변이체로 잡았다). 부가 기능이 앱 화면을 죽이는 회귀는 여기서 막는다.
 */
describe("#285 등급표 — 손상된 카탈로그 응답에 화면이 죽지 않는다", () => {
  const BROKEN: unknown[] = [{}, null, undefined, "nope", 42, { players: [] }];

  for (const bad of BROKEN) {
    it(`${JSON.stringify(bad) ?? "undefined"} 를 받아도 뷰어가 렌더된다`, () => {
      fx.players = bad;
      expect(() => renderViewer(false)).not.toThrow();
      expect(screen.getByTestId("match-viewer-half1")).toBeTruthy();
      fx.players = [];
    });
  }

  it("정상 배열도 그대로 렌더된다 — 가드가 기능 경로를 막지 않는다", () => {
    // 등급표가 실제로 정책을 거는지(= 골드에 셀이 없다)는 `viewer-skins.test.ts` 와
    // `e2e/p285-icon-policy.spec.ts` 가 진다. 여기서 지키는 건 **가드의 양방향**뿐이다:
    // 손상 응답에 안 죽고, 정상 응답을 막지도 않는다.
    fx.players = [{ id: "P001", grade: "LEGEND" }, { id: "P038", grade: "GOLD" }];
    expect(() => renderViewer(false)).not.toThrow();
    expect(screen.getByTestId("match-viewer-half1")).toBeTruthy();
    fx.players = [];
  });
});
