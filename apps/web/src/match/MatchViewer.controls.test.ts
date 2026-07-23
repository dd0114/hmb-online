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
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
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
  for (const fn of [viewer.setAutoPace, viewer.setSpeed, viewer.load, viewer.start]) fn.mockClear();
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
