// @vitest-environment jsdom
/**
 * 매치 화면 재생 컨트롤 계약 (#148, #169 S3 직접 마운트). hero 재지시: "매치 재생은 그냥 자동
 * 진행, 유일한 컨트롤은 하이라이트 껐다 켜기 하나" →
 *  - 플레이 모드(일반 유저): **하이라이트 토글 하나뿐**. 토글은 코어 autoPace 를 직접 끈다/켠다.
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
    seek: vi.fn(),
    scrubTo: vi.fn(),
    hooks,
  };
});
const createViewer = vi.hoisted(() => vi.fn(() => viewer));
vi.mock("@hmb/viewer-core", () => ({ createViewer }));

const fx = {
  log: { tickSnapshots: [], events: [], finalScore: { home: 0, away: 0 } } as unknown,
};
vi.mock("../api/hooks", () => ({
  useHalfLog: () => ({ data: fx.log, isLoading: false, isError: false }),
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
  for (const fn of [viewer.setAutoPace, viewer.setSpeed, viewer.load, viewer.start, viewer.seek, viewer.scrubTo, viewer.jumpToTick]) fn.mockClear();
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

  it("컨트롤은 하이라이트 토글 하나뿐이다", () => {
    renderViewer(false);
    expect(screen.getByTestId("viewer-highlight-toggle-half1")).toBeTruthy();
    // 경기는 자동 진행 — 재생/일시정지·배속·스크럽·프레임점프·모드토글은 아예 없다.
    expect(screen.queryByTestId("viewer-play-toggle-half1")).toBeNull();
    for (const s of [1, 2, 4]) expect(screen.queryByTestId(`viewer-speed-${s}-half1`)).toBeNull();
    expect(screen.queryByTestId("viewer-scrub-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-prev-goal-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-mode-toggle-half1")).toBeNull();
    const buttons = screen.getByTestId("viewer-controls-half1").querySelectorAll("button");
    expect(buttons.length, "플레이 모드 컨트롤 바의 버튼은 하이라이트 토글 하나뿐").toBe(1);
  });

  it("하이라이트 토글이 코어 autoPace 를 직접 끄고 켠다 + 표시도 따라간다", () => {
    renderViewer(false);
    const toggle = screen.getByTestId("viewer-highlight-toggle-half1");
    // 기본 on.
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toContain("켜짐");

    fireEvent.click(toggle); // on → off
    expect(viewer.setAutoPace).toHaveBeenLastCalledWith(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toContain("꺼짐");

    fireEvent.click(toggle); // off → on
    expect(viewer.setAutoPace).toHaveBeenLastCalledWith(true);
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
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
    // 풀컨트롤에선 간소 하이라이트 토글을 중복 노출하지 않는다.
    expect(screen.queryByTestId("viewer-highlight-toggle-half1")).toBeNull();
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

  it("모드 토글로 플레이어 체감(간소)으로 전환 — 하이라이트 토글이 나오고 저장한다", () => {
    renderViewer(true);
    fireEvent.click(screen.getByTestId("viewer-mode-play-half1"));
    expect(screen.getByTestId("viewer-highlight-toggle-half1")).toBeTruthy();
    expect(screen.queryByTestId("viewer-scrub-half1")).toBeNull();
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
   * 코어 계약(viewer.impl.mjs tickLoop): `eff = autoPace ? (HL_SPEED|CRUISE_SPEED) : speed`.
   * 즉 **하이라이트 연출이 켜져 있으면 배속 설정이 통째로 무시된다** — 배속 칩이 거짓말이 된다.
   * QA 모드에서 배속을 고른다는 건 "내가 속도를 잡겠다"는 뜻이므로 연출 페이싱을 끈다.
   */
  it("배속을 고르면 연출 자동페이싱을 끈다(안 끄면 배속이 무시된다)", () => {
    renderViewer(true);
    fireEvent.click(screen.getByTestId("viewer-speed-0.25-half1"));
    expect(viewer.setAutoPace).toHaveBeenLastCalledWith(false);
    expect(viewer.setSpeed).toHaveBeenLastCalledWith(0.25);
  });

  it("QA 바에서 연출 페이싱을 다시 켤 수 있다", () => {
    renderViewer(true);
    const toggle = screen.getByTestId("viewer-highlight-admin-half1");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(toggle);
    expect(viewer.setAutoPace).toHaveBeenLastCalledWith(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(toggle);
    expect(viewer.setAutoPace).toHaveBeenLastCalledWith(true);
  });
});
