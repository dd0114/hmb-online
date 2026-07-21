// @vitest-environment jsdom
/**
 * 매치 화면 재생 컨트롤 계약 (#148). hero 재지시: "매치 재생은 그냥 자동 진행, 유일한 컨트롤은
 * 하이라이트 껐다 켜기 하나" →
 *  - 플레이 모드(일반 유저): **하이라이트 토글 하나뿐**. 재생/일시정지·배속·되감기·스크럽 없음.
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

function sendViewerState(auto: boolean, playing = true, speed = 4, ended = false) {
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
  it("컨트롤은 하이라이트 토글 하나뿐이다", () => {
    renderViewer(false);
    expect(screen.getByTestId("viewer-highlight-toggle-half1")).toBeTruthy();
    // 경기는 자동 진행 — 재생/일시정지·배속 칩은 아예 없다.
    expect(screen.queryByTestId("viewer-play-toggle-half1")).toBeNull();
    for (const s of [1, 2, 4]) expect(screen.queryByTestId(`viewer-speed-${s}-half1`)).toBeNull();
    expect(screen.queryByTestId("viewer-pace-auto-half1")).toBeNull();
  });

  it("되감기·프레임점프·스크럽·모드토글은 노출하지 않는다", () => {
    renderViewer(false);
    expect(screen.queryByTestId("viewer-scrub-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-rewind-half1")).toBeNull();
    expect(screen.queryByTestId("viewer-mode-toggle-half1")).toBeNull();
  });

  it("뷰어에 play 크롬을 지시한다(iframe 내부 디버그 컨트롤 숨김)", () => {
    renderViewer(false);
    const { posted } = readyAndSpy();
    expect(chromeModes(posted)).toContain("play");
    expect(chromeModes(posted)).not.toContain("full");
  });

  it("토글은 현재 상태의 반대를 하이라이트 명령으로 보낸다", () => {
    renderViewer(false);
    const { posted } = readyAndSpy();
    const toggle = screen.getByTestId("viewer-highlight-toggle-half1");
    fireEvent.click(toggle); // 기본 on → off 요청
    expect(posted).toContainEqual({ type: "viewerControl", cmd: "highlight", on: false });
    sendViewerState(false); // 뷰어가 off 를 미러링
    fireEvent.click(toggle); // 이제 on 요청
    expect(posted).toContainEqual({ type: "viewerControl", cmd: "highlight", on: true });
  });

  it("토글 표시는 뷰어가 미러링한 실제 상태를 따른다(낙관적 표시 금지)", () => {
    renderViewer(false);
    readyAndSpy();
    const toggle = screen.getByTestId("viewer-highlight-toggle-half1");
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.textContent).toContain("켜짐");
    sendViewerState(false);
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.textContent).toContain("꺼짐");
  });
});

describe("MatchViewer 컨트롤 — admin/QA 모드", () => {
  it("admin 계정(#119)은 뷰어 풀컨트롤 + 모드 전환 토글", () => {
    renderViewer(true);
    const { posted } = readyAndSpy();
    expect(chromeModes(posted)).toContain("full");
    expect(screen.getByTestId("viewer-mode-toggle-half1")).toBeTruthy();
    // 풀컨트롤에선 web 바를 중복 노출하지 않는다(뷰어 내부 컨트롤 사용).
    expect(screen.queryByTestId("viewer-highlight-toggle-half1")).toBeNull();
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
    expect(screen.getByTestId("viewer-highlight-toggle-half1")).toBeTruthy();
    expect(window.localStorage.getItem(CONTROL_MODE_STORAGE_KEY)).toBe("play");
  });
});
