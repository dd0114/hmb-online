// @vitest-environment jsdom
/**
 * 매치 화면 재생 컨트롤 계약 (#148). hero: "게임 진행이 아니라 녹화본 보는 느낌" →
 *  - 플레이 모드(일반 유저): 재생/일시정지 + 배속 몇 단계뿐. 되감기·프레임점프·스크럽 없음.
 *  - admin/QA 모드: 뷰어 풀컨트롤(iframe 내부) 노출 + 모드 전환 토글.
 * iframe 안 뷰어는 무수정 — 컨트롤은 postMessage 명령으로만 몬다.
 *
 * root vitest include 가 apps/**\/*.test.ts 라 JSX 대신 createElement 사용.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AdminFlagContext } from "../admin/admin-flag";
import { CONTROL_MODE_STORAGE_KEY } from "./playback-controls";

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

function iframeEl(): HTMLIFrameElement {
  return screen.getByTitle("전반 경기 재생") as HTMLIFrameElement;
}

/** iframe → parent viewerReady 를 흉내내고, 그 뒤 부모가 보낸 메시지를 수집한다. */
function readyAndSpy(): { posted: unknown[] } {
  const iframe = iframeEl();
  const win = iframe.contentWindow!;
  const posted: unknown[] = [];
  vi.spyOn(win, "postMessage").mockImplementation((msg: unknown) => {
    posted.push(msg);
  });
  act(() => {
    window.dispatchEvent(new MessageEvent("message", { data: { type: "viewerReady" }, source: win }));
  });
  return { posted };
}

function sendViewerState(playing: boolean, speed: number, ended = false, auto = false) {
  const win = iframeEl().contentWindow!;
  act(() => {
    window.dispatchEvent(
      new MessageEvent("message", { data: { type: "viewerState", playing, speed, ended, auto }, source: win }),
    );
  });
}

function chromeModes(posted: unknown[]): string[] {
  return posted
    .filter((m): m is { type: string; mode: string } => (m as { type?: string })?.type === "setViewerChrome")
    .map((m) => m.mode);
}

beforeEach(() => {
  window.history.replaceState({}, "", "/match/m1");
  window.localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("MatchViewer 컨트롤 — 플레이 모드(일반 유저)", () => {
  it("간소 컨트롤만: 재생/일시정지 + 페이스 단계(하이라이트·1·2·4x)", () => {
    renderViewer(false);
    expect(screen.getByTestId("viewer-play-toggle-half1")).toBeTruthy();
    expect(screen.getByTestId("viewer-pace-auto-half1")).toBeTruthy();
    for (const s of [1, 2, 4]) expect(screen.getByTestId(`viewer-speed-${s}-half1`)).toBeTruthy();
  });

  it("되감기·프레임점프·스크럽·모드토글은 노출하지 않는다", () => {
    renderViewer(false);
    expect(screen.queryByTestId("viewer-scrub-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-rewind-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-mode-toggle-half1")).toBeNull();
    // 슬로우 배속(0.25/0.5)도 플레이 모드엔 없다.
    expect(screen.queryByTestId("viewer-speed-0.25-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-speed-0.5-half1")).toBeNull();
  });

  it("뷰어에 play 크롬을 지시한다(iframe 내부 디버그 컨트롤 숨김)", () => {
    renderViewer(false);
    const { posted } = readyAndSpy();
    expect(chromeModes(posted)).toContain("play");
    expect(chromeModes(posted)).not.toContain("full");
  });

  it("재생 버튼은 toggle 명령을, 배속 칩은 화이트리스트 배속 명령을 보낸다", () => {
    renderViewer(false);
    const { posted } = readyAndSpy();
    fireEvent.click(screen.getByTestId("viewer-play-toggle-half1"));
    fireEvent.click(screen.getByTestId("viewer-speed-2-half1"));
    fireEvent.click(screen.getByTestId("viewer-pace-auto-half1"));
    expect(posted).toContainEqual({ type: "viewerControl", cmd: "toggle" });
    expect(posted).toContainEqual({ type: "viewerControl", cmd: "speed", speed: 2 });
    expect(posted).toContainEqual({ type: "viewerControl", cmd: "auto" });
  });

  it("버튼 라벨/활성 배속은 뷰어가 미러링한 실제 상태를 따른다", () => {
    renderViewer(false);
    readyAndSpy();
    const toggle = screen.getByTestId("viewer-play-toggle-half1");
    expect(toggle.textContent).toContain("재생");
    sendViewerState(true, 4);
    expect(toggle.textContent).toContain("일시정지");
    expect(screen.getByTestId("viewer-speed-4-half1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("viewer-speed-1-half1").getAttribute("aria-pressed")).toBe("false");
    // 자동페이싱 중이면 배속은 뷰어가 무시하므로 어떤 배속 칩도 활성으로 표시하지 않는다.
    sendViewerState(true, 4, false, true);
    expect(screen.getByTestId("viewer-pace-auto-half1").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByTestId("viewer-speed-4-half1").getAttribute("aria-pressed")).toBe("false");
    // 끝까지 재생되면 "다시 보기"(되감기 버튼 대신 — 스크럽 없이도 복귀 가능).
    sendViewerState(false, 4, true);
    expect(toggle.textContent).toContain("다시 보기");
  });
});

describe("MatchViewer 컨트롤 — admin/QA 모드", () => {
  it("admin 계정(#119)은 뷰어 풀컨트롤 + 모드 전환 토글", () => {
    renderViewer(true);
    const { posted } = readyAndSpy();
    expect(chromeModes(posted)).toContain("full");
    expect(screen.getByTestId("viewer-mode-toggle-half1")).toBeTruthy();
    // 풀컨트롤에선 web 간소 바를 중복 노출하지 않는다(뷰어 내부 컨트롤 사용).
    expect(screen.queryByTestId("viewer-play-toggle-half1")).toBeNull();
  });

  it("QA 플래그(?viewerControls=full)면 비admin 도 풀컨트롤", () => {
    window.history.replaceState({}, "", "/match/m1?viewerControls=full");
    renderViewer(false);
    const { posted } = readyAndSpy();
    expect(chromeModes(posted)).toContain("full");
  });

  it("모드 토글로 플레이어 체감(간소)으로 전환 — 뷰어에 play 크롬을 다시 지시하고 저장한다", () => {
    renderViewer(true);
    const { posted } = readyAndSpy();
    fireEvent.click(screen.getByTestId("viewer-mode-play-half1"));
    expect(chromeModes(posted).at(-1)).toBe("play");
    expect(screen.getByTestId("viewer-play-toggle-half1")).toBeTruthy();
    expect(window.localStorage.getItem(CONTROL_MODE_STORAGE_KEY)).toBe("play");
  });
});
