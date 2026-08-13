// @vitest-environment jsdom
/**
 * #493 W2 AC4 — GuideProvider 진행 계약: 래치 게이트 · 발화 · seen 저장 · 온보딩 양보 ·
 * 대상 부재 무저장 · 다시 보기 · 팝업 홀드 신호(useGuide().active).
 *
 * 하네스는 tutorial-flow.test.ts 관용구 그대로 — useMe/useToken wholesale mock, rect 주입,
 * createElement(루트 vitest include 가 .test.ts 라 JSX 불가), 유예 0.
 */
import { createElement as h } from "react";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ScreenGuide } from "./guide-steps";
import { TutorialContext } from "./tutorial-context";
import type { TutorialControls } from "./tutorial-context";

const fx = {
  token: "t" as string | null,
  user: { id: "u1" } as { id: string } | undefined,
};

vi.mock("../api/hooks", () => ({
  useMe: () => ({ data: { user: fx.user, wallet: { points: 0 }, records: {} } }),
}));

vi.mock("../auth/TokenContext", () => ({
  useToken: () => ({ token: fx.token, provider: null, login: vi.fn(), logout: vi.fn() }),
}));

const { GuideProvider } = await import("./GuideProvider");
const { useGuide } = await import("./guide-context");
const { guidePending, markGuidePending, markGuideSeen, readGuideSeen } = await import("./guide-storage");

const rects: Record<string, { left: number; top: number; width: number; height: number }> = {};

function stubRects() {
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockImplementation(function (this: Element) {
    const id = this.getAttribute("data-testid") ?? "";
    const r = rects[id] ?? { left: 0, top: 0, width: 0, height: 0 };
    return { ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => r } as DOMRect;
  });
}

const GUIDES: ScreenGuide[] = [
  {
    screen: "/game",
    steps: [
      { id: "g1", targetTestId: "t1", title: "하나", body: "b1", enabled: true },
      { id: "g2", targetTestId: "t2", title: "둘", body: "b2", enabled: true },
    ],
  },
  {
    screen: "/league",
    steps: [
      { id: "l1", targetTestId: "league-a", title: "리그A", body: "b", enabled: true },
      { id: "l2", targetTestId: "league-b", title: "리그B", body: "b", enabled: true },
    ],
  },
];

function Nav() {
  const navigate = useNavigate();
  return h(
    "div",
    null,
    h("button", { "data-testid": "nav-game", onClick: () => navigate("/game") }, "game"),
    h("button", { "data-testid": "nav-me", onClick: () => navigate("/me") }, "me"),
  );
}

/** useGuide().active 를 DOM 으로 노출 — 팝업 홀드(#386)가 소비하는 신호의 관측 지점. */
function ActiveProbe() {
  const { active } = useGuide();
  return h("span", { "data-testid": "guide-active" }, active ? "on" : "off");
}

function ReplayButton() {
  const { replay } = useGuide();
  return h("button", { "data-testid": "do-replay", onClick: replay }, "replay");
}

function tree(opts: { tutorial?: Partial<TutorialControls>; initial?: string } = {}) {
  const tut: TutorialControls = {
    active: false,
    restart: () => {},
    startDeckSetup: () => {},
    ...opts.tutorial,
  };
  return h(
    MemoryRouter,
    { initialEntries: [opts.initial ?? "/game"] },
    h(
      TutorialContext.Provider,
      { value: tut },
      h(
        GuideProvider,
        { guides: GUIDES, missingGraceMs: 0 },
        h("button", { "data-testid": "t1" }, "target1"),
        h("button", { "data-testid": "t2" }, "target2"),
        // 리그 대상 — DOM 에는 항상 있고 "존재/부재"는 rect(크기 0 = 부재)로 표현한다.
        h("button", { "data-testid": "league-a" }, "leagueA"),
        h("button", { "data-testid": "league-b" }, "leagueB"),
        h(Nav),
        h(ActiveProbe),
        h(ReplayButton),
      ),
    ),
  );
}

beforeEach(() => {
  window.localStorage.clear();
  stubRects();
  rects.t1 = { left: 10, top: 10, width: 100, height: 40 };
  rects.t2 = { left: 10, top: 120, width: 100, height: 40 };
  delete rects["league-a"];
  delete rects["league-b"];
  fx.user = { id: "u1" };
  fx.token = "t";
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const overlay = () => screen.queryByTestId("tutorial-overlay");

describe("#493 W2 — GuideProvider", () => {
  it("pending 래치 없이는 발화하지 않는다(기존 유저·목 유저 보호)", () => {
    render(tree());
    expect(overlay()).toBeNull();
    expect(screen.getByTestId("guide-active").textContent).toBe("off");
  });

  it("래치 + 미시청 → 발화 · 자기 진행표시 · 완주 시 화면 seen + 재진입 무노출", () => {
    markGuidePending("u1");
    render(tree());
    expect(overlay()).not.toBeNull();
    // 진행 표시는 가이드 자신의 것(2스텝) — 온보딩의 7 이 아니다(분리 프로바이더의 핵심).
    expect(screen.getByTestId("tutorial-progress").textContent).toContain("1 / 2");
    expect(screen.getByTestId("guide-active").textContent).toBe("on");

    fireEvent.click(screen.getByTestId("tutorial-next")); // g1 → g2
    expect(screen.getByTestId("tutorial-progress").textContent).toContain("2 / 2");
    expect(screen.getByTestId("tutorial-next").textContent).toBe("확인"); // 마지막 라벨(가이드판)
    fireEvent.click(screen.getByTestId("tutorial-next")); // 종료

    expect(overlay()).toBeNull();
    expect(readGuideSeen("u1").has("/game")).toBe(true);
    // pending 래치는 남는다(다른 화면 가이드가 계속 떠야 한다).
    expect(guidePending("u1")).toBe(true);

    // 재진입 — seen 이라 다시 안 뜬다.
    fireEvent.click(screen.getByTestId("nav-me"));
    fireEvent.click(screen.getByTestId("nav-game"));
    expect(overlay()).toBeNull();
  });

  it("건너뛰기 = 그 화면 seen(다시 조르지 않는다)", () => {
    markGuidePending("u1");
    render(tree());
    fireEvent.click(screen.getByTestId("tutorial-skip"));
    expect(overlay()).toBeNull();
    expect(readGuideSeen("u1").has("/game")).toBe(true);
  });

  it("가이드 도중 다른 화면으로 이탈 = 유저 행동 → seen", () => {
    markGuidePending("u1");
    render(tree());
    expect(overlay()).not.toBeNull();
    fireEvent.click(screen.getByTestId("nav-me"));
    expect(overlay()).toBeNull();
    expect(readGuideSeen("u1").has("/game")).toBe(true);
  });

  it("온보딩 코치마크가 도는 동안은 발화하지 않는다(두 오버레이 불공존)", () => {
    markGuidePending("u1");
    const { rerender } = render(tree({ tutorial: { active: true } }));
    expect(overlay()).toBeNull();
    // 온보딩이 내려가면 그때 발화한다.
    rerender(tree({ tutorial: { active: false } }));
    expect(overlay()).not.toBeNull();
  });

  it("대상 부재로만 끝난 가이드는 seen 을 찍지 않는다 — 상태가 바뀐 재진입에서 다시 시도", async () => {
    markGuidePending("u1");
    render(tree({ initial: "/league" })); // league-a/b rect 없음 = 전부 스킵
    // 유예 0 이라도 rAF 한 프레임은 돈다 — 오버레이가 스스로 내려갈 때까지 기다린다.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(overlay()).toBeNull();
    expect(readGuideSeen("u1").has("/league")).toBe(false);

    // 화면 상태가 바뀌어 대상이 생겼다(시즌 시작 버튼 등) → 재진입에서 다시 뜬다.
    rects["league-a"] = { left: 10, top: 10, width: 80, height: 30 };
    fireEvent.click(screen.getByTestId("nav-game")); // /game 은 이미 안 봤으니 뜨지만, 여기선 이탈용
    fireEvent.click(screen.getByTestId("tutorial-skip")); // /game seen 처리
    // MemoryRouter 라 /league 재진입 버튼이 없다 — 새 트리로 재현.
    cleanup();
    render(tree({ initial: "/league" }));
    expect(overlay()).not.toBeNull();
  });

  it("다시 보기(replay) = 이 계정의 seen 만 비운다 → 현재 화면에서 즉시 재발화", () => {
    markGuidePending("u1");
    markGuideSeen("u1", "/game");
    markGuideSeen("u2", "/game"); // 남의 계정
    render(tree());
    expect(overlay()).toBeNull();

    fireEvent.click(screen.getByTestId("do-replay"));
    expect(overlay()).not.toBeNull();
    expect(readGuideSeen("u2").has("/game")).toBe(true); // 격리
  });

  it("userId 를 모르면(익명·me 미도착) 발화하지 않는다", () => {
    fx.user = undefined;
    markGuidePending("u1");
    render(tree());
    expect(overlay()).toBeNull();
  });
});
